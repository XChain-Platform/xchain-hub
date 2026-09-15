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

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../src/oracle/consensus');
const swq              = require('../../../../src/stake_weighted_quorum.js');
const { createMockHub }       = require('../../../helpers/mockHub');
const { waitUntil }           = require('../../../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../../../helpers/fixtures');

const { bftQuorumOrSingle } = require('../../../../src/lib/bft_quorum.js');



    let hub, pm, oc, oracleRound;


    // The price capability snapshot a healthy indexer would return for this hub's own
    // validator set. Read at call time, not at wiring time, so a case that installs its
    // set inside the test body still gets a snapshot that matches it.
    function liveSnapshot(capability, blockIndex) {
        let vals = (oc && Array.isArray(oc.validatorSet)) ? oc.validatorSet : [];
        return {
            capability: capability,
            blockIndex: Number(blockIndex),
            count:      vals.length,
            validators: vals.map(v => ({ pubkey: v.pubkey, amount: '50000' }))
        };
    }



        // Build a well-formed PROPOSE from the deterministic leader that passes the
        // known-sender, digest, leadership, deviation and coverage gates, so the test
        // reaches the pending-round creation block where the guards live.
        function goodEnvelope(round, extra) {
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorPubkeys = new Set();   // size 0 -> _isKnownSender returns true
            let leader = VALIDATORS_3[round % 3];
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            // Local submission (from a NON-leader validator) pricing the pair at the
            // proposed value -> deviation 0 -> co-sign gate passes without a DB lookup.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_3[(round + 1) % 3].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]));
            return { type: 'ORACLE_PROPOSE', sender: leader.addr, sig_pubkey: leader.pubkey, data: Object.assign({
                round, prices, digest: oc._digest(round, prices)
            }, extra || {}) };
        }

function registerOracleconsensus1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        // A real federated hub always resolves a BTC tip of its own, and the follower
        // now bounds the leader-supplied btcBlockHeight against it before that height
        // can pick the snapshot, the leader or the quorum mode. Same height the honest
        // PROPOSEs in this file carry, so an in-lockstep round is modelled.
        hub._resolveBtcLatestBlock = sinon.stub().resolves(900000);
        pm  = hub._peerManager;
        oracleRound = {
            getSubmissions: sinon.stub().returns(new Map())
        };
        oc = new OracleConsensus(hub, oracleRound);
        // A federated hub refuses a round with no deterministic capability snapshot (it would
        // otherwise size quorum from its own live set), so the harness models one. It resolves
        // LATE, against whatever validator set the case under test installed, which is the
        // healthy federation: the snapshot IS the qualifying set, and it yields the quorum
        // the live-set fallback would yield. Cases about the snapshot itself override this
        // with their own stub.
        hub.capabilitySnapshot = {
            getSnapshot:       async (capability, blockIndex) => liveSnapshot(capability, blockIndex),
            getWeightSnapshot: async (capability, blockIndex) => liveSnapshot(capability, blockIndex),
            getQuorum:         (snapshot) => bftQuorumOrSingle(
                snapshot && Array.isArray(snapshot.validators) ? snapshot.validators.length : 0, 0)
        };
        // These cases exercise finalize/propose logic with small fixed submission sets and model a
        // configured single/small deployment, so use the regtest override (ORACLE_MIN_SUBMISSIONS=1).
        // The 2-hub default diversity floor is covered in OracleConsensus.propose-validation.test.js.
        oc.minSubmissions = 1;
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerFinalizeround2Tests1() {

        it('skips already-finalized rounds', async function () {
            oc.finalized.add(5);
            await oc.finalizeRound(5);
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('stores skipped round when no submissions', async function () {
            oracleRound.getSubmissions.returns(new Map());
            await oc.finalizeRound(5);
            expect(hub.db.doQuery.called).to.be.true;
            let firstCall = hub.db.doQuery.getCall(0);
            expect(firstCall.args[0]).to.include('skipped');
        });

        it('single-node (quorum=0) stores directly and emits event', async function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]); // N = 0 + 1 = 1 → quorum 0

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitCount = 0;
            let emitted = null;
            oc.on('round:finalized', (data) => { emitCount++; emitted = data; });

            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1);

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.round).to.equal(1);
            expect(emitted.prices[0].coinPair).to.equal('BTC/USD');

            // The round must now be marked finalized so a repeat call is a no-op
            // (guards against a duplicate snapshot store / PRICE v0 broadcast).
            await oc.finalizeRound(1);
            expect(storeSpy.callCount).to.equal(1);
            expect(emitCount).to.equal(1);
        });
}

