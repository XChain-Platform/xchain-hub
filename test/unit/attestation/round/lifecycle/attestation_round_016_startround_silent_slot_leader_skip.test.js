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

const ME = 'aa'.repeat(32);

// slot 0, this hub, proposes
        const BB = 'bb'.repeat(32);

// slot 1
        const CC = 'cc'.repeat(32);

// slot 2
        const DD = 'dd'.repeat(32);

// slot 3, the frozen slot; never proposes
        const EE = 'ee'.repeat(32);

// slot 4, live

        function makeRequest(overrides) {
            return {
                request_id:     'rid0060',
                provider_id:    'llm',
                redundancy:     2,
                // Regtest serves at the tip (zero-conf is armed there from genesis),
                // so the ladder starts at the request block itself rather than a
                // confirmation lag above it. 103 keeps every tip literal below on
                // the step it was written for.
                block_index:    103,
                action_index:   1,
                deadline_block: 200,
                payload:        JSON.stringify({ prompt: 'hi' }),
                ...overrides
            };
        }

// A consensus stand-in with the two seams AttestationRound uses: propose()
        // (which records this hub's own proposal, as the real one does) and the
        // cross-round proposer record hasProposedFor() reads.
        function makeConsensus() {
            let seen = new Map();
            return {
                proposers: seen,
                propose: sinon.stub().callsFake(async function (rid, state) {
                    if(!seen.has(rid)) seen.set(rid, new Set());
                    seen.get(rid).add(ME);
                }),
                hasProposedFor: (rid, pk) => !!(seen.get(rid) && seen.get(rid).has(pk))
            };
        }

