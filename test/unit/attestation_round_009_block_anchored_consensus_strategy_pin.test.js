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

const MY_PUBKEY = 'aa'.repeat(32);

function makeRequest(overrides) {
            return {
                request_id: 'rid-strategy', provider_id: 'http_get', redundancy: 1,
                block_index: 4242, action_index: 1, payload: 'https://example.com/',
                ...overrides
            };
        }

function makeStrategyHub() {
            let capSS = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: MY_PUBKEY }] }) };
            let hub   = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = () => makeIdentity(MY_PUBKEY);
            return hub;
        }

// The PBFT strategy selects which state machine AttestationConsensus runs for the
    // round, so it is anchored at the request's block and pinned onto roundState rather
    // than read live at each of the six decision sites: hotReload() re-parses every
    // provider def from the local configs table on EVERY proposal:finalized event, so a
    // live read could flip a hub's machine between two messages of one round.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('block-anchored consensus_strategy pin', function () { it('_startRound resolves the strategy at the REQUEST block and pins it on roundState', async function () {
            let reg = makeProviderRegistry({
                getConsensusStrategy: sinon.stub().returns('judge_model'),
                getModule: sinon.stub().returns({ fetch: sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' }) })
            });
            let ar = new AttestationRound(makeStrategyHub(), reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            await ar._startRound(makeRequest(), 4242);
            expect(reg.getConsensusStrategy.calledWith('http_get', 4242)).to.be.true;
            let rs = [...ar.rounds.values()][0];
            expect(rs.pinnedConsensusStrategy).to.equal('judge_model');
        }); }); });

// The PBFT strategy selects which state machine AttestationConsensus runs for the
    // round, so it is anchored at the request's block and pinned onto roundState rather
    // than read live at each of the six decision sites: hotReload() re-parses every
    // provider def from the local configs table on EVERY proposal:finalized event, so a
    // live read could flip a hub's machine between two messages of one round.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('block-anchored consensus_strategy pin', function () { it('_startRound skips the round, and the paid fetch, when the strategy is unanchorable', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({
                getConsensusStrategy: sinon.stub().returns(null),
                getModule:            sinon.stub().returns({ fetch: fetchStub })
            });
            let ar = new AttestationRound(makeStrategyHub(), reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            await ar._startRound(makeRequest(), 4242);
            expect(ar.rounds.size).to.equal(0);
            expect(fetchStub.called, 'an unanchorable strategy must not trigger a paid fetch').to.be.false;
        }); }); });

// The PBFT strategy selects which state machine AttestationConsensus runs for the
    // round, so it is anchored at the request's block and pinned onto roundState rather
    // than read live at each of the six decision sites: hotReload() re-parses every
    // provider def from the local configs table on EVERY proposal:finalized event, so a
    // live read could flip a hub's machine between two messages of one round.


        // The registry carries an unrecognised strategy VERBATIM on purpose, so every hub
        // resolves the same value instead of walking back to an older machine. Declining is
        // the other half of that contract: admitted, a non-empty unknown name reaches
        // AttestationConsensus, whose dispatch is positive equality against the two
        // implemented names, so the round runs the byte_equality branches with the
        // no_quorum self-derivation gate (items 2641/2579) inactive.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('block-anchored consensus_strategy pin', function () { it('_startRound skips the round, and the paid fetch, on a strategy this build does not implement', async function () {
            let fetchStub = sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' });
            let reg = makeProviderRegistry({
                getConsensusStrategy: sinon.stub().returns('threshold_vote'),
                getModule:            sinon.stub().returns({ fetch: fetchStub })
            });
            let ar = new AttestationRound(makeStrategyHub(), reg);
            sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
            await ar._startRound(makeRequest(), 4242);
            expect(ar.rounds.size, 'an unsupported strategy must not pin a round').to.equal(0);
            expect(fetchStub.called, 'an unsupported strategy must not trigger a paid fetch').to.be.false;
        }); }); });

// The PBFT strategy selects which state machine AttestationConsensus runs for the
    // round, so it is anchored at the request's block and pinned onto roundState rather
    // than read live at each of the six decision sites: hotReload() re-parses every
    // provider def from the local configs table on EVERY proposal:finalized event, so a
    // live read could flip a hub's machine between two messages of one round.


        // Guards the allowlist against over-tightening: both implemented names must still
        // admit, or the gate above turns every live round into an expiry + refund.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('block-anchored consensus_strategy pin', function () { it('_startRound still admits both strategies this build implements', async function () {
            for (let strategy of ['byte_equality', 'judge_model']) {
                let reg = makeProviderRegistry({
                    getConsensusStrategy: sinon.stub().returns(strategy),
                    getModule: sinon.stub().returns({ fetch: sinon.stub().resolves({ body: Buffer.from('ok'), meta: '200' }) })
                });
                let ar = new AttestationRound(makeStrategyHub(), reg);
                sinon.stub(ar, '_computeResponsibleSet').returns([{ pubkey: MY_PUBKEY, hash: '00' }]);
                await ar._startRound(makeRequest(), 4242);
                expect(ar.rounds.size, strategy + ' must still start a round').to.equal(1);
                expect([...ar.rounds.values()][0].pinnedConsensusStrategy).to.equal(strategy);
            }
        }); }); });
}
