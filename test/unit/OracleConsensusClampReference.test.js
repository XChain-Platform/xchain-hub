'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: the aggregation clamp and the no-local-submission co-sign band
// both measure against the last FINALIZED price. The timed reseed bounds how stale
// that reference gets by each hub's own wall clock, which leaves every hub on its
// own schedule: two hubs can judge one PROPOSE against references from different
// rounds and co-sign differently. The reference must be a function of what
// price_snapshots holds at the round being judged, not of when a process booted.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const bcmath          = require('../../src/bcmath');
const { ORACLE_MAX_CHANGE_PER_ROUND } = require('../../src/constants');
const { createMockHub } = require('../helpers/mockHub');
const { buildSubmissions, VALIDATORS_3, makeCapabilitySnapshotStub } = require('../helpers/fixtures');
const ocrMod          = require('../../src/oracle_clamp_reference_activation.js');

const ARMED = ocrMod.ORACLE_CLAMP_REFERENCE_ACTIVATION.testnet;

// Both sides of the divergence the gate switches between, derived from the two
// candidate references rather than hardcoded, so a change to the per-round bound
// moves them together.
function clampedFrom(reference) {
    return bcmath.bcformat(
        bcmath.bcadd(reference,
            bcmath.bcmul(reference, String(ORACLE_MAX_CHANGE_PER_ROUND), 8), 8), 8);
}
const ALIGNED = clampedFrom('200.00000000');   // 250.00000000, the round-100 reference
const STALE   = clampedFrom('100.00000000');   // 125.00000000, the round-99 reference

describe('OracleConsensus: the clamp reference is aligned to the round being judged', function () {
    let hub, oc, oracleRound;

    // price_snapshots row shape the seed query returns.
    function row(coinPair, price, roundNumber) {
        return { coin_pair: coinPair, price: price, round_number: roundNumber };
    }

    beforeEach(function () {
        hub = createMockHub();
        hub.network = 'regtest';
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
    });

    afterEach(function () { sinon.restore(); });

    // Round 99 seeded and stored locally, round 100 finalized by the federation
    // without this hub storing it (the row is in price_snapshots but never went
    // through _storeSnapshot), round 101 a runaway aggregate the clamp must bind.
    // Returns the price round 101 stored.
    async function runStraddledRound(network, btcBlockHeight) {
        hub.network = network;
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);
        await oc._seedLastFinalizedPrices();
        expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        expect(oc._lastFinalizedRoundFor('BTC/USD')).to.equal(99);

        hub.db.doQuery.resolves([row('BTC/USD', '200.00000000', 100)]);
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: 'ws://validator-1:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] },
            { sender: 'ws://validator-2:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] }
        ]));
        const store = sinon.stub(oc, '_storeSnapshot').resolves();

        await oc.finalizeRound(101, btcBlockHeight, 1700000000);

        expect(store.calledOnce, 'round 101 stored').to.be.true;
        return store.firstCall.args[1].find(p => p.coinPair === 'BTC/USD').price;
    }

    it('re-reads the reference when the hub sat out the round the federation finalized', async function () {
        const price = await runStraddledRound('testnet', ARMED);

        expect(price, 'clamped against the round-100 price, not the round-99 one').to.equal(ALIGNED);
        expect(oc._lastFinalizedRoundFor('BTC/USD')).to.equal(100);
    });

    it('takes the aligned path on a regtest hub, which is armed at genesis', async function () {
        const price = await runStraddledRound('regtest', 0);

        expect(price).to.equal(ALIGNED);
        expect(oc._lastFinalizedRoundFor('BTC/USD')).to.equal(100);
    });

    // The negative control. This is the pre-alignment behaviour the fleet still runs
    // below the height, and it is the divergence the gate exists to schedule: an
    // identical submission set emits half the price an aligned hub emits.
    it('keeps the stale timer-only reference one block below the height', async function () {
        const price = await runStraddledRound('testnet', ARMED - 1);

        expect(price, 'the round-99 reference still bounds the aggregate').to.equal(STALE);
        expect(price).to.not.equal(ALIGNED);
        expect(oc._lastFinalizedRoundFor('BTC/USD'), 'no round-aligned re-read ran').to.equal(99);
    });

    it('keeps the stale timer-only reference on unratified mainnet at any height', async function () {
        const price = await runStraddledRound('mainnet', 9999999);

        expect(price).to.equal(STALE);
        expect(oc._lastFinalizedRoundFor('BTC/USD')).to.equal(99);
    });

    it('issues no query on the common path where the hub already holds the previous round', async function () {
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 100)]);
        await oc._seedLastFinalizedPrices();
        hub.db.doQuery.resetHistory();

        await oc._refreshLastFinalizedForRound(101);

        expect(hub.db.doQuery.called, 'a current reference must not cost a read').to.be.false;
    });

    it('re-reads at most once per round when the database itself is behind', async function () {
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 50)]);
        await oc._seedLastFinalizedPrices();
        hub.db.doQuery.resetHistory();

        await oc._refreshLastFinalizedForRound(101);
        await oc._refreshLastFinalizedForRound(101);
        await oc._refreshLastFinalizedForRound(101);

        expect(hub.db.doQuery.callCount, 'one attempt per round, not one per PROPOSE').to.equal(1);
    });

    it('counts a reference that is still behind after the re-read', async function () {
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 50)]);
        await oc._seedLastFinalizedPrices();

        await oc._refreshLastFinalizedForRound(101);

        expect(oc._staleClampReference, 'this hub never received round 100').to.equal(1);
    });

    it('a rejected query keeps the previous reference and never throws into consensus', async function () {
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);
        await oc._seedLastFinalizedPrices();

        hub.db.doQuery.rejects(new Error('replica mid-restore'));
        await oc._refreshLastFinalizedForRound(101);

        expect(oc._getLastFinalizedPrice('BTC/USD'), 'reference survives a failed read').to.equal('100.00000000');
    });

    it('an empty result set does not clear the reference', async function () {
        // An absent reference means NO clamp at all, so an unbounded aggregate is
        // worse than a stale bound: a truncated read must never drop a pair.
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);
        await oc._seedLastFinalizedPrices();

        hub.db.doQuery.resolves([]);
        await oc._refreshLastFinalizedForRound(101);

        expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
    });

    it('reports the highest cached round, which is what "behind" is measured against', async function () {
        hub.db.doQuery.resolves([
            row('BTC/USD', '100.00000000', 98),
            row('LTC/USD', '50.00000000', 101)
        ]);
        await oc._seedLastFinalizedPrices();

        expect(oc._maxCachedFinalizedRound()).to.equal(101);
    });

    it('treats an empty cache as no position rather than round zero', async function () {
        expect(oc._maxCachedFinalizedRound(), 'a cold cache is null, not 0').to.equal(null);
    });
});

