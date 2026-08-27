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
        return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
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
        oc.allowUnverifiedPairs = true; // isolate the PRICE_MAX bound from the unverifiable-pair gate
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/KRW', price: '135000000' }])); // 1.35e8, realistic
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('accepts a proposed price within the deviation band', async function () {
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '102000' }])); // +2% vs local
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('accepts (bound-only) an unverifiable pair only with ORACLE_ALLOW_UNVERIFIED_PAIRS opt-in', async function () {
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate, no finalized history
        oc.allowUnverifiedPairs = true;                // deliberate single-fetcher opt-in
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('withholds co-sign on a pair with no local submission and no finalized history', async function () {
        oracleRound.getSubmissions.returns(new Map()); // nothing to verify against
        expect(oc.allowUnverifiedPairs).to.equal(false); // fail-closed default
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('a finalized-history pair still co-signs within the 5x historical band', async function () {
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100000']]); // but history exists
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '110000' }])); // +10% < 5x band
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    // #2401: the historical (no-local-submission) band is derived from
    // ORACLE_MAX_CHANGE_PER_ROUND, the SAME constant the aggregation clamp emits, so a
    // maximally-clamped aggregate always passes. Boundary is exactly that constant.
    it('#2401 historical band boundary equals ORACLE_MAX_CHANGE_PER_ROUND', async function () {
        const { ORACLE_MAX_CHANGE_PER_ROUND } = require('../../src/constants.js');
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate: historical band applies
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100000']]);
        // Exactly at the band (bcgt is strict >) -> co-signs.
        let atEdge = String(100000 * (1 + ORACLE_MAX_CHANGE_PER_ROUND));
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: atEdge }]));
        expect(oc.pendingRounds.has(ROUND), 'clamped-max move must pass').to.be.true;

        oc.pendingRounds.delete(ROUND);
        // Just beyond the band -> withheld.
        let overEdge = String(100000 * (1 + ORACLE_MAX_CHANGE_PER_ROUND) + 1);
        let events = [];
        oc.on('oracle:propose-rejected', e => events.push(e));
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: overEdge }]));
        expect(oc.pendingRounds.has(ROUND), 'beyond the band must withhold').to.be.false;
        expect(events.map(e => e.reason)).to.include('historical-deviation');
    });

    // item 4940: the gate's bound must BE the clamp's bound, not an equal-threshold
    // 18dp ratio. _clampToLastFinalized takes an 8dp ROUND_HALF_UP delta, so for a last
    // price whose quarter misses the 8dp grid the clamped hi sits a hair above
    // last*1.25 ('0.11111111' -> delta '0.02777778' -> hi '0.13888889' -> ratio
    // 0.2500000225). The ratio test rejected exactly that, so every honest follower
    // without a local submission withheld the whole round on the fat-tail move the
    // clamp exists to absorb.
    it('#4940 co-signs the maximally-clamped price when the clamp delta rounds up', async function () {
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate: historical band applies
        oc._lastFinalizedPrices = new Map([['BTC/USD', '0.11111111']]);
        // The value the clamp itself emits for a runaway aggregate on this last price.
        let clamped = String(oc._clampToLastFinalized('BTC/USD', '999'));
        expect(clamped).to.equal('0.13888889');

        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: clamped }]));
        expect(oc.pendingRounds.has(ROUND), 'a clamped aggregate must always co-sign').to.be.true;

        oc.pendingRounds.delete(ROUND);
        let events = [];
        oc.on('oracle:propose-rejected', e => events.push(e));
        // One 8dp tick beyond what the clamp can emit is still withheld.
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '0.13888890' }]));
        expect(oc.pendingRounds.has(ROUND), 'beyond the clamp bound must withhold').to.be.false;
        expect(events.map(e => e.reason)).to.include('historical-deviation');
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
        oracleRound.getSubmissions.returns(new Map());
        // Finalized history so the unverifiable-pair gate stays out of the
        // way; the whitelist behavior is the thing under test here.
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100000'], ['XCHAIN/USD', '0.50000000']]); // no local aggregate: only bound + whitelist apply
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
        // Finalized history so the unverifiable-pair gate stays out of the
        // way; the whitelist behavior is the thing under test here.
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100000'], ['XCHAIN/USD', '0.50000000']]);
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
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100000']]); // keep the unverifiable-pair gate out of the way
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

    // #2399: the deviation reference must exclude the proposer by VERIFIED PUBKEY, not
    // just by addr. One pubkey can be bound to several addrs (the registry models this),
    // so a leader can gossip its submission from addr A and PROPOSE from addr B. An
    // addr-only exclusion leaves A's price in the reference and lets a pair only the
    // leader priced self-validate at deviation 0, injecting an arbitrary value.
    describe('#2399 proposer excluded from deviation reference by pubkey', function () {
        const ALT_ADDR = 'ws://leader-alt:10001';   // second addr bound to the leader's pubkey
        const PAIR     = 'BTC/XAU';                  // canonical, leader-only, no finalized history

        beforeEach(function () {
            pm.validatorPubkeys = new Map([
                [leader.addr, leader.pubkey],
                [ALT_ADDR,    leader.pubkey]
            ]);
            oracleRound.canonicalPairs = new Set([PAIR]);
            // The only local submission for PAIR is the leader's own, recorded under its
            // alternate addr (first-arrival dedup keys it there). No honest hub priced it.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: ALT_ADDR, prices: [{ coinPair: PAIR, price: '123' }] }
            ]));
        });

        it('withholds co-sign for a leader-only pair proposed from a sibling addr', async function () {
            let events = [];
            oc.on('oracle:propose-rejected', e => events.push(e));
            await oc._handlePropose(proposeEnvelope([{ coinPair: PAIR, price: '123' }]));
            expect(oc.pendingRounds.has(ROUND)).to.be.false;   // NOT self-validated at deviation 0
            expect(events.map(e => e.reason)).to.include('unverifiable-new-pair');
        });

        it('still co-signs when an HONEST distinct hub priced the pair (control)', async function () {
            // A distinct validator (different pubkey) submits the same pair; it survives the
            // pubkey exclusion, so the reference carries an independent local aggregate.
            let honest = VALIDATORS_3.find(v => v.pubkey !== leader.pubkey && v.addr !== pm.validatorAddr);
            pm.validatorPubkeys.set(honest.addr, honest.pubkey);
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: ALT_ADDR,    prices: [{ coinPair: PAIR, price: '123' }] },
                { sender: honest.addr, prices: [{ coinPair: PAIR, price: '123' }] }
            ]));
            await oc._handlePropose(proposeEnvelope([{ coinPair: PAIR, price: '123' }]));
            expect(oc.pendingRounds.has(ROUND)).to.be.true;
        });
    });

    // ORACLE_ALLOW_UNVERIFIED_PAIRS disarms the unverifiable-pair co-sign defense above, so
    // it is a regtest-only bring-up seam and follows the same rule as the platform's other
    // regtest hatches (StateCheckpointEngine XDEX_SNAPSHOT_BLOCK, coins resolveFeeDestination):
    // honored on regtest, set-but-IGNORED and warned on every other network. Without the gate
    // a stray env var on a mainnet or testnet hub silently restores clamp-only leniency and
    // lets a Byzantine sole submitter get an arbitrary price co-signed.
    describe('ORACLE_ALLOW_UNVERIFIED_PAIRS network gate', function () {
        let prevEnv;

        function ocOnNetwork(network) {
            let h = createMockHub();
            h.network = network;
            return new OracleConsensus(h, { getSubmissions: sinon.stub().returns(new Map()) });
        }

        beforeEach(function () {
            prevEnv = process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS;
            process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS = 'true';
        });

        afterEach(function () {
            if (prevEnv === undefined) delete process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS;
            else process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS = prevEnv;
        });

        it('honors the flag on regtest', function () {
            expect(ocOnNetwork('regtest').allowUnverifiedPairs).to.equal(true);
        });

        ['mainnet', 'testnet', ''].forEach(function (network) {
            it('ignores the flag on ' + (network || '<unset network>') + ' and warns', function () {
                let logs = [];
                let stub = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
                let flag;
                try { flag = ocOnNetwork(network).allowUnverifiedPairs; } finally { stub.restore(); }
                expect(flag).to.equal(false);
                expect(logs.join('\n')).to.contain('ORACLE_ALLOW_UNVERIFIED_PAIRS is set but IGNORED');
            });
        });

        it('stays silent and fail-closed on mainnet when the flag is unset', function () {
            delete process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS;
            let logs = [];
            let stub = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
            let flag;
            try { flag = ocOnNetwork('mainnet').allowUnverifiedPairs; } finally { stub.restore(); }
            expect(flag).to.equal(false);
            expect(logs.join('\n')).to.not.contain('ORACLE_ALLOW_UNVERIFIED_PAIRS');
        });
    });

    // ORACLE_MIN_SUBMISSIONS lowers the 2-hub price diversity floor. Unlike the hatch above
    // it is NOT regtest-gated, because single-host PROD is a supported deployment that would
    // otherwise skip every round; what it must not be is silent, and a NEGATIVE value must
    // never remove the floor outright (`size < -1` is always false).
    describe('ORACLE_MIN_SUBMISSIONS floor', function () {
        let prevEnv;

        function ocOnNetwork(network) {
            let h = createMockHub();
            h.network = network;
            return new OracleConsensus(h, { getSubmissions: sinon.stub().returns(new Map()) });
        }

        function constructCapturingLogs(network) {
            let logs = [];
            let logStub  = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
            let warnStub = sinon.stub(console, 'warn').callsFake(m => logs.push(String(m)));
            let oc;
            try { oc = ocOnNetwork(network); } finally { logStub.restore(); warnStub.restore(); }
            return { oc: oc, text: logs.join('\n') };
        }

        beforeEach(function () {
            prevEnv = process.env.ORACLE_MIN_SUBMISSIONS;
        });

        afterEach(function () {
            if (prevEnv === undefined) delete process.env.ORACLE_MIN_SUBMISSIONS;
            else process.env.ORACLE_MIN_SUBMISSIONS = prevEnv;
        });

        it('defaults to 2 and says nothing when the knob is unset', function () {
            delete process.env.ORACLE_MIN_SUBMISSIONS;
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(2);
            expect(r.text).to.not.contain('ORACLE_MIN_SUBMISSIONS');
        });

        it('honors an explicit 1 on mainnet but announces the stood-down floor', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '1';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(1);
            expect(r.text).to.contain('ORACLE_MIN_SUBMISSIONS=1');
            expect(r.text).to.contain('mainnet');
        });

        it('honors an explicit 1 on regtest without the banner', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '1';
            let r = constructCapturingLogs('regtest');
            expect(r.oc.minSubmissions).to.equal(1);
            expect(r.text).to.not.contain('STOOD DOWN');
        });

        it('falls back to 2 on a negative value rather than removing the floor', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '-1';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(2);
        });

        it('falls back to 2 on an unparseable value', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = 'one';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(2);
        });

        it('honors a raised floor on every network', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '5';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(5);
            expect(r.text).to.not.contain('STOOD DOWN');
        });
    });
});
