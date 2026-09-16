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

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('initialises rounds and seen as empty Maps', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.rounds).to.be.instanceOf(Map);
            expect(ar.seen).to.be.instanceOf(Map);
            expect(ar.rounds.size).to.equal(0);
            expect(ar.seen.size).to.equal(0);
        }); }); });

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('reads ATTESTATION_POLL_MS from config', function () {
            let hub = makeHub({ p2pConfig: { ATTESTATION_POLL_MS: '5000' } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.pollMs).to.equal(5000);
        }); }); });

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('reads ATTESTATION_CONFIRMATIONS from config', function () {
            let hub = makeHub({ p2pConfig: { ATTESTATION_CONFIRMATIONS: '6', ORACLE_EPOCH_START: '0' } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.confirmations).to.equal(6);
        }); }); });

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('falls back to defaults when config is empty', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.pollMs).to.equal(3000);
            expect(ar.confirmations).to.equal(3);
        }); }); });

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('sets identity to null when hub has no getIdentity', function () {
            let hub = makeHub();
            hub.getIdentity = undefined;
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.identity).to.be.null;
        }); }); });

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('a NEGATIVE operator knob falls back to the default instead of inverting the gate (#6175)', function () {
            // `parseInt(cfg) || DEFAULT` accepts a negative, because a negative is
            // truthy. Each of these then inverts the gate it sizes rather than merely
            // loosening it: a negative CONFIRMATIONS makes `block_index + confirmations
            // > latestBlock` false below spec §14 depth, so the hub pays for fetches on
            // reorg-able requests; a negative ROUND_TIMEOUT_MS collapses the
            // retryAfterMs floor to 5*pollMs while every round dies on the next tick.
            let warn = sinon.stub(console, 'warn');
            let hub  = makeHub({ p2pConfig: {
                ATTESTATION_POLL_MS:                '-5000',
                ATTESTATION_CONFIRMATIONS:          '-1',
                ATTESTATION_FETCH_TIMEOUT:          '-1000',
                ATTESTATION_LEADER_ROTATION_BLOCKS: '-2',
                ATTESTATION_ROUND_TIMEOUT_MS:       '-120000',
                ATTESTATION_RETRY_AFTER_MS:         '-1'
            } });
            let ar = new AttestationRound(hub, makeProviderRegistry());

            expect(ar.pollMs,         'poll cadence').to.equal(3000);
            expect(ar.confirmations,  'reorg depth').to.equal(3);
            expect(ar.fetchTimeoutMs, 'fetch budget').to.equal(20000);
            expect(ar.leaderRotationBlocks).to.be.greaterThan(0);
            // The floor still sits above the (defaulted) consensus round window rather
            // than collapsing onto 5*pollMs.
            expect(ar.retryAfterMs).to.be.greaterThan(5 * ar.pollMs);
            // The fallback is loud: a silent one is the failure mode this closes.
            expect(warn.getCalls().filter(c => String(c.args[0]).includes('is not a positive integer')).length)
                .to.be.greaterThan(0);
        }); }); });

// ── Construction ────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('constructor', function () { it('a POSITIVE operator knob is still honoured exactly (#6175)', function () {
            let hub = makeHub({ p2pConfig: {
                ATTESTATION_POLL_MS: '5000', ATTESTATION_CONFIRMATIONS: '6', ATTESTATION_FETCH_TIMEOUT: '2500'
            } });
            let ar = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.pollMs).to.equal(5000);
            expect(ar.confirmations).to.equal(6);
            expect(ar.fetchTimeoutMs).to.equal(2500);
        }); }); });
}
