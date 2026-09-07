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
//
// The PRICE batch cadence ceiling. These are the arithmetic the
// publisher's window size is derived from, tested against the numbers the live
// fleet actually runs rather than round ones, so a regression that re-opens the
// hourly-batch / half-hourly-gate mismatch fails here first.

const { expect } = require('chai');

const coins = require('../../src/coins/index.js');
const { worstCaseSnapshotAgeMs, maxBatchWindowRounds, pinnedMaxPriceAgeMs,
        DEFAULT_BATCH_LANDING_RESERVE_MS,
        LEGACY_BATCH_WINDOW_ROUNDS } = require('../../src/lib/price_batch_cadence.js');

// The fleet's shipped values: 10-minute oracle rounds, a 5-minute straggler
// grace, the default landing reserve, and the consensus-pinned 1800s bound.
const SHIPPED = {
    roundIntervalMs:  600000,
    graceMs:          300000,
    landingReserveMs: DEFAULT_BATCH_LANDING_RESERVE_MS,
    maxPriceAgeMs:    1800000
};

describe('PRICE batch cadence ceiling', function () {

    describe('worstCaseSnapshotAgeMs', function () {

        it('is the window plus the grace plus the landing reserve', function () {
            expect(worstCaseSnapshotAgeMs(2, SHIPPED)).to.equal(1800000);
            expect(worstCaseSnapshotAgeMs(1, SHIPPED)).to.equal(1200000);
        });

        it('measures the shipped 6-round window at the age testnet actually saw', function () {
            // 2026-09-01 on TDOGE: PRICE landed on a 3600s cadence, so the newest
            // snapshot aged past 3600s before the next batch replaced it. The formula
            // has to reproduce that, or the ceiling it feeds is fiction.
            expect(worstCaseSnapshotAgeMs(LEGACY_BATCH_WINDOW_ROUNDS, SHIPPED)).to.equal(4200000);
            expect(worstCaseSnapshotAgeMs(LEGACY_BATCH_WINDOW_ROUNDS, SHIPPED))
                .to.be.above(SHIPPED.maxPriceAgeMs);
        });

        it('returns null rather than a number for unusable inputs', function () {
            expect(worstCaseSnapshotAgeMs(0, SHIPPED)).to.equal(null);
            expect(worstCaseSnapshotAgeMs(-1, SHIPPED)).to.equal(null);
            expect(worstCaseSnapshotAgeMs('two', SHIPPED)).to.equal(null);
            expect(worstCaseSnapshotAgeMs(2, Object.assign({}, SHIPPED, { roundIntervalMs: 0 }))).to.equal(null);
            expect(worstCaseSnapshotAgeMs(2, Object.assign({}, SHIPPED, { graceMs: -1 }))).to.equal(null);
        });
    });

    describe('maxBatchWindowRounds', function () {

        it('derives 2 rounds per batch from the shipped values', function () {
            let r = maxBatchWindowRounds(SHIPPED);
            expect(r.ceiling).to.equal(2);
            expect(r.budgetMs).to.equal(1200000);
            expect(r.satisfiable).to.equal(true);
        });

        it('never returns a ceiling whose own peak overruns the bound', function () {
            // The property the whole module exists for, swept across every plausible
            // deployment rather than asserted at one point.
            for (let interval of [60000, 120000, 300000, 600000, 900000]) {
                for (let grace of [0, 1000, 60000, 300000]) {
                    for (let reserve of [0, 60000, 300000, 600000]) {
                        let opts = { roundIntervalMs: interval, graceMs: grace,
                                     landingReserveMs: reserve, maxPriceAgeMs: 1800000 };
                        let r = maxBatchWindowRounds(opts);
                        if (!r.satisfiable) continue;
                        expect(worstCaseSnapshotAgeMs(r.ceiling, opts),
                            'ceiling ' + r.ceiling + ' at ' + JSON.stringify(opts))
                            .to.be.at.most(opts.maxPriceAgeMs);
                        // And it is the LARGEST such window: one more must overrun.
                        expect(worstCaseSnapshotAgeMs(r.ceiling + 1, opts))
                            .to.be.above(opts.maxPriceAgeMs);
                    }
                }
            }
        });

        it('floors at one round and flags the deployment when nothing fits', function () {
            let r = maxBatchWindowRounds(Object.assign({}, SHIPPED, { roundIntervalMs: 3600000 }));
            expect(r.ceiling).to.equal(1);
            expect(r.satisfiable).to.equal(false);

            // A grace that alone eats the whole bound is the same verdict.
            let g = maxBatchWindowRounds(Object.assign({}, SHIPPED, { graceMs: 1800000 }));
            expect(g.ceiling).to.equal(1);
            expect(g.satisfiable).to.equal(false);
        });

        it('leaves the window uncapped when the bound is disabled or unresolvable', function () {
            for (let maxAge of [0, -1, null, undefined, NaN, 'soon']) {
                let r = maxBatchWindowRounds(Object.assign({}, SHIPPED, { maxPriceAgeMs: maxAge }));
                expect(r.ceiling, 'maxPriceAgeMs=' + maxAge).to.equal(null);
                expect(r.satisfiable).to.equal(true);
            }
        });

        it('leaves the window uncapped rather than guessing on a broken cadence input', function () {
            // A bad interval or grace must not silently produce a ceiling; the caller
            // keeps its own default instead, which is the conservative direction.
            expect(maxBatchWindowRounds(Object.assign({}, SHIPPED, { roundIntervalMs: 0 })).ceiling).to.equal(null);
            expect(maxBatchWindowRounds(Object.assign({}, SHIPPED, { graceMs: -5 })).ceiling).to.equal(null);
            expect(maxBatchWindowRounds(Object.assign({}, SHIPPED, { landingReserveMs: 'a bit' })).ceiling).to.equal(null);
            expect(maxBatchWindowRounds().ceiling).to.equal(null);
        });
    });

    describe('pinnedMaxPriceAgeMs', function () {

        it('reads the consensus-pinned bound off the coin registry on every network', function () {
            for (let net of ['mainnet', 'testnet', 'regtest']) {
                expect(pinnedMaxPriceAgeMs(net), net).to.equal(1800000);
            }
        });

        it('falls back rather than returning null on an unknown network', function () {
            expect(pinnedMaxPriceAgeMs('no-such-network')).to.equal(1800000);
            expect(pinnedMaxPriceAgeMs('')).to.equal(1800000);
            expect(pinnedMaxPriceAgeMs(null)).to.equal(1800000);
        });

        it('takes the TIGHTEST bound in the registry, not the landing chain\'s', function () {
            // One rail feeds every chain's fee gate, and each chain judges snapshot age
            // with its own ORACLE_MAX_PRICE_AGE_SECONDS. Reading DOGE's alone (the chain
            // the wire lands on) would size a window that overruns any chain given a
            // shorter bound - the same two-knobs-drifting-apart shape as the original defect,
            // one registry edit away. The shipped values are all 1800s, so this asserts
            // the RULE against a registry stubbed to disagree.
            const real = coins.getCoinConfig;
            try {
                coins.getCoinConfig = function (tick, network) {
                    let cfg = real.call(coins, tick, network);
                    // LTC tightened to 10 minutes; DOGE and BTC left at the pinned 1800s.
                    if (tick === 'LTC') cfg = Object.assign({}, cfg, { ORACLE_MAX_PRICE_AGE_SECONDS: 600 });
                    return cfg;
                };
                expect(pinnedMaxPriceAgeMs('testnet')).to.equal(600000);
                // And the window that bound implies is smaller, not merely reported.
                expect(maxBatchWindowRounds(Object.assign({}, SHIPPED,
                    { maxPriceAgeMs: pinnedMaxPriceAgeMs('testnet') })).satisfiable).to.equal(false);
            } finally {
                coins.getCoinConfig = real;
            }
        });

        it('ignores a tick the network does not configure rather than failing closed', function () {
            const real = coins.getCoinConfig;
            try {
                coins.getCoinConfig = function (tick, network) {
                    if (tick === 'LTC') throw new Error('LTC is not configured on this network');
                    return real.call(coins, tick, network);
                };
                expect(pinnedMaxPriceAgeMs('testnet')).to.equal(1800000);
            } finally {
                coins.getCoinConfig = real;
            }
        });
    });
});