function registerFinalizeround2Tests4() {

        it('federation with an empty price snapshot skips instead of self-finalizing', async function () {
            // Federated: 3 registered validators -> getQuorum() = 2 (> 0).
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;   // even as leader, must skip
            // Indexer returned ZERO qualifying price validators at this block.
            let emptySnap = { validators: [], count: 0 };
            hub.capabilitySnapshot = {
                getSnapshot:       sinon.stub().resolves(emptySnap),
                getWeightSnapshot: sinon.stub().resolves(emptySnap),
                getQuorum:         sinon.stub().returns(0)
            };

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitCount = 0;
            oc.on('round:finalized', () => { emitCount++; });
            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1, 900000, 1700000000);

            // Skipped, not finalized: no snapshot store, no round:finalized emit,
            // no PROPOSE broadcast, and a 'skipped' row persisted. The skip is
            // recorded as LOCALLY skipped (#7), never in `finalized` -- so a later
            // legitimate PROPOSE can still process and upgrade the round.
            expect(storeSpy.callCount).to.equal(0);
            expect(emitCount).to.equal(0);
            expect(pm.broadcast.called).to.be.false;
            expect(oc.locallySkipped.has(1)).to.be.true;
            expect(oc.finalized.has(1)).to.be.false;
            let skippedInsert = hub.db.doQuery.getCalls().some(c => /skipped/.test(String(c.args[0])));
            expect(skippedInsert).to.be.true;
        });
}

function registerFinalizeround2Tests5() {

        it('single-node with an empty snapshot still self-finalizes (bootstrap preserved)', async function () {
            // Not federated: no registered validators and no peers -> getQuorum() = 0.
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            let emptySnap = { validators: [], count: 0 };
            hub.capabilitySnapshot = {
                getSnapshot:       sinon.stub().resolves(emptySnap),
                getWeightSnapshot: sinon.stub().resolves(emptySnap),
                getQuorum:         sinon.stub().returns(0)
            };

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitCount = 0;
            let emitted = null;
            oc.on('round:finalized', (data) => { emitCount++; emitted = data; });
            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1, 900000, 1700000000);

            expect(storeSpy.callCount).to.equal(1);
            expect(emitCount).to.equal(1);
            expect(emitted.round).to.equal(1);
        });

        it('non-leader does not propose', async function () {
            oc.setValidatorSet(VALIDATORS_3);
            // Round 0 leader is VALIDATORS_3[0], but our addr is different
            pm.validatorAddr = 'ws://not-a-leader:10001';

            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);
            expect(pm.broadcast.called).to.be.false;
        });
}

function registerFinalizeround2Tests7() {

        it('leader proposes and broadcasts ORACLE_PROPOSE', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr; // Make us the leader for round 0

            // Submitters are snapshot MEMBERS: the round's quorum is sized from the
            // snapshot, so a submission from outside it is filtered before aggregation.
            let entries = [
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[2].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);

            // First broadcast should be ORACLE_PROPOSE
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.round).to.equal(0);
            expect(data.prices).to.be.an('array');
            expect(data.digest).to.be.a('string');

            // Clean up timer
            let pending = oc.pendingRounds.get(0);
            if (pending && pending.timer) clearTimeout(pending.timer);
        });

}

