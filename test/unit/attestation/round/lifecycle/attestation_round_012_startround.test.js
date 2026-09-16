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
const lssMod         = require('../../../../../src/attest_leader_silence_skip_activation.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

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
        resolveBtcIndexerUrl: overrides && overrides.resolveBtcIndexerUrl
            ? overrides.resolveBtcIndexerUrl
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
    AttestationRound = proxyquire('../../../../../src/attestation/round', { axios: axiosStub });
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

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('skips when provider is unknown', async function () {
            let hub = makeHub();
            let reg = makeProviderRegistry({ isKnown: sinon.stub().returns(false) });
            let ar  = new AttestationRound(hub, reg);
            await ar.startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('skips when provider module has no fetch()', async function () {
            let hub = makeHub();
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({}) });
            let ar  = new AttestationRound(hub, reg);
            await ar.startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('skips when capability snapshot is empty', async function () {
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            let ar    = new AttestationRound(hub, makeProviderRegistry());
            await ar.startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('skips (before the provider fetch) when responsible slots < redundancy (Pkg 7 / 87441a53)', async function () {
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
            await ar.startRound(makeRequest({ redundancy: 2 }));
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called).to.be.false;
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('skips when this validator is not in the responsible set', async function () {
            // Set myPubkey to 'aa'*32, but the only responsible validator is 'bb'*32
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'bb'.repeat(32) }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let ar = new AttestationRound(hub, makeProviderRegistry());
            // Override computeResponsibleSet to return only 'bb'*32
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: 'bb'.repeat(32), hash: '00' }]);
            await ar.startRound(makeRequest());
            expect(ar.rounds.size).to.equal(0);
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('skips (before any fetch) when the request fee is below the provider min_fee', async function () {
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
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar.startRound(makeRequest({ fee_amount: '0.10' }));
            expect(ar.rounds.size).to.equal(0, 'below-floor request skipped');
            expect(fetchStub.called).to.be.false;
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('proceeds when the request fee meets the provider min_fee exactly', async function () {
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
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar.startRound(makeRequest({ fee_amount: '0.50' }));
            expect(fetchStub.calledOnce).to.be.true;
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('proceeds for a feeless request when min_fee is 0 (default)', async function () {
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
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar.startRound(makeRequest());   // no fee_amount at all
            expect(fetchStub.calledOnce).to.be.true;
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('records an error in rounds when provider fetch throws', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().rejects(new Error('fetch failed'));
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            await ar.startRound(makeRequest());
            expect(ar.rounds.size).to.equal(1);
            let state = ar.rounds.get('rid0001');
            expect(state.error).to.be.a('string');
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('records round state and calls consensus.propose when responsible', async function () {
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchResult = { body: Buffer.from('ok'), meta: '200' };
            let fetchStub = sinon.stub().resolves(fetchResult);
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            let consensus = { propose: sinon.stub().resolves() };
            ar.setConsensus(consensus);
            await ar.startRound(makeRequest());
            expect(ar.rounds.size).to.equal(1);
            expect(consensus.propose.calledOnce).to.be.true;
            let [rid, state] = consensus.propose.firstCall.args;
            expect(rid).to.equal('rid0001');
            expect(state.role).to.equal('leader');
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('snapshots the block-anchored model: pinnedModel into fetch, pinnedJudgeModel into roundState', async function () {
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
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            let consensus = { propose: sinon.stub().resolves() };
            ar.setConsensus(consensus);
            await ar.startRound(makeRequest());
            // fetch() received the block-anchored fetch model (approved_models[0]).
            expect(fetchStub.firstCall.args[1].pinnedModel).to.equal('claude-opus-4-8');
            // roundState carries the block-anchored judge model into consensus.
            let state = consensus.propose.firstCall.args[1];
            expect(state.pinnedJudgeModel).to.equal('claude-haiku-4-6');
            // getAdditionalConfig was resolved at the request's block_index.
            expect(reg.getAdditionalConfig.calledWith('http_get', sinon.match.any)).to.be.true;
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('hands the provider this hub validated network, for the http_get SSRF hatch gate', async function () {
            // http_get honors ATTESTATION_HTTP_GET_ALLOW_PRIVATE only on regtest. A
            // container reads HUB_NETWORK from its own env, but the e2e harness runs
            // several hubs in ONE process off in-memory p2pConfig, where process.env
            // cannot tell them apart - so the network has to travel with the call.
            let myPubkey = 'aa'.repeat(32);
            // regtest has STAKE_WEIGHTED_QUORUM active from genesis, so the round takes
            // the weight-snapshot leg; both legs reach the same fetch.
            let capSS = { getSnapshot:       sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }),
                          getWeightSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network     = 'regtest';
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            ar.setConsensus({ propose: sinon.stub().resolves() });
            await ar.startRound(makeRequest());
            expect(fetchStub.calledOnce, 'the round reached the provider fetch').to.be.true;
            expect(fetchStub.firstCall.args[1].network).to.equal('regtest');
        }); }); });

// ── startRound ───────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound()', function () { it('gives an unconfigured hub a 20 s provider fetch budget, not 10 s (operator ruling 2026-09-11)', async function () {
            // The budget the provider actually receives, not the field the constructor
            // parsed: a hub with no ATTESTATION_FETCH_TIMEOUT key is the whole fleet
            // today, and a 10 s abort on a slow-but-healthy provider cost the round an
            // independent body that byte_equality then read as no_quorum. Asserted at
            // the call site because that is where the budget is spent.
            let myPubkey = 'aa'.repeat(32);
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: myPubkey }] }) };
            let hub   = makeHub();                  // no p2pConfig at all
            hub.capabilitySnapshot = capSS;
            hub.getIdentity = () => makeIdentity(myPubkey);
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({ getModule: sinon.stub().returns({ fetch: fetchStub }) });
            let ar  = new AttestationRound(hub, reg);
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            ar.setConsensus({ propose: sinon.stub().resolves() });
            await ar.startRound(makeRequest());
            expect(fetchStub.calledOnce, 'the round reached the provider fetch').to.be.true;
            expect(fetchStub.firstCall.args[1].timeoutMs).to.equal(20000);
            // Still far under the round timer, which stays the terminal backstop.
            expect(fetchStub.firstCall.args[1].timeoutMs).to.be.lessThan(ar.retryAfterMs);
        }); }); });
}
