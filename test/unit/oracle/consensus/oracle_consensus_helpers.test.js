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


        const ValidatorIdentity = require('../../../../src/validators/identity');

function registerOracleconsensus1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        // A real federated hub always resolves a BTC tip of its own, and the follower
        // now bounds the leader-supplied btcBlockHeight against it before that height
        // can pick the snapshot, the leader or the quorum mode. Same height the honest
        // PROPOSEs in this file carry, so an in-lockstep round is modelled.
        hub.resolveBtcLatestBlock = sinon.stub().resolves(900000);
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

function registerFinalizeroundDispatchAdditionalPaths2Tests1() {
        it('skips a round below the minimum submission threshold', async function () {
            oc.minSubmissions = 3;
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]));
            let store = sinon.stub(oc, 'storeSkippedRound').resolves();
            await oc.finalizeRound(5, 800000, 1700000000);
            expect(store.calledOnce).to.be.true;
            expect(store.getCall(0).args[3]).to.include('below minimum');
        });

        it('_handleMessage routes PROPOSE / PREPARE / COMMIT and ignores unknown', function () {
            let prop = sinon.stub(oc, '_handlePropose').resolves();
            let prep = sinon.spy(oc, 'handlePrepare');
            let com  = sinon.spy(oc, '_handleCommit');
            oc._handleMessage({ type: 'ORACLE_PROPOSE', data: { round: 1 } });
            oc._handleMessage({ type: 'ORACLE_PREPARE', data: { round: 1, digest: 'd' } });
            oc._handleMessage({ type: 'ORACLE_COMMIT',  data: { round: 1, digest: 'd' } });
            expect(() => oc._handleMessage({ type: 'X', data: {} })).to.not.throw();
            expect(prop.calledOnce).to.be.true;
            expect(prep.calledOnce).to.be.true;
            expect(com.calledOnce).to.be.true;
        });

        it('proposeRound stores a skipped round when aggregation yields no prices', function () {
            let store = sinon.stub(oc, 'storeSkippedRound').resolves();
            oc.proposeRound(5, new Map(), false, 800000, 1700000000, null, 1);
            expect(store.calledOnce).to.be.true;
            expect(store.getCall(0).args[3]).to.include('aggregation');
        });

        it('proposeRound arms a finalization timeout that drops a stalled round', function () {
            let clock = sinon.useFakeTimers();
            oc.finalizationTimeout = 1000;
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let subs = buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            oc.proposeRound(7, subs, false, 800000, 1700000000, null, 3); // quorum 3 → stays pending
            expect(oc.pendingRounds.has(7)).to.be.true;
            clock.tick(1001);
            expect(oc.pendingRounds.has(7)).to.be.false;
            clock.restore();
        });
}

function registerFinalizeroundDispatchAdditionalPaths2Tests5() {

        it('leader-path finalization timeout counts in _roundTimeouts and skips no round (reviews 1468/1469)', function () {
            let clock = sinon.useFakeTimers();
            let store = sinon.stub(oc, 'storeSkippedRound').resolves();
            oc.finalizationTimeout = 1000;
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let subs = buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            expect(oc._roundTimeouts).to.equal(0); // constructor-initialized
            oc.proposeRound(8, subs, false, 800000, 1700000000, null, 3);
            clock.tick(1001);
            expect(oc._roundTimeouts).to.equal(1);
            // Symmetric COUNTING only: a leader timeout must not mark the round
            // finalized/skipped, or a late-arriving quorum would be refused.
            expect(store.called).to.be.false;
            expect(oc.finalized.has(8)).to.be.false;
            clock.restore();
        });

        it('leader-path finalization timeout does not count a round that finalized in time', function () {
            let clock = sinon.useFakeTimers();
            oc.finalizationTimeout = 1000;
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let subs = buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            oc.proposeRound(9, subs, false, 800000, 1700000000, null, 3);
            oc.pendingRounds.get(9).finalized = true;
            clock.tick(1001);
            expect(oc._roundTimeouts).to.equal(0);
            clock.restore();
        });

}

