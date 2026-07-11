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
const PriceFetcher     = require('../../src/PriceFetcher');
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
        // Pin the configured pair set to exactly the finalized pairs so the
        // per-pair skip-marker write (item #180, covered below) stays quiet here.
        sinon.stub(PriceFetcher, 'getCoinPairs').returns(['BTC/USD', 'XCHAIN/USD']);
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

    // Item #180: a pair that drops out of an otherwise-finalizing round must leave
    // a durable per-pair 'skipped' snapshot row (before this, it got neither a
    // finalized nor a skipped row and consumers silently fell back a round).
    it('_storeSnapshot records durable per-pair skipped rows for configured pairs missing from the round', async function () {
        sinon.stub(PriceFetcher, 'getCoinPairs').returns(['BTC/USD', 'XCHAIN/USD', 'LTC/USD']);
        let insertCalls = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO price_snapshots/i.test(sql)) { insertCalls.push({ sql, params }); return {}; }
            return [];
        });
        await oc._storeSnapshot(7, [
            { coinPair: 'BTC/USD', price: '100000' },
            { coinPair: 'XCHAIN/USD', price: '0.50000000' }
        ], 3, 'proof', 100, 1700000000);
        expect(insertCalls).to.have.length(2);                                  // finalized statement + skip-marker statement
        let skip = insertCalls[1];
        expect(skip.sql).to.include("'skipped'");
        expect(skip.sql).to.match(/ON DUPLICATE KEY UPDATE/);                   // never demotes a finalized row
        expect(skip.sql).to.match(/IF\(status = 'skipped'/);
        expect(skip.params).to.deep.equal([7, 'LTC/USD', 100, 1700000000]);     // only the dropped pair, same round refs
    });

    it('_storeSnapshot writes no skip markers when every configured pair finalized', async function () {
        sinon.stub(PriceFetcher, 'getCoinPairs').returns(['BTC/USD']);
        let insertCalls = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO price_snapshots/i.test(sql)) { insertCalls.push({ sql, params }); return {}; }
            return [];
        });
        await oc._storeSnapshot(8, [{ coinPair: 'BTC/USD', price: '100000' }], 3, 'proof', 100, 1700000000);
        expect(insertCalls).to.have.length(1);
        expect(insertCalls[0].sql).to.include("'finalized'");
    });

    // #1452: the co-sign gate must reject any proposed pair outside the canonical
    // whitelist (the SAME set ingest enforces via OracleRound.canonicalPairs). A
    // fabricated pair has no live local aggregate and no finalized history, so both
    // deviation gates are absent and it would otherwise finalize on the PRICE_MAX
    // bound alone - a single Byzantine leader price-injection path.
    it('rejects (no sign/PREPARE) a proposal carrying a non-canonical pair', async function () {
        oracleRound.canonicalPairs = new Set(['BTC/USD', 'XCHAIN/USD']);
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate: only bound + whitelist apply
        // Honest aggregate for a canonical pair PLUS one fabricated pair the fetcher never serves.
        await oc._handlePropose(proposeEnvelope([
            { coinPair: 'BTC/USD', price: '100000' },
            { coinPair: 'BTC/ZZZ', price: '123' }        // fabricated, in-range price
        ]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false; // withheld
        expect(pm.broadcast.called).to.be.false;
    });

    it('emits oracle:propose-rejected with reason non-canonical-pair for a fabricated pair', async function () {
        oracleRound.canonicalPairs = new Set(['BTC/USD']);
        oracleRound.getSubmissions.returns(new Map());
        let events = [];
        oc.on('oracle:propose-rejected', e => events.push(e));
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/ZZZ', price: '123' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(events).to.have.length(1);
        expect(events[0].reason).to.equal('non-canonical-pair');
        expect(events[0].coinPair).to.equal('BTC/ZZZ');
        expect(events[0].round).to.equal(ROUND);
    });

    it('accepts an all-canonical proposal when the whitelist is active (no false positives)', async function () {
        oracleRound.canonicalPairs = new Set(['BTC/USD', 'XCHAIN/USD']);
        oracleRound.getSubmissions.returns(new Map());
        await oc._handlePropose(proposeEnvelope([
            { coinPair: 'BTC/USD', price: '100000' },
            { coinPair: 'XCHAIN/USD', price: '0.50000000' }
        ]));
        expect(oc.pendingRounds.has(ROUND)).to.be.true; // co-signed
    });

    it('fails open: an empty/absent whitelist never withholds on a legitimate pair', async function () {
        // Bootstrap / misconfig: a stale-empty canonicalPairs must not make honest
        // followers withhold on real pairs (over-strict = self-inflicted liveness loss).
        oracleRound.canonicalPairs = new Set();          // size 0 -> whitelist skipped
        oracleRound.getSubmissions.returns(new Map());
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
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
