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

// The oracle round-number plausibility band.
//
// The regtest hub's price_snapshots carried round_number 888100012 beside real
// rounds near 51688. That value is an e2e price SENTINEL written straight into
// the regtest DB by the price-seed fixtures (xchain-wallet
// test/e2e/fixtures/priceSeed.js BASE_ROUNDS, mirrored from
// xchain-e2e-test test/helpers/xchainPriceConstants.js SEED_SENTINEL_ROUNDS),
// chosen far out of band so it always outranks a derived round. Nothing wrote
// it through the hub. These tests pin the two defences that keep the same shape
// from reaching a validator unnoticed: the ingest paths refuse it at write time,
// and the diagnostics RPC names any row already stored outside the band.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const band            = require('../../src/lib/oracle_round_band');
const PriceAggregator = require('../../src/PriceAggregator');
const { createMockHub } = require('../helpers/mockHub');

// The value that started this item, and one of its siblings.
const SENTINEL_ROUND = 888100012;

// A hub whose oracle schedule puts "now" on a round near the regtest hub's real
// one (~51688), so the sentinel is exactly as far out of band as it was in life.
const INTERVAL_MS = 60000;
function hubOnRound(round, overrides) {
    let hub = createMockHub(overrides || {});
    hub.oracle = {
        epochStart:    Date.now() - round * INTERVAL_MS,
        roundInterval: INTERVAL_MS
    };
    return hub;
}

describe('oracle_round_band', function () {

    describe('currentRoundAt', function () {
        it('derives the round the schedule is on', function () {
            expect(band.currentRoundAt(1000 + 5 * 60000, 1000, 60000)).to.equal(5);
        });

        it('COERCES a string interval, because config delivers one', function () {
            // OracleRound takes ORACLE_ROUND_INTERVAL straight from config, so in a
            // real deployment it arrives as '60000'. A strict type check here would
            // return null on every configured hub, which reads as "no band" and is
            // invisible.
            expect(band.currentRoundAt('61000', '1000', '60000')).to.equal(1);
        });

        it('refuses booleans, which are a caller error dressed as a number', function () {
            expect(band.currentRoundAt(61000, 1000, true)).to.equal(null);
        });

        it('returns null rather than a bogus round for an unusable schedule', function () {
            expect(band.currentRoundAt(61000, 1000, 0)).to.equal(null);       // no interval
            expect(band.currentRoundAt(61000, 1000, -5)).to.equal(null);      // negative interval
            expect(band.currentRoundAt(500, 1000, 60000)).to.equal(null);     // clock before the epoch
            expect(band.currentRoundAt(NaN, 1000, 60000)).to.equal(null);
        });
    });

    describe('roundBand', function () {
        it('bounds the future side at current + tolerance', function () {
            let b = band.roundBand({ nowMs: 1000 + 100 * 60000, epochStartMs: 1000, roundIntervalMs: 60000 });
            expect(b.current).to.equal(100);
            expect(b.tolerance).to.equal(band.DEFAULT_FUTURE_ROUND_TOLERANCE);
            expect(b.max).to.equal(100 + band.DEFAULT_FUTURE_ROUND_TOLERANCE);
        });

        it('has NO past bound, because replay and catch-up push old rounds legitimately', function () {
            let b = band.roundBand({ nowMs: 1000 + 100 * 60000, epochStartMs: 1000, roundIntervalMs: 60000 });
            expect(band.isRoundImplausible(0, b)).to.equal(false);
            expect(band.isRoundImplausible(1, b)).to.equal(false);
        });

        it('is null when the schedule cannot be resolved', function () {
            expect(band.roundBand({ epochStartMs: undefined, roundIntervalMs: 60000 })).to.equal(null);
        });
    });

    describe('isRoundImplausible', function () {
        let b;
        beforeEach(function () {
            b = band.roundBand({ nowMs: 1000 + 51688 * 60000, epochStartMs: 1000, roundIntervalMs: 60000 });
        });

        it('flags the e2e sentinel round', function () {
            expect(band.isRoundImplausible(SENTINEL_ROUND, b)).to.equal(true);
        });

        it('accepts the current round and the skew tolerance above it', function () {
            expect(band.isRoundImplausible(51688, b)).to.equal(false);
            expect(band.isRoundImplausible(51690, b)).to.equal(false);
        });

        it('rejects one past the tolerance', function () {
            expect(band.isRoundImplausible(51691, b)).to.equal(true);
        });

        it('flags a non-integral or negative round WITHOUT a band', function () {
            expect(band.isRoundImplausible(-1, null)).to.equal(true);
            expect(band.isRoundImplausible(1.5, null)).to.equal(true);
            expect(band.isRoundImplausible('abc', null)).to.equal(true);
        });

        it('FAILS OPEN for an integral round when the schedule is unresolved', function () {
            // A hub that cannot resolve its own schedule must not start refusing its
            // federation's consensus output on a guess.
            expect(band.isRoundImplausible(SENTINEL_ROUND, null)).to.equal(false);
        });
    });

    describe('partitionRounds', function () {
        it('splits a real sample from its sentinels and de-duplicates', function () {
            let b = band.roundBand({ nowMs: 1000 + 51688 * 60000, epochStartMs: 1000, roundIntervalMs: 60000 });
            let p = band.partitionRounds([51686, 888100012, 51688, 51686, 888100011], b);
            expect(p.inBand).to.deep.equal([51686, 51688]);
            expect(p.outOfBand).to.deep.equal([888100011, 888100012]);
        });
    });

    describe('describeImplausibleRound', function () {
        it('says how far out of band the round is, in rounds', function () {
            let b = band.roundBand({ nowMs: 1000 + 51688 * 60000, epochStartMs: 1000, roundIntervalMs: 60000 });
            let msg = band.describeImplausibleRound(SENTINEL_ROUND, b);
            expect(msg).to.contain('888100012');
            expect(msg).to.contain('51688');
        });
    });
});

