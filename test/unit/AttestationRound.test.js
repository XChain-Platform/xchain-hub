'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
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
        getAdditionalConfig: sinon.stub().returns({ approved_models: ['claude-sonnet-4-6'], judge_model: 'claude-haiku-4-5' }),
        // Block-anchored provider stake floor (XC-083). '0' keeps the pre-existing
        // fixtures (whose snapshots carry no weight) selecting exactly as before on the
        // unweighted path, which is the only path they exercise.
        getMinStake: sinon.stub().returns('0'),
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

    // ── responsible-set cross-service conformance ────────────────────────────
    // CONSENSUS-CRITICAL: _computeResponsibleSet is implemented independently
    // here and in xchain-indexer (actions/attest.js). They must produce
    // identical ordered output or attestation quorum evaluation forks. This
    // guard runs the canonical vectors from xchain-documentation against the
    // hub copy; the indexer ships its own mirror guard over the SAME vector
    // file. When the sibling xchain-documentation repo is not checked out
    // (standalone deploy) the suite skips rather than fails, matching the
    // ConsensusPrimitiveConformance convention - but in the required-siblings lane
    // (XCHAIN_REQUIRE_SIBLINGS=1, set by bin/ci-all.sh) an unresolvable vector path
    // is a hard failure, so a mis-resolved path cannot turn this consensus guard
    // into a permanent green-by-skip (item 2435).
    describe('_computeResponsibleSet() canonical-vector conformance @regression', function () {
        const path = require('path');
        const DOCS_DIR = process.env.XCHAIN_DOCS_DIR
            || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const VEC_PATH = path.join(DOCS_DIR, 'protocol', 'test-vectors', 'responsible_set.json');
        let vec = null, vecErr = null;
        try {
            vec = require(VEC_PATH);
        } catch (e) { vecErr = e; }

        before(function () {
            if (vec) return;
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the responsible-set canonical vectors are unloadable at '
                    + VEC_PATH + ' (' + (vecErr && vecErr.message) + ')');
            this.skip();
        });

        (vec ? vec.computeResponsibleSet : []).forEach(function (c) {
            it(c.name, function () {
                let hub = makeHub();
                let ar  = new AttestationRound(hub, makeProviderRegistry());
                let got = ar
                    ._computeResponsibleSet(c.validators, c.requestId, c.redundancy, c.weighted, c.minStake)
                    .map(v => v.pubkey);
                expect(got).to.deep.equal(c.expected);
            });
        });

        // AttestationPublisher._computeResponsible is the SECOND hub-side copy of the
        // same rule (it derives failover rank from it). Running the same vectors through
        // it closes the gap this describe's header used to name: until now no test fed
        // one input through more than one copy, so the two could drift in a direction
        // both suites called green. It returns null rather than [] where the rule
        // selects nobody, which is the caller's "rank unknown" signal.
        describe('AttestationPublisher._computeResponsible over the same vectors', function () {
            const AttestationPublisher = require('../../src/AttestationPublisher.js');
            const os   = require('os');
            const path = require('path');

            (vec ? vec.computeResponsibleSet : []).forEach(function (c) {
                it(c.name, async function () {
                    const fresh = () => c.validators.map(v => Object.assign({}, v));
                    const pub = new AttestationPublisher({
                        getIdentity: () => ({ getPubkeyHex: () => 'ff'.repeat(32) }),
                        p2pConfig:   {},
                        network:     c.weighted ? 'regtest' : 'mainnet',
                        capabilitySnapshot: {
                            getWeightSnapshot: async () => ({ validators: fresh() }),
                            getSnapshot:       async () => ({ validators: fresh() })
                        },
                        providerRegistry: { getMinStake: () => (c.minStake === undefined ? null : c.minStake) }
                    });
                    pub.queuePath = path.join(os.tmpdir(),
                        'attest-vec-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
                    // Block 100: below the mainnet SWQ anchor (961000) and above the
                    // regtest one (0), so the vector's `weighted` flag alone picks the branch.
                    let got = await pub._computeResponsible(c.requestId, 100, c.redundancy, 'http_get');
                    expect(got).to.deep.equal(c.expected.length ? c.expected : null);
                });
            });
        });
    });

    // ── provider stake floor (XC-083) ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // _startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
    describe('provider stake floor on the weighted path (XC-083)', function () {

        function weightedValidators() {
            return [
                { pubkey: 'aa'.repeat(32), source: 'sRich', weight: '50000' },
                { pubkey: 'bb'.repeat(32), source: 'sPoor', weight: '9999.99999999' },
                { pubkey: 'cc'.repeat(32), source: 'sEven', weight: '10000' }
            ];
        }

        function makeRequest(overrides) {
            return {
                request_id: 'rid-floor', provider_id: 'http_get', redundancy: 1,
                block_index: 100, action_index: 1, payload: 'https://example.com/',
                ...overrides
            };
        }

        it('drops below-floor sources and keeps the boundary source', function () {
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            let got = ar._computeResponsibleSet(weightedValidators(), 'rid-floor', 5, true, '10000')
                        .map(v => v.pubkey);
            expect(got).to.have.members(['aa'.repeat(32), 'cc'.repeat(32)]);
            expect(got).to.not.include('bb'.repeat(32));
        });

        it('ignores the floor entirely below the STAKE_WEIGHTED_QUORUM gate', function () {
            // Unweighted rows carry no weight at all, so applying the floor there would
            // empty every pre-gate round. Replay of pre-anchor history must be unchanged.
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            let got = ar._computeResponsibleSet(
                [{ pubkey: 'aa'.repeat(32) }, { pubkey: 'bb'.repeat(32) }],
                'rid-floor', 2, false, '25000').map(v => v.pubkey);
            expect(got).to.have.lengthOf(2);
        });

        it('fails closed (empty set) when the floor is unresolvable', function () {
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            expect(ar._computeResponsibleSet(weightedValidators(), 'rid-floor', 3, true, null)).to.deep.equal([]);
        });

        it('excludes a row whose weight is missing or unparseable rather than reading it as 0', function () {
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            let got = ar._computeResponsibleSet([
                { pubkey: 'aa'.repeat(32), source: 's1' },                    // no weight at all
                { pubkey: 'bb'.repeat(32), source: 's2', weight: 'lots' },    // unparseable
                { pubkey: 'cc'.repeat(32), source: 's3', weight: '50000' }
            ], 'rid-floor', 3, true, '10000').map(v => v.pubkey);
            expect(got).to.deep.equal(['cc'.repeat(32)]);
        });

        it('_startRound resolves the floor from the registry at the REQUEST block', async function () {
            let capSS = { getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network = 'regtest';                       // SWQ armed at genesis here
            hub.getIdentity = () => makeIdentity('aa'.repeat(32));
            let reg = makeProviderRegistry({ getMinStake: sinon.stub().returns('10000') });
            let ar  = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest({ block_index: 4242 }), 4242);
            expect(reg.getMinStake.calledWith('http_get', 4242)).to.be.true;
        });

        it('_startRound skips the round, and the paid fetch, when the floor is unresolvable', async function () {
            let capSS = { getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network = 'regtest';
            hub.getIdentity = () => makeIdentity('aa'.repeat(32));
            let fetchStub = sinon.stub().resolves({ body: 'data', meta: '200' });
            let reg = makeProviderRegistry({
                getMinStake: sinon.stub().returns(null),
                getModule:   sinon.stub().returns({ fetch: fetchStub })
            });
            let ar = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest(), 100);
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called, 'a floorless provider must not trigger a paid fetch').to.be.false;
        });

        it('_startRound skips when the floor leaves fewer slots than REDUNDANCY', async function () {
            // Two of the three sources clear a 10000 floor, so redundancy 3 is
            // unfinalizable and the existing guard must catch the shrink the floor caused.
            let capSS = { getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network = 'regtest';
            hub.getIdentity = () => makeIdentity('aa'.repeat(32));
            let fetchStub = sinon.stub().resolves({ body: 'data', meta: '200' });
            let reg = makeProviderRegistry({
                getMinStake: sinon.stub().returns('10000'),
                getModule:   sinon.stub().returns({ fetch: fetchStub })
            });
            let ar = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest({ redundancy: 3 }), 100);
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called).to.be.false;
        });

        it('_startRound proceeds normally when every responsible slot clears the floor', async function () {
            let capSS = { getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network = 'regtest';
            hub.getIdentity = () => makeIdentity('aa'.repeat(32));
            let reg = makeProviderRegistry({ getMinStake: sinon.stub().returns('10000') });
            let ar  = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest({ redundancy: 2 }), 100);
            expect(ar.rounds.size).to.equal(1);
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

        it('surfaces consensus round timeouts separately from local fetch failures (item 8c1148c0)', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            // No consensus wired: the field is absent, so an older-hub consumer
            // reads undefined rather than a misleading zero.
            expect(ar.getStats().consensus_timeout_count).to.equal(undefined);
            ar.setConsensus({
                nonOkPublished:                 new Map(),
                nonOkPublishedMax:              64,
                nonOkEvictedWhilePendingCount:  0,
                roundTimeoutCount:              4
            });
            // Quorum loss must NOT be folded into failed_count: failed_count is a
            // gauge over the TTL-evicting rounds map, so a combined number would
            // let an eviction cancel a timeout out of a consumer's rise check.
            let stats = ar.getStats();
            expect(stats.consensus_timeout_count).to.equal(4);
            expect(stats.failed_count).to.equal(0);
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

        it('skips (before the provider fetch) when responsible slots < redundancy (Pkg 7 / 87441a53)', async function () {
            // One qualifying validator but redundancy 2: the round can never
            // collect the >= redundancy signatures the indexer requires, so the
            // round must be refused BEFORE the paid provider fetch.
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: 'data', meta: '200' });
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            await ar._startRound(makeRequest({ redundancy: 2 }));
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called).to.be.false;
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

        it('skips (before any fetch) when the request fee is below the provider min_fee', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: 'data', meta: '200' });
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({ fetch: fetchStub }),
                getDef:    sinon.stub().returns({ max_response_bytes: 32768, min_fee_xchain: '0.50' })
            });
            let ar = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar._startRound(makeRequest({ fee_amount: '0.10' }));
            expect(ar.rounds.size).to.equal(0, 'below-floor request skipped');
            expect(fetchStub.called).to.be.false;
        });

        it('proceeds when the request fee meets the provider min_fee exactly', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({ fetch: fetchStub }),
                getDef:    sinon.stub().returns({ max_response_bytes: 32768, min_fee_xchain: '0.50' })
            });
            let ar = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar._startRound(makeRequest({ fee_amount: '0.50' }));
            expect(fetchStub.calledOnce).to.be.true;
        });

        it('proceeds for a feeless request when min_fee is 0 (default)', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({ fetch: fetchStub }),
                getDef:    sinon.stub().returns({ max_response_bytes: 32768, min_fee_xchain: '0' })
            });
            let ar = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar._startRound(makeRequest());   // no fee_amount at all
            expect(fetchStub.calledOnce).to.be.true;
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

        it('snapshots the block-anchored model: pinnedModel into fetch, pinnedJudgeModel into roundState', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: 'claude-opus-4-8' });
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({ fetch: fetchStub }),
                // Block-anchored config resolved at the request's block.
                getAdditionalConfig: sinon.stub().returns({ approved_models: ['claude-opus-4-8'], judge_model: 'claude-haiku-4-6' })
            });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            let consensus = { propose: sinon.stub().resolves() };
            ar.setConsensus(consensus);
            await ar._startRound(makeRequest());
            // fetch() received the block-anchored fetch model (approved_models[0]).
            expect(fetchStub.firstCall.args[1].pinnedModel).to.equal('claude-opus-4-8');
            // roundState carries the block-anchored judge model into consensus.
            let state = consensus.propose.firstCall.args[1];
            expect(state.pinnedJudgeModel).to.equal('claude-haiku-4-6');
            // getAdditionalConfig was resolved at the request's block_index.
            expect(reg.getAdditionalConfig.calledWith('http_get', sinon.match.any)).to.be.true;
        });
    });

    // ── durable fetch cache ──────────────────────────────────────

    describe('_startRound() durable fetch cache', function () {

        const MY_PUBKEY = 'aa'.repeat(32);

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

        // doQuery that answers the cache SELECT with `row` (null => cache miss)
        // and records every statement for assertion.
        function makeCacheDb(row) {
            return sinon.stub().callsFake(async (q) => {
                if (/SELECT status, body, meta FROM attestation_fetch_cache/.test(q)) {
                    return row ? [row] : [];
                }
                return [];
            });
        }

        function makeRound(fetchStub, row) {
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: MY_PUBKEY }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(MY_PUBKEY);
            hub.db = { doQuery: makeCacheDb(row) };
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            ar.setConsensus({ propose: sinon.stub().resolves() });
            return { ar, hub };
        }

        it('records the completed fetch so a restart has something to reuse', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);

            await ar._startRound(makeRequest());

            expect(fetchStub.calledOnce, 'a cache miss still fetches').to.be.true;
            let insert = hub.db.doQuery.getCalls()
                .find(c => /INSERT INTO attestation_fetch_cache/.test(c.args[0]));
            expect(insert, 'the outcome is upserted').to.not.equal(undefined);
            expect(insert.args[1][0]).to.equal('rid0001');
            expect(insert.args[1][2]).to.equal('ok');
            expect(Buffer.isBuffer(insert.args[1][3])).to.be.true;
            expect(insert.args[1][3].toString()).to.equal('ok');
            // The write follows the fetch: a claim recorded BEFORE the call would
            // let a crash mid-fetch skip a round this hub never finished.
            expect(insert.calledAfter(fetchStub.firstCall)).to.be.true;
        });

        it('reuses a recorded fetch instead of paying the provider again', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('fresh'), meta: '200' });
            let { ar } = makeRound(fetchStub, { status: 'ok', body: Buffer.from('recorded'), meta: '200' });

            await ar._startRound(makeRequest());

            expect(fetchStub.called, 'the billed provider must not be called again').to.be.false;
            let state = ar.rounds.get('rid0001');
            expect(state.myProposal.status).to.equal('ok');
            // Byte-identical to the pre-restart proposal, so the hub cannot sign a
            // second, different body under the same request id.
            expect(state.myProposal.body.toString()).to.equal('recorded');
            expect(state.myProposal.meta).to.equal('200');
        });

        it('reuses a recorded provider_error rather than re-deciding the round', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('fresh'), meta: '200' });
            let { ar } = makeRound(fetchStub, { status: 'provider_error', body: null, meta: null });

            await ar._startRound(makeRequest());

            expect(fetchStub.called).to.be.false;
            let state = ar.rounds.get('rid0001');
            expect(state.error).to.equal('provider_error');
            expect(state.myProposal.body.length).to.equal(0);
        });

        it('reads only inside the retry window, so a lapsed round re-fetches', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);

            let before = Math.floor((Date.now() - ar.retryAfterMs) / 1000);
            await ar._startRound(makeRequest());

            let select = hub.db.doQuery.getCalls()
                .find(c => /SELECT status, body, meta FROM attestation_fetch_cache/.test(c.args[0]));
            expect(select.args[0]).to.contain('created_at >= FROM_UNIXTIME(?)');
            expect(select.args[1][1]).to.be.at.least(before);
        });

        it('fails OPEN: an unreachable cache re-fetches rather than dropping the round', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);
            hub.db.doQuery = sinon.stub().rejects(new Error('db down'));

            await ar._startRound(makeRequest());

            expect(fetchStub.calledOnce).to.be.true;
            expect(ar.rounds.size).to.equal(1);
        });

        it('evicts lapsed rows on the seen-window schedule', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let { ar, hub } = makeRound(fetchStub, null);
            hub._resolveBtcIndexerUrl = sinon.stub().resolves('http://idx/rpc');
            axiosStub.post.resolves({ data: { result: { latest_block_index: 200, requests: [] } } });

            await ar._pollPending();

            let ran = hub.db.doQuery.getCalls().map(c => c.args[0]);
            expect(ran.some(q => /DELETE FROM attestation_fetch_cache/.test(q))).to.be.true;
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

    // ── _startRound escalation ladders (Phase 4) ─────────────────────────────

    describe('_startRound() escalation ladders', function () {

        const ME = 'aa'.repeat(32);
        const BB = 'bb'.repeat(32);

        function makeRequest(overrides) {
            return {
                request_id:   'rid0001',
                provider_id:  'llm',
                // 2 responsible slots below: redundancy must be servable
                // (<= responsible.length) or the Pkg 7 unservable-redundancy
                // guard skips the round before the ladder logic under test.
                redundancy:   2,
                block_index:  100,
                action_index: 1,
                deadline_block: 120,
                payload:      JSON.stringify({ prompt: 'hi' }),
                ...overrides
            };
        }

        function setup(regOverrides) {
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: ME }, { pubkey: BB }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(ME);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: 'claude-sonnet-4-6' });
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({ fetch: fetchStub }),
                getAdditionalConfig: sinon.stub().returns({
                    approved_models: ['claude-sonnet-4-6', 'gpt-5-mini'],
                    judge_model:     'claude-haiku-4-5'
                }),
                ...(regOverrides || {})
            });
            let ar = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: ME, hash: '00' }, { pubkey: BB, hash: '01' }]);
            let consensus = { propose: sinon.stub().resolves() };
            ar.setConsensus(consensus);
            return { ar, fetchStub, consensus };
        }

        it('keeps slot 0 as leader inside the first rotation window', async function () {
            let { ar, consensus } = setup();
            // confirmations=3: serviceable from block 103; tip 104 is step 0.
            await ar._startRound(makeRequest(), 104);
            let state = consensus.propose.firstCall.args[1];
            expect(state.leaderPubkey).to.equal(ME);
            expect(state.role).to.equal('leader');
        });

        it('rotates the leader one slot after a silent rotation window', async function () {
            let { ar, consensus } = setup();
            // step = floor((106-103)/2) = 1 → leader slot 1 (BB); I follow.
            await ar._startRound(makeRequest(), 106);
            let state = consensus.propose.firstCall.args[1];
            expect(state.leaderPubkey).to.equal(BB);
            expect(state.role).to.equal('follower');
        });

        it('pins the primary model in the first deadline segment', async function () {
            let { ar, fetchStub } = setup();
            // span [103,120] = 17 blocks, 2 models → segment 8.5; tip 106 → rank 0
            await ar._startRound(makeRequest(), 106);
            expect(fetchStub.firstCall.args[1].pinnedModel).to.equal('claude-sonnet-4-6');
            expect(fetchStub.firstCall.args[1].modelRank).to.equal(0);
        });

        it('escalates to the fallback model in the second deadline segment', async function () {
            let { ar, fetchStub } = setup();
            // tip 115: elapsed 12 ≥ 8.5 → rank 1 (gpt-5-mini)
            await ar._startRound(makeRequest(), 115);
            expect(fetchStub.firstCall.args[1].pinnedModel).to.equal('gpt-5-mini');
            expect(fetchStub.firstCall.args[1].modelRank).to.equal(1);
        });

        it('proposes a provider_error round (empty body/meta) when the fetch fails', async function () {
            let { ar, fetchStub, consensus } = setup();
            fetchStub.rejects(new Error('vendor 529'));
            await ar._startRound(makeRequest(), 104);
            expect(consensus.propose.calledOnce).to.be.true;
            let state = consensus.propose.firstCall.args[1];
            expect(state.myProposal.status).to.equal('provider_error');
            expect(state.myProposal.body.length).to.equal(0);
            expect(state.myProposal.meta).to.equal('');
            expect(ar.rounds.get('rid0001').error).to.equal('provider_error');
        });
    });

    // ── ATTEST_PROPOSE export ────────────────────────────────────────────────

    describe('module exports', function () {
        it('exports ATTEST_PROPOSE constant', function () {
            let { ATTEST_PROPOSE } = require('../../src/AttestationRound');
            expect(ATTEST_PROPOSE).to.equal('ATTEST_PROPOSE');
        });
    });

    // ── retry-window floor + live-round fetch gate (item 2358) ────────────────

    describe('retry window vs consensus round timeout (2358)', function () {
        it('floors retryAfterMs above the consensus round timeout', function () {
            // pollMs 5s -> 5*5=25s configured window, floored to 120s+5s.
            let hub = makeHub({ p2pConfig: { ATTESTATION_POLL_MS: '5000' } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.retryAfterMs).to.equal(125000);
        });

        it('keeps an operator retry window that already clears the floor', function () {
            let hub = makeHub({ p2pConfig: {
                ATTESTATION_RETRY_AFTER_MS: '500000',
                ATTESTATION_ROUND_TIMEOUT_MS: '120000'
            } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.retryAfterMs).to.equal(500000);
        });

        it('skips the paid fetch when a consensus round for the rid is already active', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({ fetch: fetchStub }),
                getDef:    sinon.stub().returns({ max_response_bytes: 32768 })
            });
            let ar = new AttestationRound(hub, reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            ar.setConsensus({ isRoundActive: sinon.stub().returns(true) });
            await ar._startRound({
                request_id: 'rid0001', provider_id: 'http_get', redundancy: 1,
                block_index: 100, action_index: 1, payload: 'https://example.com/'
            });
            expect(fetchStub.called).to.be.false;
        });
    });

    // ── poll self-overlap guard (item 2591) ───────────────────────────────────

    describe('_pollPending in-flight guard (2591)', function () {
        it('does not stack a second concurrent poll while one is in flight', async function () {
            let resolvePost;
            axiosStub.post.returns(new Promise(r => { resolvePost = r; }));
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let first  = ar._pollPending();     // enters, sets _pollRunning, awaits axios
            let second = ar._pollPending();     // must short-circuit on _pollRunning
            // Let the first poll advance past its awaited URL resolve to axios.post.
            await new Promise(r => setImmediate(r));
            expect(axiosStub.post.calledOnce).to.be.true;
            resolvePost({ data: { result: null } });
            await Promise.all([first, second]);
            expect(ar._pollRunning).to.be.false; // flag cleared in finally
        });
    });
});