function registerHandleproposeFollowerFailClosedGuards3Tests8() {

        it('#1225: drops a PROPOSE carrying no BTC block height on a federated hub', async function () {
            // No btcBlockHeight in the envelope -> must NOT pin the price snapshot at
            // block_index = round (not a BTC boundary); federated hub drops the round.
            await oc._handlePropose(goodEnvelope(0, { /* btcBlockHeight omitted */ }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });

        it('#1225: drops a PROPOSE carrying btcBlockHeight 0 on a federated hub', async function () {
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 0 }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });

        it('#1222: drops a PROPOSE when weighted is active but the weight snapshot is empty (federated)', async function () {
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            hub.capabilitySnapshot = {
                getWeightSnapshot: sinon.stub().resolves({ validators: [] }),
                getSnapshot:       sinon.stub().resolves({ validators: [] }),
                getQuorum:         sinon.stub().returns(0)
            };
            // Real BTC height present, so the #1225 height guard passes; the #1222
            // weighted-snapshot guard must then fire and drop rather than degrade to
            // a count quorum this hub's peers are not using.
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 900000 }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });

        // Freshness bound on the leader-supplied height. #1225 closes only the
        // ABSENT-height case; an ancient but INDEXED height passes the snapshot echo
        // check and resolves a valid snapshot, so without this the proposer picks the
        // quorum denominator, the member set it is elected from, and the
        // stake-weighted-vs-count mode.
        it('drops a PROPOSE whose height sits far below our own BTC tip', async function () {
            hub.capabilitySnapshot = {
                getSnapshot:       sinon.stub().resolves({ validators: VALIDATORS_3 }),
                getWeightSnapshot: sinon.stub().resolves({ validators: VALIDATORS_3 }),
                getQuorum:         sinon.stub().returns(2)
            };
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 700000 }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
            // The attacker-chosen block never reaches the snapshot resolve, so it can
            // size no quorum and elect no leader.
            expect(hub.capabilitySnapshot.getSnapshot.called).to.equal(false);
            expect(hub.capabilitySnapshot.getWeightSnapshot.called).to.equal(false);
        });

        it('drops a PROPOSE whose height sits far above our own BTC tip', async function () {
            await oc._handlePropose(goodEnvelope(0, {
                btcBlockHeight: 900000 + oc.snapshotToleranceBlocks + 1
            }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });
}

function registerHandleproposeFollowerFailClosedGuards3Tests13() {

        it('accepts a height at the edge of the tolerance in both directions', async function () {
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 900000 - oc.snapshotToleranceBlocks }));
            expect(oc.pendingRounds.has(0)).to.equal(true);
            let p = oc.pendingRounds.get(0);
            if (p && p.timer) clearTimeout(p.timer);
            oc.pendingRounds.delete(0);

            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 900000 + oc.snapshotToleranceBlocks }));
            expect(oc.pendingRounds.has(0)).to.equal(true);
            p = oc.pendingRounds.get(0);
            if (p && p.timer) clearTimeout(p.timer);
        });

        it('fails closed when this hub cannot resolve a BTC tip of its own', async function () {
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 900000 }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });

        it('leaves a single-node hub (getQuorum() === 0) off the bound entirely', async function () {
            // Gated exactly like the #1225 guard beside it: a hub with no peers has
            // nothing to split from, so it keeps the bootstrap path and never pays a
            // tip resolve. Asserted on the resolver, which is the whole cost.
            sinon.stub(oc, 'getQuorum').returns(0);
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 700000 }));
            expect(hub._resolveBtcLatestBlock.called).to.equal(false);
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // finalizeRound()
    // -----------------------------------------------------------------
    describe('finalizeRound()', function () {
        registerFinalizeround2Tests1();
        registerFinalizeround2Tests4();
        registerFinalizeround2Tests5();
        registerFinalizeround2Tests7();
    });



    // -----------------------------------------------------------------
    // _handlePropose() follower fail-closed guards (#1222, #1225)
    // -----------------------------------------------------------------
    describe('_handlePropose() follower fail-closed guards', function () {
        registerHandleproposeFollowerFailClosedGuards3Tests8();
        registerHandleproposeFollowerFailClosedGuards3Tests13();
    });
});
