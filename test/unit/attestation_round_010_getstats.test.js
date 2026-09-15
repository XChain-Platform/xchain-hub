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

// ── getStats ────────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('getStats()', function () { it('returns zeroed counters when nothing has been seen', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            let stats = ar.getStats();
            expect(stats.seen_count).to.equal(0);
            expect(stats.proposed_count).to.equal(0);
            expect(stats.failed_count).to.equal(0);
        }); }); });

// ── getStats ────────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('getStats()', function () { it('counts proposed vs failed rounds correctly', function () {
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
        }); }); });

// ── getStats ────────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('getStats()', function () { it('surfaces consensus round timeouts separately from local fetch failures (item 8c1148c0)', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            // No consensus wired: the field is absent, so an older-hub consumer
            // reads undefined rather than a misleading zero.
            expect(ar.getStats().consensus_timeout_count).to.equal(undefined);
            ar.setConsensus({
                nonOkPublished:                 new Map(),
                nonOkPublishedMax:              64,
                nonOkEvictedWhilePendingCount:  0,
                // The ok-ring counterparts getStats now reads alongside the nonOk
                // three; a real AttestationConsensus always carries them.
                finalized:                      new Set(),
                finalizedMax:                   10000,
                finalizedEvictedWhilePendingCount: 0,
                roundTimeoutCount:              4
            });
            // Quorum loss must NOT be folded into failed_count: failed_count is a
            // gauge over the TTL-evicting rounds map, so a combined number would
            // let an eviction cancel a timeout out of a consumer's rise check.
            let stats = ar.getStats();
            expect(stats.consensus_timeout_count).to.equal(4);
            expect(stats.failed_count).to.equal(0);
        }); }); });

// ── getStats ────────────────────────────────────────────────────────────
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('getStats()', function () { it('surfaces ok-ring occupancy and premature evictions, not just the nonOk ring', function () {
            let hub = makeHub();
            let ar  = new AttestationRound(hub, makeProviderRegistry());
            // Absent without a consensus, same as the nonOk and timeout fields.
            expect(ar.getStats().finalized_count).to.equal(undefined);
            ar.setConsensus({
                nonOkPublished:                 new Map(),
                nonOkPublishedMax:              64,
                nonOkEvictedWhilePendingCount:  0,
                finalized:                      new Set(['a', 'b']),
                finalizedMax:                   7,
                finalizedEvictedWhilePendingCount: 2,
                roundTimeoutCount:              0
            });
            let stats = ar.getStats();
            // Occupancy against the cap is how close the ring is to evicting; the
            // count is why an undersized cap is no longer a silent fee burn.
            expect(stats.finalized_count).to.equal(2);
            expect(stats.finalized_max).to.equal(7);
            expect(stats.finalized_evicted_while_pending_count).to.equal(2);
        }); }); });
}
