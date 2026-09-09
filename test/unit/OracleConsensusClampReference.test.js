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
const { buildSubmissions } = require('../helpers/fixtures');

describe('OracleConsensus: the clamp reference is aligned to the round being judged', function () {
    let hub, oc, oracleRound;

    // price_snapshots row shape the seed query returns.
    function row(coinPair, price, roundNumber) {
        return { coin_pair: coinPair, price: price, round_number: roundNumber };
    }

    beforeEach(function () {
        hub = createMockHub();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        sinon.stub(console, 'warn');
        sinon.stub(console, 'log');
    });

    afterEach(function () { sinon.restore(); });

    it('re-reads the reference when the hub sat out the round the federation finalized', async function () {
        // This hub last stored round 99 and seeded from it.
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);
        await oc._seedLastFinalizedPrices();
        expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        expect(oc._lastFinalizedRoundFor('BTC/USD')).to.equal(99);

        // Round 100 finalized WITHOUT this hub storing it, so the row is in
        // price_snapshots but never went through _storeSnapshot.
        hub.db.doQuery.resolves([row('BTC/USD', '200.00000000', 100)]);

        // Round 101: a runaway aggregate the clamp must bind.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: 'ws://validator-1:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] },
            { sender: 'ws://validator-2:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] }
        ]));
        const store = sinon.stub(oc, '_storeSnapshot').resolves();

        await oc.finalizeRound(101, 100, 1700000000);

        expect(store.calledOnce, 'round 101 stored').to.be.true;
        const stored = store.firstCall.args[1].find(p => p.coinPair === 'BTC/USD');
        const expected = bcmath.bcformat(
            bcmath.bcadd('200.00000000',
                bcmath.bcmul('200.00000000', String(ORACLE_MAX_CHANGE_PER_ROUND), 8), 8), 8);
        expect(stored.price, 'clamped against the round-100 price, not the round-99 one').to.equal(expected);
        expect(oc._lastFinalizedRoundFor('BTC/USD')).to.equal(100);
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
