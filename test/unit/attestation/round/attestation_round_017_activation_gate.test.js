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
            sinon.stub(ar, '_computeResponsibleSet').returns(
                [ME, BB, CC, DD, EE].map((pubkey, i) => ({ pubkey, hash: String(i) })));
            let consensus = makeConsensus();
            ar.setConsensus(consensus);
            return { ar, consensus };
        }

const ARMED = lssMod.ATTEST_LEADER_SILENCE_SKIP_ACTIVATION.testnet;

// Request at R, confirmations 0, rotation window 2 blocks: tip R+7 is
            // step 3, the bare ladder's terminal slot, and tip R+9 is a full window
            // later with the slot still unanswered.
            function gateRequest(requestBlock, rid) {
                return makeRequest({
                    request_id:     rid,
                    block_index:    requestBlock,
                    deadline_block: requestBlock + 100
                });
            }

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).



        // ── the skip's activation gate ───────────────────────────────────────
        //
        // Why the skip needs a height at all: a hub that can skip and a hub that
        // cannot elect DIFFERENT leaders for the same request, and a round whose
        // members disagree about the leader has no leader proposal to take its
        // canonical effective_time from, so it times out on every retry. Under one
        // height the whole fleet changes leader arithmetic on the same request,
        // whatever order the binaries land in during a roll.
        //
        // Both cases run on testnet with zero-conf already active at the request
        // block, so the effective confirmation count is 0 on both sides of the
        // height and the two ladders differ only in the skip.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() silent-slot leader skip (P60)', function () { describe('activation gate', function () { it('holds the frozen slot for a request admitted below the height', async function () {
                let { ar, consensus } = setup('testnet');
                let below = ARMED - 1;
                let warn  = sinon.spy(console, 'warn');

                await ar._startRound(gateRequest(below, 'ridgatelo'), below + 7);
                expect(consensus.propose.lastCall.args[1].leaderPubkey, 'step 3 seats the capped slot').to.equal(DD);

                await ar._startRound(gateRequest(below, 'ridgatelo'), below + 9);
                expect(consensus.propose.lastCall.args[1].leaderPubkey,
                    'the pre-skip ladder freezes on the mute slot').to.equal(DD);

                // Nothing about the skip path ran: no observation was recorded and
                // no skip line was printed, so a peer on the pre-skip build reaches
                // the same slot from the same request.
                expect(ar.leaderSilence.has('ridgatelo')).to.be.false;
                expect(warn.getCalls().map(c => String(c.args[0]))
                    .filter(s => s.indexOf('skipped for') !== -1)).to.have.lengthOf(0);
            }); }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).



        // ── the skip's activation gate ───────────────────────────────────────
        //
        // Why the skip needs a height at all: a hub that can skip and a hub that
        // cannot elect DIFFERENT leaders for the same request, and a round whose
        // members disagree about the leader has no leader proposal to take its
        // canonical effective_time from, so it times out on every retry. Under one
        // height the whole fleet changes leader arithmetic on the same request,
        // whatever order the binaries land in during a roll.
        //
        // Both cases run on testnet with zero-conf already active at the request
        // block, so the effective confirmation count is 0 on both sides of the
        // height and the two ladders differ only in the skip.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() silent-slot leader skip (P60)', function () { describe('activation gate', function () { it('skips to the next live slot for a request admitted at the height', async function () {
                let { ar, consensus } = setup('testnet');

                await ar._startRound(gateRequest(ARMED, 'ridgatehi'), ARMED + 7);
                expect(consensus.propose.lastCall.args[1].leaderPubkey).to.equal(DD);

                await ar._startRound(gateRequest(ARMED, 'ridgatehi'), ARMED + 9);
                expect(consensus.propose.lastCall.args[1].leaderPubkey).to.equal(EE);
                expect(ar.leaderSilence.get('ridgatehi').silent.has(DD)).to.be.true;
            }); }); }); });

// ── silent-slot leader skip (ledger P60) ─────────────────────────────────
    //
    // The live defect: the ladder caps at MAX_LEADER_ROTATIONS and never wraps,
    // so a request at block R froze at slot 3 from R+9 onward. With a mute member
    // in that slot no PROPOSE ever established the round's canonical stamp and
    // every retry timed out (testnet4 request 233, 28 consecutive rounds).



        // ── the skip's activation gate ───────────────────────────────────────
        //
        // Why the skip needs a height at all: a hub that can skip and a hub that
        // cannot elect DIFFERENT leaders for the same request, and a round whose
        // members disagree about the leader has no leader proposal to take its
        // canonical effective_time from, so it times out on every retry. Under one
        // height the whole fleet changes leader arithmetic on the same request,
        // whatever order the binaries land in during a roll.
        //
        // Both cases run on testnet with zero-conf already active at the request
        // block, so the effective confirmation count is 0 on both sides of the
        // height and the two ladders differ only in the skip.
describe('AttestationRound', function () { beforeEach(hookAt3853); afterEach(hookAt3913); describe('_startRound() silent-slot leader skip (P60)', function () { describe('activation gate', function () { it('reads the per-network table the fleet flips on', function () {
                expect(lssMod.isLeaderSilenceSkipActive(ARMED - 1, 'testnet')).to.be.false;
                expect(lssMod.isLeaderSilenceSkipActive(ARMED, 'testnet')).to.be.true;
                expect(lssMod.isLeaderSilenceSkipActive(ARMED + 1, 'testnet')).to.be.true;

                // mainnet carries the unratified sentinel, which must read as OFF at
                // every height rather than coercing `blk >= null` into `blk >= 0`.
                expect(lssMod.ATTEST_LEADER_SILENCE_SKIP_ACTIVATION.mainnet).to.equal(null);
                expect(lssMod.isLeaderSilenceSkipActive(0, 'mainnet')).to.be.false;
                expect(lssMod.isLeaderSilenceSkipActive(9999999, 'mainnet')).to.be.false;

                expect(lssMod.ATTEST_LEADER_SILENCE_SKIP_ACTIVATION.regtest).to.equal(0);
                expect(lssMod.isLeaderSilenceSkipActive(0, 'regtest')).to.be.true;

                // A network with no entry is a misconfiguration, not a posture.
                expect(lssMod.isLeaderSilenceSkipActive(9999999, 'signet')).to.be.false;
                expect(lssMod.isLeaderSilenceSkipActive(9999999, undefined)).to.be.false;

                // An unusable height never arms the skip either.
                expect(lssMod.isLeaderSilenceSkipActive(NaN, 'regtest')).to.be.false;
                expect(lssMod.isLeaderSilenceSkipActive(null, 'regtest')).to.be.false;
            }); }); }); });
}
