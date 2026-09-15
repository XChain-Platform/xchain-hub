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
// The flag day the silent-slot leader skip rides. Read rather than re-spelled, so
// a height change moves the cases with it instead of leaving them asserting a
// literal the code no longer uses.
const lssMod         = require('../../../../src/attest_leader_silence_skip_activation.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

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
        db:               { ...DB_METHODS, doQuery: sinon.stub().resolves([]) },
        p2pConfig:        overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getPeerManager:   () => pm,
        getIdentity:      () => makeIdentity(),
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        _resolveBtcIndexerUrl: overrides && overrides._resolveBtcIndexerUrl
            ? overrides._resolveBtcIndexerUrl
            : sinon.stub().resolves(null),
        btcIndexerHeaders: () => ({})
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
        // Block-anchored provider stake floor. '0' keeps the pre-existing
        // fixtures (whose snapshots carry no weight) selecting exactly as before on the
        // unweighted path, which is the only path they exercise.
        getMinStake: sinon.stub().returns('0'),
        // Block-anchored PBFT strategy, resolved once at the request's block and pinned
        // onto roundState. byte_equality keeps the existing fixtures on the path they
        // already exercised; the anchoring itself is covered in ProviderRegistry.test.js
        // and the fail-closed branch below.
        getConsensusStrategy: sinon.stub().returns('byte_equality'),
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
    AttestationRound = proxyquire('../../../../src/attestation/round', { axios: axiosStub });
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

{
const hookAt3853 = function () {
        loadModule();
    };

const hookAt3913 = function () {
        sinon.restore();
    };

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('returns immediately when identity is null', async function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.identity = null;
            await ar.pollPending();  // should not throw
            expect(axiosStub.post.called).to.be.false;
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('returns immediately when no BTC indexer URL is available', async function () {
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves(null) });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar.pollPending();
            expect(axiosStub.post.called).to.be.false;
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('returns on axios error without throwing', async function () {
            axiosStub.post.rejects(new Error('network error'));
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar.pollPending();  // should not throw
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('returns when response has no result', async function () {
            axiosStub.post.resolves({ data: { result: null } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar.pollPending();
            expect(ar.seen.size).to.equal(0);
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────



        // ── HTTP-200 JSON-RPC rejections are not silent (item 7650) ──────────
        // The catch above this branch logs transport failures, so an indexer that is
        // DOWN was visible while one answering 200 with `Method not found` was not:
        // the poll returned without a word and every counter stayed frozen at its last
        // value while the request feed admitted nothing.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('logs and counts a top-level JSON-RPC error with no result', async function () {
            let warn = sinon.stub(console, 'warn');
            axiosStub.post.resolves({ data: { jsonrpc: '2.0', id: 1,
                error: { code: -32601, message: 'Method not found' } } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());

            await ar.pollPending();

            expect(ar.pollRpcErrorCount).to.equal(1);
            expect(ar.seen.size, 'no request is admitted on an error response').to.equal(0);
            expect(warn.called, 'the rejection is logged at warning level').to.be.true;
            let line = warn.getCall(0).args.join(' ');
            expect(line).to.include('getpendingattestation_requests');
            expect(line).to.include('http://idx/rpc');
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('logs and counts an error nested in the result', async function () {
            let warn = sinon.stub(console, 'warn');
            axiosStub.post.resolves({ data: { result: { error: { message: 'index not ready' } } } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());

            await ar.pollPending();

            expect(ar.pollRpcErrorCount).to.equal(1);
            expect(warn.called).to.be.true;
            expect(warn.getCall(0).args.join(' ')).to.include('index not ready');
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('counts every rejection but throttles the warning', async function () {
            let warn = sinon.stub(console, 'warn');
            axiosStub.post.resolves({ data: { error: { message: 'Method not found' } } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());

            await ar.pollPending();
            await ar.pollPending();
            await ar.pollPending();

            expect(ar.pollRpcErrorCount, 'the counter moves on every poll').to.equal(3);
            expect(warn.callCount, 'the log does not flood at the poll cadence').to.equal(1);
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('stamps the last successful poll and clears the reported age', async function () {
            axiosStub.post.resolves({ data: { result: { latest_block_index: 100, requests: [] } } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());

            expect(ar.getStats().last_successful_poll_age_ms,
                'null, not a large number, before any poll has succeeded').to.equal(null);

            await ar.pollPending();

            expect(ar.lastPollOkAt).to.be.a('number');
            expect(ar.getStats().last_successful_poll_age_ms).to.be.a('number');
            expect(ar.getStats().last_successful_poll_age_ms).to.be.at.least(0);
            expect(ar.getStats().poll_rpc_error_count).to.equal(0);
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('leaves the successful-poll stamp alone when a later poll is rejected', async function () {
            sinon.stub(console, 'warn');
            axiosStub.post.resolves({ data: { result: { latest_block_index: 100, requests: [] } } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            await ar.pollPending();
            let stampedAt = ar.lastPollOkAt;

            axiosStub.post.resolves({ data: { error: { message: 'Method not found' } } });
            await ar.pollPending();

            expect(ar.lastPollOkAt, 'a rejection must not look like a success').to.equal(stampedAt);
            expect(ar.getStats().poll_rpc_error_count).to.equal(1);
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────



        // The batch publisher anchors on this tip when no indexer pushed a chain_tips
        // row to the hub, so the poll has to record it even on a page with no requests.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('records the BTC tip the poll reported, and stop() forgets it', async function () {
            axiosStub.post.resolves({ data: { result: { latest_block_index: 100, requests: [] } } });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.getObservedBtcTip()).to.equal(null);

            await ar.pollPending();

            let tip = ar.getObservedBtcTip();
            expect(tip.blockHeight).to.equal(100);
            expect(tip.observedAt).to.be.a('number');
            tip.blockHeight = 1;
            expect(ar.getObservedBtcTip().blockHeight, 'a reader gets a copy').to.equal(100);

            // A poll that reports no usable tip keeps the last good one.
            axiosStub.post.resolves({ data: { result: { latest_block_index: 0, requests: [] } } });
            await ar.pollPending();
            expect(ar.getObservedBtcTip().blockHeight).to.equal(100);

            await ar.stop();
            expect(ar.getObservedBtcTip()).to.equal(null);
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('skips requests that are already in seen map', async function () {
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
            let _startRoundSpy = sinon.spy(ar, 'startRound');
            await ar.pollPending();
            expect(_startRoundSpy.called).to.be.false;
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('skips unconfirmed requests (block too recent)', async function () {
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
            let spy = sinon.spy(ar, 'startRound');
            await ar.pollPending();
            expect(spy.called).to.be.false;
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('advances and resets cursor correctly', async function () {
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
            // Stub startRound to avoid execution
            sinon.stub(ar, 'startRound').resolves();
            await ar.pollPending();
            // Full page → cursor set to last item's coords
            expect(ar.pollCursor).to.deep.equal({ block_index: 50, action_index: 99 });
        }); }); });

// ── pollPending ─────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('pollPending()', function () { it('resets cursor to null on short page (< POLL_LIMIT)', async function () {
            axiosStub.post.resolves({
                data: { result: { latest_block_index: 200, requests: [{ request_id: 'only1', block_index: 50, action_index: 0 }] } }
            });
            let hub = makeHub({ _resolveBtcIndexerUrl: sinon.stub().resolves('http://idx/rpc') });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            ar.pollCursor = { block_index: 40, action_index: 0 };
            sinon.stub(ar, 'startRound').resolves();
            await ar.pollPending();
            // Short page → cursor reset to null
            expect(ar.pollCursor).to.be.null;
        }); }); });
}