// The skip is flag-day gated (attest_leader_silence_skip_activation.js) on
        // the request's own block_index, so a hub with no network resolves the gate
        // OFF and every case below would assert the pre-skip ladder. These cases are
        // about the skip's behaviour once it is armed, so they run on regtest, where
        // the gate is 0 and the request block used here is above it. The gate itself
        // has its own suite further down.
        function setup(network) {
            let validators = [ME, BB, CC, DD, EE].map(pubkey => ({ pubkey }));
            let capSS = {
                getSnapshot:       sinon.stub().resolves({ validators }),
                getWeightSnapshot: sinon.stub().resolves({ validators })
            };
            let hub = makeHub({ capabilitySnapshot: capSS });
            hub.network = network || 'regtest';
            hub.getIdentity = () => makeIdentity(ME);
            let reg = makeProviderRegistry({
                getModule: sinon.stub().returns({
                    fetch: sinon.stub().resolves({ body: Buffer.from('ok'), meta: 'claude-sonnet-4-6' })
                })
            });
            let ar = new AttestationRound(hub, reg);
            sinon.stub(ar, 'computeResponsibleSet').returns(
                [ME, BB, CC, DD, EE].map((pubkey, i) => ({ pubkey, hash: String(i) })));
            let consensus = makeConsensus();
            ar.setConsensus(consensus);
            return { ar, consensus };
        }

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).



        // Serviceable from block 103 (the request's own block, served at the tip),
        // rotation window 2 blocks: tip 104 is step 0, tip 110 is step 3 (the
        // capped, frozen slot).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('moves the leader past a slot that held a full window without proposing', async function () {
            let { ar, consensus } = setup();

            await ar.startRound(makeRequest(), 104);
            expect(consensus.propose.lastCall.args[1].leaderPubkey, 'step 0 leads at slot 0').to.equal(ME);

            // Step 3: the bare ladder's terminal slot. DD holds it from here.
            await ar.startRound(makeRequest(), 110);
            expect(consensus.propose.lastCall.args[1].leaderPubkey, 'step 3 seats the capped slot').to.equal(DD);

            // A full rotation window later DD still has not proposed, so the slot
            // is proven silent and the round steps over it instead of freezing.
            await ar.startRound(makeRequest(), 112);
            expect(consensus.propose.lastCall.args[1].leaderPubkey).to.equal(EE);
            expect(ar.leaderSilence.get('rid0060').silent.has(DD)).to.be.true;
        }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('never re-elects a live leader from an earlier slot', async function () {
            let { ar, consensus } = setup();
            await ar.startRound(makeRequest(), 104);   // ME leads and proposes
            await ar.startRound(makeRequest(), 110);   // DD seated
            await ar.startRound(makeRequest(), 112);   // DD proven silent -> EE
            consensus.proposers.get('rid0060').add(EE);  // EE answers, so it stays live
            await ar.startRound(makeRequest(), 118);
            await ar.startRound(makeRequest(), 124);

            for(let call of consensus.propose.getCalls().slice(2)){
                expect(call.args[1].leaderPubkey, 'rotation went backwards').to.equal(EE);
            }
            // ME is live and proposed in the first round; the skip must not make
            // it eligible again.
            expect(ar.leaderSilence.get('rid0060').silent.has(ME)).to.be.false;
        }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('does not skip a leader that proposed inside its window', async function () {
            let { ar, consensus } = setup();
            await ar.startRound(makeRequest(), 110);   // DD seated at step 3
            consensus.proposers.get('rid0060').add(DD);  // DD answers
            await ar.startRound(makeRequest(), 112);
            expect(consensus.propose.lastCall.args[1].leaderPubkey).to.equal(DD);
            expect(ar.leaderSilence.get('rid0060').silent.size).to.equal(0);
        }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('prints the EFFECTIVE slot in the round opening line', async function () {
            let { ar } = setup();
            await ar.startRound(makeRequest(), 110);
            let log = sinon.spy(console, 'log');
            await ar.startRound(makeRequest(), 112);
            let line = log.getCalls().map(c => String(c.args[0])).find(s => s.indexOf('leaderSlot=') !== -1);
            expect(line).to.be.a('string');
            expect(line).to.contain('leaderSlot=4');
        }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('logs one line naming the request, the skipped key and the slot', async function () {
            let { ar } = setup();
            await ar.startRound(makeRequest(), 110);
            let warn = sinon.spy(console, 'warn');
            await ar.startRound(makeRequest(), 112);
            let lines = warn.getCalls().map(c => String(c.args[0]))
                .filter(s => s.indexOf('leader slot 3 skipped') !== -1);
            expect(lines).to.have.lengthOf(1);
            expect(lines[0]).to.contain('rid0060');
            expect(lines[0]).to.contain(DD.substring(0, 16));
            expect(lines[0]).to.contain('no PROPOSE');
        }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('holds the last live slot, logging once, when nothing live remains ahead', async function () {
            let { ar, consensus } = setup();
            await ar.startRound(makeRequest(), 110);   // DD seated
            await ar.startRound(makeRequest(), 112);   // DD silent -> EE seated
            let warn = sinon.spy(console, 'warn');
            await ar.startRound(makeRequest(), 114);   // EE silent -> nothing ahead
            // Slot 2 (CC) is the last live slot the walk reached; the round still
            // names a leader rather than running off the end of the set.
            expect(consensus.propose.lastCall.args[1].leaderPubkey).to.equal(CC);
            expect(ar.leaderSilence.get('rid0060').silent.has(EE)).to.be.true;

            // CC then goes silent too and the ladder degrades one more slot, but
            // the "out of live slots" line is a once-per-request explanation.
            await ar.startRound(makeRequest(), 116);
            expect(consensus.propose.lastCall.args[1].leaderPubkey).to.equal(BB);
            let held = warn.getCalls().map(c => String(c.args[0]))
                .filter(s => s.indexOf('no live leader slot remains') !== -1);
            expect(held).to.have.lengthOf(1);
        }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('startRound() silent-slot leader skip (P60)', function () { it('evicts the silence record on the rounds TTL', function () {
            let { ar } = setup();
            ar.leaderSilence.set('old', { silent: new Set(), updatedAt: Date.now() - ar.roundsTtlMs - 1 });
            ar.leaderSilence.set('new', { silent: new Set(), updatedAt: Date.now() });
            ar.evictStaleLeaderSilence();
            expect(ar.leaderSilence.has('old')).to.be.false;
            expect(ar.leaderSilence.has('new')).to.be.true;
        }); }); });
}
