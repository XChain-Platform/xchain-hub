'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: the aggregation clamp and the no-local-submission co-sign band
// both measure against the last FINALIZED price. That reference used to be written
// only by the start-time seed and by this hub's own _storeSnapshot, so any round the
// hub sat out (a below-minimum skip, a PROPOSE-round timeout, a round pushed in from
// a source chain by PriceAggregator) left it a round behind its peers for the rest of
// the process lifetime - and a hub one round behind clamps an identical median a full
// clamp step away from the federation, far outside the co-sign deviation band. The
// reference must be a function of what price_snapshots holds at the round being
// aggregated, not of this process's own history.

const sinon             = require('sinon');
const { expect }        = require('chai');
const OracleConsensus   = require('../../src/OracleConsensus');
const bcmath            = require('../../src/bcmath');
const { ORACLE_MAX_CHANGE_PER_ROUND } = require('../../src/constants');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('OracleConsensus: last-finalized clamp reference tracks the database', function () {
    let hub, oc, oracleRound;

    // price_snapshots row shape the seed/refresh query returns.
    function row(coinPair, price, roundNumber) {
        return { coin_pair: coinPair, price: price, round_number: roundNumber };
    }

    beforeEach(function () {
        hub = createMockHub();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        sinon.stub(console, 'warn');   // clamp + stale-reference warnings are expected
        sinon.stub(console, 'log');
    });

    afterEach(function () { sinon.restore(); });

    it('re-reads the reference when the hub sat out the round the federation finalized', async function () {
        // This hub last stored round 99 and seeded from it.
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);
        await oc._seedLastFinalizedPrices();
        expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        expect(oc._getLastFinalizedRound('BTC/USD')).to.equal(99);

        // Round 100 finalized WITHOUT this hub storing it (gossip lag / push ingest),
        // so the row is in price_snapshots but never went through _storeSnapshot.
        hub.db.doQuery.resolves([row('BTC/USD', '200.00000000', 100)]);

        // Round 101: a runaway aggregate that the clamp must bind.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: 'ws://validator-1:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] },
            { sender: 'ws://validator-2:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] }
        ]));
        let store = sinon.stub(oc, '_storeSnapshot').resolves();

        await oc.finalizeRound(101, 100, 1700000000);

        expect(store.calledOnce, 'round 101 stored').to.be.true;
        let stored = store.firstCall.args[1].find(p => p.coinPair === 'BTC/USD');
        let expected = bcmath.bcformat(
            bcmath.bcadd('200.00000000', bcmath.bcmul('200.00000000', String(ORACLE_MAX_CHANGE_PER_ROUND), 8), 8), 8);
        expect(stored.price, 'clamped against the round-100 price, not the round-99 one').to.equal(expected);
        expect(oc._getLastFinalizedRound('BTC/USD')).to.equal(100);
    });

    it('_handlePropose co-signs a leader clamped to a round the follower never stored', async function () {
        let pm = hub._peerManager;
        pm.validatorPubkeys = new Set();                    // size 0 -> _isKnownSender accepts any sender
        oc.setValidatorSet(VALIDATORS_3);
        const ROUND = 101;
        let leader = oc._getLeader(ROUND);
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;

        // Follower seeded at round 99, no local submission for the pair this round, so
        // the co-sign decision rests entirely on the historical band.
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);
        await oc._seedLastFinalizedPrices();
        // The database DOES have round 100 (pushed in), which the cache never saw.
        hub.db.doQuery.resolves([row('BTC/USD', '200.00000000', 100)]);

        // The leader's honest, correctly-clamped round-101 value off the round-100 price.
        let prices = [{ coinPair: 'BTC/USD', price: '250.00000000' }];
        await oc._handlePropose({ sender: leader.addr, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } });

        expect(oc.pendingRounds.has(ROUND),
            'a refreshed follower co-signs; a stale one would reject it as +150% off 100').to.be.true;
    });

    it('issues no query on the common path where the hub stored the previous round', async function () {
        oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 100);
        hub.db.doQuery.resetHistory();

        await oc._refreshLastFinalizedPrices(101);
        expect(hub.db.doQuery.called, 'cache already at round-1: no DB round-trip').to.be.false;

        // Two rounds behind: the re-read does fire.
        await oc._refreshLastFinalizedPrices(102);
        expect(hub.db.doQuery.calledOnce).to.be.true;
    });

    it('re-reads at most once per round when the database itself is behind', async function () {
        oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 99);
        hub.db.doQuery.resolves([row('BTC/USD', '100.00000000', 99)]);   // DB never got round 100
        hub.db.doQuery.resetHistory();

        await oc._refreshLastFinalizedPrices(101);
        await oc._refreshLastFinalizedPrices(101);
        await oc._refreshLastFinalizedPrices(101);

        expect(hub.db.doQuery.calledOnce, 'one attempt per round, not one per aggregation').to.be.true;
        expect(oc._staleClampReference, 'reported, not silently absorbed').to.equal(1);
        expect(oc._getLastFinalizedPrice('BTC/USD'), 'reference retained').to.equal('100.00000000');
    });

    it('a rejected query keeps the previous reference and never throws into consensus', async function () {
        oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 99);
        hub.db.doQuery.rejects(new Error('db unreachable'));

        await oc._refreshLastFinalizedPrices(101);
        expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        expect(oc._getLastFinalizedRound('BTC/USD')).to.equal(99);

        // ...and the same through finalizeRound, which must still store the round.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: 'ws://validator-1:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] },
            { sender: 'ws://validator-2:10001', prices: [{ coinPair: 'BTC/USD', price: '999999.00000000' }] }
        ]));
        let store = sinon.stub(oc, '_storeSnapshot').resolves();
        await oc.finalizeRound(102, 100, 1700000000);
        expect(store.calledOnce, 'the round still finalizes on the stale reference').to.be.true;
        let expected = bcmath.bcformat(
            bcmath.bcadd('100.00000000', bcmath.bcmul('100.00000000', String(ORACLE_MAX_CHANGE_PER_ROUND), 8), 8), 8);
        expect(store.firstCall.args[1][0].price).to.equal(expected);
    });

    it('an empty result set does not clear the reference', async function () {
        oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 99);
        hub.db.doQuery.resolves([]);   // truncated table / replica mid-restore

        await oc._refreshLastFinalizedPrices(101);

        expect(oc._getLastFinalizedPrice('BTC/USD'),
            'an empty read must not turn a clamped pair into an unbounded aggregate').to.equal('100.00000000');
    });

    it('_storeSnapshot stamps the cache with the round it stored', async function () {
        expect(oc._getLastFinalizedRound('BTC/USD')).to.equal(null);
        oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '123.00000000' }], 500);
        expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('123.00000000');
        expect(oc._getLastFinalizedRound('BTC/USD')).to.equal(500);
        expect(oc._maxCachedFinalizedRound()).to.equal(500);
    });
});
