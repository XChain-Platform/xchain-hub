'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const EventEmitter   = require('events');

const LICENSE_HEADER = ''; // Only needed for file comment; tests use it below

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeIdentity(pubkey) {
    return { getPubkeyHex: () => pubkey || 'aa'.repeat(32) };
}

function makePeerManager() {
    let pm = new EventEmitter();
    pm.broadcast  = sinon.stub();
    pm.sendToPeer = sinon.stub();
    return pm;
}

function makeHub(overrides) {
    let pm = makePeerManager();
    let hub = {
        db:               { doQuery: sinon.stub().resolves([]) },
        p2pConfig:        overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getPeerManager:   () => pm,
        getIdentity:      () => makeIdentity(),
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        _resolveBtcIndexerUrl: overrides && overrides._resolveBtcIndexerUrl
            ? overrides._resolveBtcIndexerUrl
            : sinon.stub().resolves(null),
        _btcIndexerHeaders: () => ({})
    };
    hub._peerManager = pm;
    return hub;
}

function makeProviderRegistry(overrides) {
    return {
        isKnown:   sinon.stub().returns(true),
        getModule: sinon.stub().returns({ fetch: sinon.stub().resolves({ body: 'data', meta: '200' }) }),
        getDef:    sinon.stub().returns({ max_response_bytes: 32768 }),
        ...(overrides || {})
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Load AttestationRound (stub axios)
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let AttestationRound;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    AttestationRound = proxyquire('../../src/AttestationRound', { axios: axiosStub });
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('AttestationRound', function () {

    beforeEach(function () {
        loadModule();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── Construction ────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('initialises rounds and seen as empty Maps', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.rounds).to.be.instanceOf(Map);
            expect(ar.seen).to.be.instanceOf(Map);
            expect(ar.rounds.size).to.equal(0);
            expect(ar.seen.size).to.equal(0);
        });

        it('reads ATTESTATION_POLL_MS from config', function () {
            let hub = makeHub({ p2pConfig: { ATTESTATION_POLL_MS: '5000' } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.pollMs).to.equal(5000);
        });

        it('reads ATTESTATION_CONFIRMATIONS from config', function () {
            let hub = makeHub({ p2pConfig: { ATTESTATION_CONFIRMATIONS: '6', ORACLE_EPOCH_START: '0' } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.confirmations).to.equal(6);
        });

        it('falls back to defaults when config is empty', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.pollMs).to.equal(15000);
            expect(ar.confirmations).to.equal(3);
        });

        it('sets identity to null when hub has no getIdentity', function () {
            let hub = makeHub();
            hub.getIdentity = undefined;
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.identity).to.be.null;
        });
    });

    // ── setConsensus / getRoundState ────────────────────────────────────────

    describe('setConsensus / getRoundState', function () {
        it('setConsensus stores the consensus reference', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let fake = { propose: sinon.stub() };
            ar.setConsensus(fake);
            expect(ar.consensus).to.equal(fake);
        });

        it('getRoundState returns null for unknown requestId', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.getRoundState('nonexistent')).to.be.null;
        });

        it('getRoundState is case-insensitive', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.rounds.set('abcd1234', { role: 'leader' });
            expect(ar.getRoundState('ABCD1234')).to.deep.equal({ role: 'leader' });
        });
    });

    // ── stop ────────────────────────────────────────────────────────────────

    describe('stop()', function () {
        it('clears rounds and seen maps', async function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.rounds.set('rid1', { role: 'leader' });
            ar.seen.set('rid1', Date.now());
            await ar.stop();
            expect(ar.rounds.size).to.equal(0);
            expect(ar.seen.size).to.equal(0);
        });

        it('resets pollCursor to null', async function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.pollCursor = { block_index: 10, action_index: 5 };
            await ar.stop();
            expect(ar.pollCursor).to.be.null;
        });

        it('clears the poll timer', async function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar._pollTimer = setTimeout(() => {}, 100000);
            await ar.stop();
            expect(ar._pollTimer).to.be.null;
        });
    });

    // ── start ────────────────────────────────────────────────────────────────

    describe('start()', function () {
        it('skips start when there is no peer manager', async function () {
            let hub = makeHub();
            hub.getPeerManager = () => null;
            let ar = new AttestationRound(hub, makeProviderRegistry());
            // Should not throw
            await ar.start();
            expect(ar._pollTimer).to.be.null;
        });
    });

    // ── _evictStaleSeen ──────────────────────────────────────────────────────

    describe('_evictStaleSeen()', function () {
        it('removes entries older than retryAfterMs', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let old  = Date.now() - ar.retryAfterMs - 1;
            let fresh = Date.now();
            ar.seen.set('rid1', old);
            ar.seen.set('rid2', fresh);
            ar._evictStaleSeen();
            expect(ar.seen.has('rid1')).to.be.false;
            expect(ar.seen.has('rid2')).to.be.true;
        });

        it('does not remove entries still within the window', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.seen.set('rid1', Date.now());
            ar._evictStaleSeen();
            expect(ar.seen.has('rid1')).to.be.true;
        });
    });

    // ── _evictStaleRounds ────────────────────────────────────────────────────

    describe('_evictStaleRounds()', function () {
        it('removes rounds whose proposedAt is past the TTL', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let old  = Date.now() - ar.roundsTtlMs - 1;
            ar.rounds.set('rid1', { proposedAt: old });
            ar.rounds.set('rid2', { proposedAt: Date.now() });
            ar._evictStaleRounds();
            expect(ar.rounds.has('rid1')).to.be.false;
            expect(ar.rounds.has('rid2')).to.be.true;
        });

        it('keeps rounds without a numeric proposedAt', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.rounds.set('rid1', {}); // no proposedAt
            ar._evictStaleRounds();
            expect(ar.rounds.has('rid1')).to.be.true;
        });
    });

    // ── _computeResponsibleSet ───────────────────────────────────────────────

    describe('_computeResponsibleSet()', function () {
        it('returns a deterministic ordered list of the correct size', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [
                { pubkey: 'pub1' }, { pubkey: 'pub2' }, { pubkey: 'pub3' }
            ];
            let result = ar._computeResponsibleSet(validators, 'requestid123', 2);
            expect(result).to.have.length(2);
            // Each entry has pubkey and hash
            for (let v of result) {
                expect(v).to.have.property('pubkey');
                expect(v).to.have.property('hash');
            }
        });

        it('returns only 1 entry when redundancy=1', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [{ pubkey: 'pub1' }, { pubkey: 'pub2' }, { pubkey: 'pub3' }];
            let result = ar._computeResponsibleSet(validators, 'rid', 1);
            expect(result).to.have.length(1);
        });

        it('returns all when redundancy >= validators.length', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [{ pubkey: 'pub1' }, { pubkey: 'pub2' }];
            let result = ar._computeResponsibleSet(validators, 'rid', 10);
            expect(result).to.have.length(2);
        });

        it('produces consistent ordering across calls (deterministic)', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [
                { pubkey: 'aaa' }, { pubkey: 'bbb' }, { pubkey: 'ccc' }
            ];
            let r1 = ar._computeResponsibleSet(validators, 'fixedrid', 3);
            let r2 = ar._computeResponsibleSet(validators, 'fixedrid', 3);
            expect(r1.map(v => v.pubkey)).to.deep.equal(r2.map(v => v.pubkey));
        });

        it('normalises pubkeys to lowercase', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let result = ar._computeResponsibleSet([{ pubkey: 'AABBCC' }], 'rid', 1);
            expect(result[0].pubkey).to.equal('aabbcc');
        });
    });

    // ── getStats ────────────────────────────────────────────────────────────

    describe('getStats()', function () {
        it('returns zeroed counters when nothing has been seen', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let stats = ar.getStats();
            expect(stats.seen_count).to.equal(0);
            expect(stats.proposed_count).to.equal(0);
            expect(stats.failed_count).to.equal(0);
        });

        it('counts proposed vs failed rounds correctly', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.rounds.set('ok1',   { role: 'leader', proposedAt: Date.now() });
            ar.rounds.set('ok2',   { role: 'follower', proposedAt: Date.now() });
            ar.rounds.set('fail1', { role: 'leader', error: 'timeout', proposedAt: Date.now() });
            ar.seen.set('ok1', Date.now());
            ar.seen.set('ok2', Date.now());
            ar.seen.set('fail1', Date.now());
            let stats = ar.getStats();
            expect(stats.proposed_count).to.equal(2);
            expect(stats.failed_count).to.equal(1);
            expect(stats.seen_count).to.equal(3);
        });
    });

    // ── _pollPending ─────────────────────────────────────────────────────────

    describe('_pollPending()', function () {

        it('returns immediately when identity is null', async function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.identity = null;
            await ar._pollPending();  // should not throw
            expect(axiosStub.post.called).to.be.false;
        });

        it('returns immediately when no BTC indexer URL is available', async function () {
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves(null) });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar._pollPending();
            expect(axiosStub.post.called).to.be.false;
        });

        it('returns on axios error without throwing', async function () {
            axiosStub.post.rejects(new Error('network error'));
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar._pollPending();  // should not throw
        });

        it('returns when response has no result', async function () {
            axiosStub.post.resolves({ data: { result: null } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar._pollPending();
            expect(ar.seen.size).to.equal(0);
        });

        it('skips requests that are already in seen map', async function () {
            axiosStub.post.resolves({
                data: {
                    result: {
                        latest_block_index: 100,
                        requests: [{ request_id: 'RID1', block_index: 90, action_index: 1 }]
                    }
                }
            });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.seen.set('rid1', Date.now()); // already seen
            let _startRoundSpy = sinon.spy(ar, '_startRound');
            await ar._pollPending();
            expect(_startRoundSpy.called).to.be.false;
        });

        it('skips unconfirmed requests (block too recent)', async function () {
            axiosStub.post.resolves({
                data: {
                    result: {
                        latest_block_index: 100,
                        requests: [
                            // block_index 99 + confirmations(3) > 100 → skip
                            { request_id: 'rid_unconfirmed', block_index: 99, action_index: 1 }
                        ]
                    }
                }
            });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let spy = sinon.spy(ar, '_startRound');
            await ar._pollPending();
            expect(spy.called).to.be.false;
        });

        it('advances and resets cursor correctly', async function () {
            // First call: full page (POLL_LIMIT = 100 items) → cursor advances
            let requests = [];
            for (let i = 0; i < 100; i++) {
                requests.push({ request_id: 'r' + i, block_index: 50, action_index: i });
            }
            axiosStub.post.resolves({
                data: { result: { latest_block_index: 200, requests } }
            });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            // Stub _startRound to avoid execution
            sinon.stub(ar, '_startRound').resolves();
            await ar._pollPending();
            // Full page → cursor set to last item's coords
            expect(ar.pollCursor).to.deep.equal({ block_index: 50, action_index: 99 });
        });

        it('resets cursor to null on short page (< POLL_LIMIT)', async function () {
            axiosStub.post.resolves({
                data: { result: { latest_block_index: 200, requests: [{ request_id: 'only1', block_index: 50, action_index: 0 }] } }
            });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.pollCursor = { block_index: 40, action_index: 0 };
            sinon.stub(ar, '_startRound').resolves();
            await ar._pollPending();
            // Short page → cursor reset to null
            expect(ar.pollCursor).to.be.null;
        });
    });

    // ── _startRound ───────────────────────────────────────────────────────────

    describe('_startRound()', function () {

        function makeRequest(overrides) {
            return {
                request_id:   'rid0001',
                provider_id:  'http_get',
                redundancy:   1,
                block_index:  100,
                action_index: 1,
                payload:      'https://example.com/',
                ...overrides
            };
        }

        it('skips when provider is unknown', async function () {
            let hub = makeHub();
            let reg = makeProviderRegistry({ isKnown: sinon.stub().returns(false) });
            let ar  = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        });

        it('skips when provider module has no fetch()', async function () {
            let hub = makeHub();
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({}) });
            let ar  = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        });

        it('skips when capability snapshot is empty', async function () {
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            let ar    = new AttestationRound(hub, makeProviderRegistry());
            await ar._startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        });

        it('skips when this validator is not in the responsible set', async function () {
            // Set myPubkey to 'aa'*32, but the only responsible validator is 'bb'*32
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'bb'.repeat(32) }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let ar = new AttestationRound(hub, makeProviderRegistry());
            // Override _computeResponsibleSet to return only 'bb'*32
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: 'bb'.repeat(32), hash: '00' }]);
            await ar._startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        });

        it('records an error in rounds when provider fetch throws', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().rejects(new Error('fetch failed'));
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar._startRound(makeRequest());
            expect(ar.rounds.size).to.equal(1);
            let state = ar.rounds.get('rid0001');
            expect(state.error).to.be.a('string');
        });

        it('records round state and calls consensus.propose when responsible', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchResult = { body: Buffer.from('ok'), meta: '200' };
            let fetchStub = sinon.stub().resolves(fetchResult);
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            let consensus = { propose: sinon.stub().resolves() };
            ar.setConsensus(consensus);
            await ar._startRound(makeRequest());
            expect(ar.rounds.size).to.equal(1);
            expect(consensus.propose.calledOnce).to.be.true;
            let [rid, state] = consensus.propose.firstCall.args;
            expect(rid).to.equal('rid0001');
            expect(state.role).to.equal('leader');
        });
    });

    // ── _resolveBtcIndexerUrl ────────────────────────────────────────────────

    describe('_resolveBtcIndexerUrl()', function () {
        it('delegates to hub._resolveBtcIndexerUrl when available', async function () {
            let stub = sinon.stub().resolves('http://btc/rpc');
            let hub  = makeHub({ _resolveBtcIndexerUrl: stub });
            let ar   = new AttestationRound(hub, makeProviderRegistry());
            let url  = await ar._resolveBtcIndexerUrl();
            expect(url).to.equal('http://btc/rpc');
            expect(stub.calledOnce).to.be.true;
        });

        it('returns null when hub has no _resolveBtcIndexerUrl', async function () {
            let hub  = makeHub();
            delete hub._resolveBtcIndexerUrl;
            let ar   = new AttestationRound(hub, makeProviderRegistry());
            let url  = await ar._resolveBtcIndexerUrl();
            expect(url).to.be.null;
        });
    });

    // ── ATTEST_PROPOSE export ────────────────────────────────────────────────

    describe('module exports', function () {
        it('exports ATTEST_PROPOSE constant', function () {
            let { ATTEST_PROPOSE } = require('../../src/AttestationRound');
            expect(ATTEST_PROPOSE).to.equal('ATTEST_PROPOSE');
        });
    });
});
