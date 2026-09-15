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

// ── computeResponsibleSet ───────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('computeResponsibleSet()', function () { it('returns a deterministic ordered list of the correct size', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [
                { pubkey: 'pub1' }, { pubkey: 'pub2' }, { pubkey: 'pub3' }
            ];
            let result = ar.computeResponsibleSet(validators, 'requestid123', 2);
            expect(result).to.have.length(2);
            // Each entry has pubkey and hash
            for (let v of result) {
                expect(v).to.have.property('pubkey');
                expect(v).to.have.property('hash');
            }
        }); }); });

// ── computeResponsibleSet ───────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('computeResponsibleSet()', function () { it('returns only 1 entry when redundancy=1', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [{ pubkey: 'pub1' }, { pubkey: 'pub2' }, { pubkey: 'pub3' }];
            let result = ar.computeResponsibleSet(validators, 'rid', 1);
            expect(result).to.have.length(1);
        }); }); });

// ── computeResponsibleSet ───────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('computeResponsibleSet()', function () { it('returns all when redundancy >= validators.length', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [{ pubkey: 'pub1' }, { pubkey: 'pub2' }];
            let result = ar.computeResponsibleSet(validators, 'rid', 10);
            expect(result).to.have.length(2);
        }); }); });

// ── computeResponsibleSet ───────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('computeResponsibleSet()', function () { it('produces consistent ordering across calls (deterministic)', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let validators = [
                { pubkey: 'aaa' }, { pubkey: 'bbb' }, { pubkey: 'ccc' }
            ];
            let r1 = ar.computeResponsibleSet(validators, 'fixedrid', 3);
            let r2 = ar.computeResponsibleSet(validators, 'fixedrid', 3);
            expect(r1.map(v => v.pubkey)).to.deep.equal(r2.map(v => v.pubkey));
        }); }); });

// ── computeResponsibleSet ───────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('computeResponsibleSet()', function () { it('normalises pubkeys to lowercase', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let result = ar.computeResponsibleSet([{ pubkey: 'AABBCC' }], 'rid', 1);
            expect(result[0].pubkey).to.equal('aabbcc');
        }); }); });
}