function registerPriceV0SignatureHelpers3Tests7() {

        it('buildPriceV0Payload sorts pairs canonically', function () {
            let payload = oc.buildPriceV0Payload(5, 1700000000, [
                { coinPair: 'LTC/USD', price: '80' },
                { coinPair: 'BTC/USD', price: '100000' }
            ]);
            let obj = JSON.parse(payload);
            expect(obj.round).to.equal(5);
            expect(obj.pairs.map(p => p.pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
        });

        it('buildPriceV0Payload keeps both entries when pair names are equal', function () {
            let payload = oc.buildPriceV0Payload(1, 1, [
                { coinPair: 'BTC/USD', price: '1' },
                { coinPair: 'BTC/USD', price: '2' }
            ]);
            expect(JSON.parse(payload).pairs).to.have.length(2);
        });

        it('signPriceV0 returns null when no identity is configured', function () {
            hub.getIdentity.returns(null);
            expect(oc.signPriceV0(5, 1700000000, [{ coinPair: 'BTC/USD', price: '1' }])).to.be.null;
        });

        it('signPriceV0 returns null (not throw) when signing fails', function () {
            hub.getIdentity.returns({ sign: () => { throw new Error('hsm offline'); }, getPubkeyHex: () => 'aa'.repeat(32) });
            expect(oc.signPriceV0(5, 1700000000, [{ coinPair: 'BTC/USD', price: '1' }])).to.be.null;
        });

        it('verifyAndStoreSig rejects missing args / duplicate / round-less pending', function () {
            expect(oc.verifyAndStoreSig(null, 'pk', 'sig')).to.be.false;
            expect(oc.verifyAndStoreSig({ round: 1, signatures: new Map() }, null, 'sig')).to.be.false;
            expect(oc.verifyAndStoreSig({ round: 1, signatures: new Map() }, 'pk', null)).to.be.false;
            expect(oc.verifyAndStoreSig({ round: 1, signatures: new Map([['pk', 'x']]) }, 'pk', 'sig')).to.be.false;
            expect(oc.verifyAndStoreSig({ signatures: new Map() }, 'pk', 'sig')).to.be.false; // no round
        });

        it('verifyAndStoreSig stores a valid signature and rejects an invalid one', function () {
            let id = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            // #4232: the height is part of the signed payload and the verify reconstruction
            // reads it from pending.btcBlockHeight, so both must carry the same value.
            let payload = oc.buildPriceV0Payload(5, 1700000000, prices, 799000);
            let sig = id.sign(payload);

            let pending = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: 799000, prices, signatures: new Map() };
            expect(oc.verifyAndStoreSig(pending, id.getPubkeyHex(), sig)).to.be.true;
            expect(pending.signatures.has(id.getPubkeyHex())).to.be.true;

            let pending2 = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: 799000, prices, signatures: new Map() };
            expect(oc.verifyAndStoreSig(pending2, id.getPubkeyHex(), 'ff'.repeat(64))).to.be.false;
        });
}

function registerPriceV0SignatureHelpers3Tests13() {

        it('verifyAndStoreSig keys the map on lowercase hex, so a mixed-case repeat dedupes (item 5334)', function () {
            let id = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let payload = oc.buildPriceV0Payload(5, 1700000000, prices, 799000);
            let sig = id.sign(payload);
            let pending = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: 799000, prices, signatures: new Map() };

            // Uppercase hex verifies (hex decode is case-insensitive) and lands lowercase.
            expect(oc.verifyAndStoreSig(pending, id.getPubkeyHex().toUpperCase(), sig)).to.be.true;
            expect([...pending.signatures.keys()]).to.deep.equal([id.getPubkeyHex()]);

            // The same key in the other casing is a duplicate, not a second sigsArray entry.
            expect(oc.verifyAndStoreSig(pending, id.getPubkeyHex(), sig)).to.be.false;
            expect(pending.signatures.size).to.equal(1);
        });

}

function registerRoundTrackingUtilities4Tests14() {
        it('markRoundReady records a new round and evicts stale entries', function () {
            oc.finalizationTimeout = 1000;
            oc.leaderTimeout = 1000; // ttl = 1000*2 + 1000 = 3000
            oc.roundReadyAt.set(99, Date.now() - 10000); // stale
            oc.markRoundReady(5);
            expect(oc.roundReadyAt.has(99)).to.be.false;
            expect(oc.roundReadyAt.has(5)).to.be.true;
        });

        it('clearRoundTracking drops the round-ready entry and clears any leader timer', function () {
            oc.roundReadyAt.set(5, Date.now());
            oc.leaderTimers.set(5, setTimeout(() => {}, 60000));
            oc.clearRoundTracking(5);
            expect(oc.roundReadyAt.has(5)).to.be.false;
            expect(oc.leaderTimers.has(5)).to.be.false;
        });

}

function registerMarkfinalizedBoundedFinalizedSet5Tests16() {

        it('caps the finalized set at finalizedMax, evicting oldest rounds first', function () {
            oc.finalizedMax = 4;
            for (let r = 1; r <= 20; r++) oc.markFinalized(r);
            expect(oc.finalized.size).to.equal(4);
            expect(oc.finalized.has(1)).to.be.false;
            expect(oc.finalized.has(16)).to.be.false;
            expect(oc.finalized.has(17)).to.be.true;
            expect(oc.finalized.has(20)).to.be.true;
        });

        it('is idempotent for a repeated round', function () {
            oc.finalizedMax = 3;
            oc.markFinalized(9);
            oc.markFinalized(9);
            expect(oc.finalized.size).to.equal(1);
            expect(oc._finalizedOrder).to.deep.equal([9]);
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // finalizeRound(): below-minimum + dispatch + empty aggregation
    // -----------------------------------------------------------------
    describe('finalizeRound() / dispatch: additional paths', function () {
        registerFinalizeroundDispatchAdditionalPaths2Tests1();
        registerFinalizeroundDispatchAdditionalPaths2Tests5();
    });



    // -----------------------------------------------------------------
    // PRICE v0 signing + verification
    // -----------------------------------------------------------------
    describe('PRICE v0 signature helpers', function () {
        registerPriceV0SignatureHelpers3Tests7();
        registerPriceV0SignatureHelpers3Tests13();
    });



    // -----------------------------------------------------------------
    // Round-tracking utilities
    // -----------------------------------------------------------------
    describe('round-tracking utilities', function () {
        registerRoundTrackingUtilities4Tests14();
    });



    // -----------------------------------------------------------------
    // markFinalized() bounded FIFO (L1)
    // -----------------------------------------------------------------
    describe('markFinalized (bounded finalized set)', function () {
        registerMarkfinalizedBoundedFinalizedSet5Tests16();
    });
});
