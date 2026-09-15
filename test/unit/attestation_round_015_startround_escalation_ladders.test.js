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
const lssMod         = require('../../src/attest_leader_silence_skip_activation.js');
const { DB_METHODS } = require('../helpers/mockHub.js');

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
    AttestationRound = proxyquire('../../src/attestation/round', { axios: axiosStub });
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

// ── _startRound escalation ladders (Phase 4) ─────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() escalation ladders', function () { it('keeps slot 0 as leader inside the first rotation window', async function () {
            let { ar, consensus } = setup();
            // confirmations=3: serviceable from block 103; tip 104 is step 0.
            await ar._startRound(makeRequest(), 104);
            let state = consensus.propose.firstCall.args[1];
            expect(state.leaderPubkey).to.equal(ME);
            expect(state.role).to.equal('leader');
        }); }); });

// ── _startRound escalation ladders (Phase 4) ─────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() escalation ladders', function () { it('rotates the leader one slot after a silent rotation window', async function () {
            let { ar, consensus } = setup();
            // step = floor((106-103)/2) = 1 → leader slot 1 (BB); I follow.
            await ar._startRound(makeRequest(), 106);
            let state = consensus.propose.firstCall.args[1];
            expect(state.leaderPubkey).to.equal(BB);
            expect(state.role).to.equal('follower');
        }); }); });

// ── _startRound escalation ladders (Phase 4) ─────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() escalation ladders', function () { it('pins the primary model in the first deadline segment', async function () {
            let { ar, fetchStub } = setup();
            // span [103,120] = 17 blocks, 2 models → segment 8.5; tip 106 → rank 0
            await ar._startRound(makeRequest(), 106);
            expect(fetchStub.firstCall.args[1].pinnedModel).to.equal('claude-sonnet-4-6');
            expect(fetchStub.firstCall.args[1].modelRank).to.equal(0);
        }); }); });

// ── _startRound escalation ladders (Phase 4) ─────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() escalation ladders', function () { it('escalates to the fallback model in the second deadline segment', async function () {
            let { ar, fetchStub } = setup();
            // tip 115: elapsed 12 ≥ 8.5 → rank 1 (gpt-5-mini)
            await ar._startRound(makeRequest(), 115);
            expect(fetchStub.firstCall.args[1].pinnedModel).to.equal('gpt-5-mini');
            expect(fetchStub.firstCall.args[1].modelRank).to.equal(1);
        }); }); });

// ── _startRound escalation ladders (Phase 4) ─────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() escalation ladders', function () { it('proposes a provider_error round (empty body/meta) when the fetch fails', async function () {
            let { ar, fetchStub, consensus } = setup();
            fetchStub.rejects(new Error('vendor 529'));
            await ar._startRound(makeRequest(), 104);
            expect(consensus.propose.calledOnce).to.be.true;
            let state = consensus.propose.firstCall.args[1];
            expect(state.myProposal.status).to.equal('provider_error');
            expect(state.myProposal.body.length).to.equal(0);
            expect(state.myProposal.meta).to.equal('');
            expect(ar.rounds.get('rid0001').error).to.equal('provider_error');
        }); }); });
}
