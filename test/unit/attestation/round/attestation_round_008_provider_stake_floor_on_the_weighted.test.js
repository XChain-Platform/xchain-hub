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

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('drops below-floor sources and keeps the boundary source', function () {
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            let got = ar.computeResponsibleSet(weightedValidators(), 'rid-floor', 5, true, '10000')
                        .map(v => v.pubkey);
            expect(got).to.have.members(['aa'.repeat(32), 'cc'.repeat(32)]);
            expect(got).to.not.include('bb'.repeat(32));
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('ignores the floor entirely below the STAKE_WEIGHTED_QUORUM gate', function () {
            // Unweighted rows carry no weight at all, so applying the floor there would
            // empty every pre-gate round. Replay of pre-anchor history must be unchanged.
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            let got = ar.computeResponsibleSet(
                [{ pubkey: 'aa'.repeat(32) }, { pubkey: 'bb'.repeat(32) }],
                'rid-floor', 2, false, '25000').map(v => v.pubkey);
            expect(got).to.have.lengthOf(2);
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('fails closed (empty set) when the floor is unresolvable', function () {
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            expect(ar.computeResponsibleSet(weightedValidators(), 'rid-floor', 3, true, null)).to.deep.equal([]);
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('excludes a row whose weight is missing or unparseable rather than reading it as 0', function () {
            let ar = new AttestationRound(makeHub(), makeProviderRegistry());
            let got = ar.computeResponsibleSet([
                { pubkey: 'aa'.repeat(32), source: 's1' },                    // no weight at all
                { pubkey: 'bb'.repeat(32), source: 's2', weight: 'lots' },    // unparseable
                { pubkey: 'cc'.repeat(32), source: 's3', weight: '50000' }
            ], 'rid-floor', 3, true, '10000').map(v => v.pubkey);
            expect(got).to.deep.equal(['cc'.repeat(32)]);
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('startRound resolves the floor from the registry at the REQUEST block', async function () {
            let capSS = { getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network = 'regtest';                       // SWQ armed at genesis here
            hub.getIdentity = () => makeIdentity('aa'.repeat(32));
            let reg = makeProviderRegistry({ getMinStake: sinon.stub().returns('10000') });
            let ar  = new AttestationRound(hub, reg);
            await ar.startRound(makeRequest({ block_index: 4242 }), 4242);
            expect(reg.getMinStake.calledWith('http_get', 4242)).to.be.true;
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('startRound skips the round, and the paid fetch, when the floor is unresolvable', async function () {
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
            await ar.startRound(makeRequest(), 100);
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called, 'a floorless provider must not trigger a paid fetch').to.be.false;
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('startRound skips when the floor leaves fewer slots than REDUNDANCY', async function () {
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
            await ar.startRound(makeRequest({ redundancy: 3 }), 100);
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called).to.be.false;
        }); }); });

// ── provider stake floor ───────────────────────────────────────
    // The canonical vectors above cover the SELECTION rule, but they skip wholesale
    // when the sibling xchain-documentation checkout is absent. These pin the same
    // behaviour locally, plus the two things the vectors cannot express: that
    // startRound resolves the floor from the BLOCK-ANCHORED registry at the request's
    // own block, and that it refuses the round (before the paid provider fetch) when
    // the floor cannot be resolved.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('provider stake floor on the weighted path', function () { it('startRound proceeds normally when every responsible slot clears the floor', async function () {
            let capSS = { getWeightSnapshot: sinon.stub().resolves({ validators: weightedValidators() }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.network = 'regtest';
            hub.getIdentity = () => makeIdentity('aa'.repeat(32));
            let reg = makeProviderRegistry({ getMinStake: sinon.stub().returns('10000') });
            let ar  = new AttestationRound(hub, reg);
            await ar.startRound(makeRequest({ redundancy: 2 }), 100);
            expect(ar.rounds.size).to.equal(1);
        }); }); });
}
