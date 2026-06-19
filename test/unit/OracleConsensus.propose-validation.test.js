'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: followers must content-validate a leader's proposed prices before co-signing
// (leadership rotates round-robin, so a Byzantine/feed-broken validator gets leader turns), plus the
// minSubmissions diversity floor and the finalized-round mirror broadcast.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub }       = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('OracleConsensus: follower price validation / minSubmissions / broadcast', function () {
    let hub, pm, oc, oracleRound, leader;
    const ROUND = 1;                               // must be truthy (_handlePropose: `if (!round) return`)

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();          // size 0 → _isKnownSender accepts any sender
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc._getLeader(ROUND);             // this round's deterministic leader
        // This hub is a follower; pick a validator that is NOT the round leader.
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        // This follower's own locally-observed price for BTC/USD is 100000.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
    });

    afterEach(function () { sinon.restore(); });

    function proposeEnvelope(prices, round = ROUND) {
        return { sender: leader.addr, data: {
            round, prices, digest: oc._digest(round, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } };
    }

    it('rejects (no sign/PREPARE) a proposed price outside the slash deviation band', async function () {
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '200000' }])); // +100% vs local 100000
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('rejects a proposed price at/above PRICE_MAX', async function () {
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate → only the PRICE_MAX bound applies
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/KRW', price: '20000000000' }])); // 2e10 > PRICE_MAX (1e10)
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
    });

    it('PRICE_MAX clears a realistic high-fiat pair (BTC/KRW) that the old 1e7 cap dropped', async function () {
        // Regression guard for the silent-drop bug: BTC/KRW at ~$100k BTC and ~1,350 KRW/USD
        // is ~1.35e8 KRW and scales with the BTC price. The bound must clear that with headroom,
        // so a future lowering of PRICE_MAX cannot silently start dropping the pair again.
        const { PRICE_MAX } = require('../../src/constants');
        expect(PRICE_MAX).to.be.greaterThan(1.35e8);
        oracleRound.getSubmissions.returns(new Map()); // bound-only (no local aggregate to deviate against)
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/KRW', price: '135000000' }])); // 1.35e8, realistic
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('accepts a proposed price within the deviation band', async function () {
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '102000' }])); // +2% vs local
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('accepts (bound-only) when this hub has no local submission for the pair', async function () {
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate → only PRICE_MAX bound applies
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('minSubmissions defaults to a 2-hub diversity floor', function () {
        let saved = process.env.ORACLE_MIN_SUBMISSIONS;
        delete process.env.ORACLE_MIN_SUBMISSIONS;
        let oc2 = new OracleConsensus(hub, oracleRound);
        expect(oc2.minSubmissions).to.equal(2);
        if (saved !== undefined) process.env.ORACLE_MIN_SUBMISSIONS = saved;
    });

    it('_storeSnapshot broadcasts each finalized row to hub-DB mirror subscribers', async function () {
        hub.hubDbBroadcaster = { broadcastRow: sinon.stub() };
        hub.db.doQuery.callsFake(async (sql) => {
            if (/SELECT \* FROM price_snapshots/i.test(sql)) return [{ round_number: 1, coin_pair: 'BTC/USD', price: '100000' }];
            return [];
        });
        await oc._storeSnapshot(1, [{ coinPair: 'BTC/USD', price: '100000' }], 3, 'proof', 100, 1700000000);
        expect(hub.hubDbBroadcaster.broadcastRow.calledOnce).to.be.true;
        expect(hub.hubDbBroadcaster.broadcastRow.firstCall.args[0].table).to.equal('price_snapshots');
    });

    // #3707: a finalized round must be written atomically (one statement) so a
    // getfeequote / getpricesnapshots reader can never observe a torn round.
    it('_storeSnapshot writes the whole round in a single multi-row INSERT (atomic)', async function () {
        let insertCalls = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO price_snapshots/i.test(sql)) { insertCalls.push({ sql, params }); return {}; }
            return [];
        });
        await oc._storeSnapshot(1, [
            { coinPair: 'BTC/USD', price: '100000' },
            { coinPair: 'XCHAIN/USD', price: '0.50000000' }
        ], 3, 'proof', 100, 1700000000);
        expect(insertCalls).to.have.length(1);                                  // ONE statement, not one-per-pair
        expect((insertCalls[0].sql.match(/\(\?, \?, \?/g) || []).length).to.equal(2); // two value tuples
        expect(insertCalls[0].sql).to.match(/ON DUPLICATE KEY UPDATE/);
    });

    // #3955: a withheld co-sign emits an observability signal so a feed-disagreement
    // timeout is distinguishable from a leader crash.
    it('emits oracle:propose-rejected when a proposed price is withheld', async function () {
        let events = [];
        oc.on('oracle:propose-rejected', e => events.push(e));
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '200000' }])); // +100% vs local 100000
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(events).to.have.length(1);
        expect(events[0].reason).to.equal('deviation');
        expect(events[0].coinPair).to.equal('BTC/USD');
        expect(events[0].round).to.equal(ROUND);
    });
});