describe('PriceAggregator out-of-band round rejection', function () {

    afterEach(function () {
        sinon.restore();
    });

    // A structurally complete PRICE v0 push. Only `round` varies between the
    // accepted and refused legs, so the band check is the sole difference.
    function pushFor(round) {
        return {
            round:            round,
            timestamp:        1704067200,
            block_index:      900000,
            btc_block_height: 900000,
            pairs:            [{ pair: 'BTC/USD', price: '100000.00000000' }],
            sigs:             [{ pubkey: 'aa'.repeat(32), sig: 'bb'.repeat(64) }]
        };
    }

    it('refuses the sentinel round BEFORE any signature or DB work', async function () {
        let hub = hubOnRound(51688);
        let agg = new PriceAggregator(hub);
        let res = await agg.receiveValidatedRound('BTC', pushFor(SENTINEL_ROUND));
        expect(res).to.deep.equal({ accepted: false, reason: 'implausible round' });
        // Refused ahead of the dedupe SELECT: an out-of-band round costs no query.
        expect(hub.db.doQuery.called).to.equal(false);
        expect(agg.implausibleRoundRejections).to.equal(1);
        expect(agg.lastImplausibleRound).to.equal(SENTINEL_ROUND);
    });

    it('lets an IN-BAND round through the band check to the normal pipeline', async function () {
        let hub = hubOnRound(51688);
        let agg = new PriceAggregator(hub);
        let res = await agg.receiveValidatedRound('BTC', pushFor(51688));
        // It still fails, but on the validator snapshot, not on the band: the
        // band check is not swallowing legitimate rounds.
        expect(res.accepted).to.equal(false);
        expect(res.reason).to.not.equal('implausible round');
        expect(agg.implausibleRoundRejections).to.equal(0);
    });

    it('does NOT bound the past: a round from days ago still gets through', async function () {
        // Replaying indexers, catching-up chain-only nodes and hour-wide batch
        // windows all push old rounds. Bounding that side would drop real
        // consensus output.
        let hub = hubOnRound(51688);
        let agg = new PriceAggregator(hub);
        let res = await agg.receiveValidatedRound('BTC', pushFor(1));
        expect(res.reason).to.not.equal('implausible round');
    });

    it('FAILS OPEN when the hub has no resolvable oracle schedule', async function () {
        let hub = createMockHub();          // no hub.oracle at all
        let agg = new PriceAggregator(hub);
        let res = await agg.receiveValidatedRound('BTC', pushFor(SENTINEL_ROUND));
        expect(res.reason).to.not.equal('implausible round');
    });

    it('refuses a whole BATCH whose window top is out of band', async function () {
        // A signed batch is atomic, so the refusal takes the batch down rather
        // than dropping one round out of it.
        let hub = hubOnRound(51688);
        let agg = new PriceAggregator(hub);
        let res = await agg.receiveValidatedBatch('BTC', {
            first_round:      51688,
            last_round:       SENTINEL_ROUND,
            btc_block_height: 900000,
            block_index:      900000,
            block_time:       1704067200,
            rounds:           [{ round: 51688, timestamp: 1704067200, btc_block_height: 900000,
                                 pairs: [{ pair: 'BTC/USD', price: '100000.00000000' }] }],
            sigs:             [{ pubkey: 'aa'.repeat(32), sig: 'bb'.repeat(64) }]
        });
        expect(res.accepted).to.equal(false);
        expect(res.reason).to.equal('implausible round');
        expect(res.stored).to.equal(0);
        expect(agg.implausibleRoundRejections).to.equal(1);
    });
});

