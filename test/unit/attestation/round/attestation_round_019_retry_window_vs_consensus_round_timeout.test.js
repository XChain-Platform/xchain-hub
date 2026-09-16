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

// ── retry-window floor + live-round fetch gate (item 2358) ────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('retry window vs consensus round timeout (2358)', function () { it('floors retryAfterMs above the consensus round timeout', function () {
            // pollMs 5s -> 5*5=25s configured window, floored to 120s+5s.
            let hub = makeHub({ p2pConfig: { ATTESTATION_POLL_MS: '5000' } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.retryAfterMs).to.equal(125000);
        }); }); });

// ── retry-window floor + live-round fetch gate (item 2358) ────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('retry window vs consensus round timeout (2358)', function () { it('keeps an operator retry window that already clears the floor', function () {
            let hub = makeHub({ p2pConfig: {
                ATTESTATION_RETRY_AFTER_MS: '500000',
                ATTESTATION_ROUND_TIMEOUT_MS: '120000'
            } });
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            expect(ar.retryAfterMs).to.equal(500000);
        }); }); });

// ── retry-window floor + live-round fetch gate (item 2358) ────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('retry window vs consensus round timeout (2358)', function () { it('skips the paid fetch when a consensus round for the rid is already active', async function () {
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
            sinon.stub(ar, 'computeResponsibleSet').returns([{ pubkey: myPubkey, hash: '00' }]);
            ar.setConsensus({ isRoundActive: sinon.stub().returns(true) });
            await ar.startRound({
                request_id: 'rid0001', provider_id: 'http_get', redundancy: 1,
                block_index: 100, action_index: 1, payload: 'https://example.com/'
            });
            expect(fetchStub.called).to.be.false;
        }); }); });
}