// The second call site. finalizeRound decides what a leader emits; this one decides
// what a follower will co-sign, so both have to flip on the same height or the two
// halves of one round are judged against different references.
describe('OracleConsensus: the propose-side clamp reference honours the same height', function () {
    let hub, pm, oc, oracleRound, leader, refresh;
    const ROUND = 1;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();          // size 0, so _isKnownSender accepts any sender
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc._getLeader(ROUND);
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        refresh = sinon.spy(oc, '_refreshLastFinalizedForRound');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
    });

    afterEach(function () { sinon.restore(); });

    function propose(btcBlockHeight) {
        const prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight, btcBlockTime: 1700000000
        } };
    }

    it('aligns the reference for a PROPOSE at the height', async function () {
        hub.network = 'testnet';
        await oc._handlePropose(propose(ARMED));
        expect(refresh.calledOnceWithExactly(ROUND)).to.be.true;
    });

    it('aligns it on regtest, which is armed at genesis', async function () {
        hub.network = 'regtest';
        await oc._handlePropose(propose(0));
        expect(refresh.calledOnceWithExactly(ROUND)).to.be.true;
    });

    it('does not touch the reference one block below the height', async function () {
        hub.network = 'testnet';
        await oc._handlePropose(propose(ARMED - 1));
        expect(refresh.called, 'the pre-alignment path reads nothing per round').to.be.false;
    });

    it('does not touch the reference on unratified mainnet', async function () {
        hub.network = 'mainnet';
        await oc._handlePropose(propose(9999999));
        expect(refresh.called).to.be.false;
    });
});