describe('OracleRound diagnostics band report', function () {

    let hub, or;

    beforeEach(function () {
        let OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return { fetchPrices: sinon.stub().resolves([]) }; }
        });
        hub = createMockHub({
            p2pConfig: {
                ORACLE_EPOCH_START:       Date.now() - 51688 * INTERVAL_MS,
                ORACLE_ROUND_INTERVAL:    String(INTERVAL_MS),
                ORACLE_SUBMISSION_WINDOW: '30000'
            }
        });
        or = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // Route the diagnostics reads by SQL shape; only the band query returns rows.
    function stubReads(outOfBandRows, opts) {
        hub.db.doQuery = sinon.stub().callsFake(async (sql) => {
            if (/round_number > \?/.test(sql) && /ORDER BY round_number DESC LIMIT 50/.test(sql)) {
                if (opts && opts.throws) throw new Error('table gone');
                return outOfBandRows;
            }
            return [];
        });
    }

    it('names a stored round past the band, so a gap scan can drop it', async function () {
        stubReads([{ round_number: SENTINEL_ROUND }]);
        let info = await or.getSubmissionsInfo();
        expect(info.implausibleRounds).to.deep.equal([SENTINEL_ROUND]);
        expect(info.implausibleRoundCount).to.equal(1);
        expect(info.implausibleRoundsReadError).to.equal(false);
        expect(info.roundBand).to.have.property('max').that.is.a('number');
    });

    it('warns ONCE for a standing sentinel, not on every diagnostics poll', async function () {
        // Diagnostics are polled. An unlatched warn would reprint the same standing
        // fault into every log tail forever, which is what the sibling counters here
        // already latch against.
        let warns = [];
        let warn = sinon.stub(console, 'warn').callsFake((...a) => warns.push(a.join(' ')));
        stubReads([{ round_number: SENTINEL_ROUND }]);
        await or.getSubmissionsInfo();
        await or.getSubmissionsInfo();
        warn.restore();
        expect(warns.filter(m => /past the plausible band/.test(m))).to.have.length(1);
    });

    it('re-announces when a HIGHER out-of-band round appears', async function () {
        let warns = [];
        let warn = sinon.stub(console, 'warn').callsFake((...a) => warns.push(a.join(' ')));
        stubReads([{ round_number: SENTINEL_ROUND }]);
        await or.getSubmissionsInfo();
        stubReads([{ round_number: SENTINEL_ROUND + 1 }, { round_number: SENTINEL_ROUND }]);
        await or.getSubmissionsInfo();
        warn.restore();
        expect(warns.filter(m => /past the plausible band/.test(m))).to.have.length(2);
    });

    it('queries above the band MAX, not above the current round', async function () {
        stubReads([]);
        await or.getSubmissionsInfo();
        let call = hub.db.doQuery.getCalls().find(c => /round_number > \?/.test(c.args[0]));
        expect(call, 'band query issued').to.exist;
        expect(call.args[1][0]).to.equal(51688 + require('../../src/lib/oracle_round_band').DEFAULT_FUTURE_ROUND_TOLERANCE);
    });

    it('reports a clean table as clean', async function () {
        stubReads([]);
        let info = await or.getSubmissionsInfo();
        expect(info.implausibleRounds).to.deep.equal([]);
        expect(info.implausibleRoundCount).to.equal(0);
    });

    it('marks a failed read rather than serving it as a clean table', async function () {
        // Without the marker a failed read is indistinguishable from an empty
        // one, and a consumer keying on implausibleRoundCount > 0 reads the
        // failure as healthy. Same additive-marker contract as the sibling reads.
        stubReads([], { throws: true });
        let info = await or.getSubmissionsInfo();
        expect(info.implausibleRounds).to.deep.equal([]);
        expect(info.implausibleRoundsReadError).to.equal(true);
    });

    it('surfaces the aggregator write-time refusal count', async function () {
        stubReads([]);
        hub.priceAggregator = { implausibleRoundRejections: 3 };
        let info = await or.getSubmissionsInfo();
        expect(info.implausibleRoundRejections).to.equal(3);
    });

    it('skips the read entirely when the schedule is unresolvable, and says so with a null band', async function () {
        stubReads([{ round_number: SENTINEL_ROUND }]);
        or.roundInterval = 0;               // unresolvable schedule
        let info = await or.getSubmissionsInfo();
        expect(info.roundBand).to.equal(null);
        expect(info.implausibleRounds).to.deep.equal([]);
        expect(hub.db.doQuery.getCalls().some(c => /round_number > \?/.test(c.args[0]))).to.equal(false);
    });
});
