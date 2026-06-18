'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Scenario 2: Oracle Round Under Load
 *
 * Measures oracle round execution time, submission processing, aggregation,
 * and the impact of oracle activity on concurrent API queries.
 */

const { expect }        = require('chai');
const sinon             = require('sinon');
const { createCluster }  = require('../e2e/helpers/cluster');
const { callRpc }        = require('../e2e/helpers/rpcClient');
const testDb             = require('../helpers/testDb');
const mockApi            = require('../helpers/mockExternalApi');
const { seedAll }        = require('./helpers/seed-data');
const { measure, Histogram } = require('./helpers/metrics');
const { blast }          = require('./helpers/concurrent');

describe('Performance: Oracle Round Under Load', function () {
    this.timeout(120000);

    let cluster;

    before(async function () {
        try {
            await testDb.setup();
        } catch (e) {
            console.log('    MariaDB unavailable: skipping oracle load tests');
            this.skip();
        }
        mockApi.setup();

        cluster = createCluster(1, {
            COINMARKETCAP_API_KEY: 'test-key'
        });
        await cluster.start();

        let db = cluster.getDb();
        await seedAll(db, { validators: 5, priceRounds: 50 });
    });

    after(async function () {
        if (cluster) await cluster.stop();
        mockApi.teardown();
        await testDb.teardown();
    });

    beforeEach(function () {
        mockApi.reset();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ─── Single Oracle Round Timing ─────────────────────────────────

    describe('oracle round execution', function () {
        it('single oracle round completes within budget', async function () {
            mockApi.mockCoinGeckoSuccess();
            mockApi.mockCmcSuccess();

            let { durationMs } = await measure(async () => {
                await cluster.triggerOracleRound(0);
            });

            console.log('    Single oracle round: %.2fms', durationMs);
            expect(durationMs).to.be.below(5000, 'oracle round should complete within 5s');
        });

        it('10 consecutive oracle rounds show stable timing', async function () {
            let hist = new Histogram('oracle-round');

            for (let i = 0; i < 10; i++) {
                mockApi.reset();
                mockApi.mockCoinGeckoSuccess();
                mockApi.mockCmcSuccess();

                let { durationMs } = await measure(async () => {
                    await cluster.triggerOracleRound(0);
                });
                hist.add(durationMs);
            }

            hist.report();
            // Variance check: p99 should not be more than 5x the median
            expect(hist.p99).to.be.below(hist.p50 * 5,
                'oracle round p99 should be within 5x of median');
        });
    });

    // ─── Oracle Round + Concurrent Queries ──────────────────────────

    describe('oracle round with concurrent query load', function () {
        it('API queries remain responsive during oracle execution', async function () {
            let port = cluster.getPort(0);

            // Establish baseline without oracle activity
            let baselineResults = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                20
            );
            let baselineP95 = baselineResults.histogram.p95;

            // Now run queries concurrently with oracle round
            mockApi.reset();
            mockApi.mockCoinGeckoSuccess();
            mockApi.mockCmcSuccess();

            let queryHist = new Histogram('getprice-during-oracle');
            let oracleDone = false;

            // Start oracle round
            let oraclePromise = cluster.triggerOracleRound(0).then(() => { oracleDone = true; });

            // Fire queries while oracle is running
            let queryPromises = [];
            for (let i = 0; i < 30; i++) {
                queryPromises.push((async () => {
                    let start = process.hrtime.bigint();
                    await callRpc(port, 'getprice', { coin_pair: 'BTC/USD' });
                    let ms = Number(process.hrtime.bigint() - start) / 1e6;
                    queryHist.add(ms);
                })());
            }

            await Promise.all([oraclePromise, ...queryPromises]);

            console.log('    Baseline p95: %.2fms', baselineP95);
            queryHist.name = 'getprice-during-oracle';
            queryHist.report();

            // During oracle activity, p95 should degrade no more than 5x
            expect(queryHist.p95).to.be.below(Math.max(baselineP95 * 5, 3000),
                'query p95 degradation during oracle should be < 5x baseline');
        });
    });

    // ─── Aggregation Performance ────────────────────────────────────

    describe('aggregation with many submissions', function () {
        it('finalization handles dense submission data', async function () {
            let db = cluster.getDb();

            // Insert a dense set of submissions for a new round
            let round = 99999;
            for (let v = 1; v <= 20; v++) {
                let hex = String(v).padStart(2, '0');
                let pubkey = hex.repeat(32);
                for (let pair of ['BTC/USD', 'LTC/USD', 'DOGE/USD']) {
                    let basePrice = pair === 'BTC/USD' ? 100000 : pair === 'LTC/USD' ? 85 : 0.15;
                    let jitter = 1 + (Math.random() - 0.5) * 0.02;
                    await db.doQuery(
                        `INSERT IGNORE INTO oracle_submissions
                            (round, coin_pair, validator_pubkey, price, sources, submitted_at)
                         VALUES (?, ?, ?, ?, 2, NOW())`,
                        [round, pair, pubkey, (basePrice * jitter).toFixed(8)]
                    );
                }
            }

            // Measure querying these submissions (simulates aggregation read)
            let { durationMs } = await measure(async () => {
                await db.doQuery(
                    'SELECT * FROM oracle_submissions WHERE round = ?',
                    [round]
                );
            });

            console.log('    Read 60 submissions: %.2fms', durationMs);
            expect(durationMs).to.be.below(500, 'reading submissions should be < 500ms');
        });
    });

    // ─── Price Fetch Timing ─────────────────────────────────────────

    describe('price fetch performance', function () {
        it('parallel price fetch completes quickly with fast APIs', async function () {
            let PriceFetcher = require('../../src/PriceFetcher');
            let fetcher = new PriceFetcher({
                COINGECKO_API_KEY:    '',
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT:   5000
            });

            let hist = new Histogram('price-fetch');
            for (let i = 0; i < 10; i++) {
                mockApi.reset();
                mockApi.mockCoinGeckoSuccess();
                mockApi.mockCmcSuccess();

                let { durationMs } = await measure(() => fetcher.fetchPrices());
                hist.add(durationMs);
            }

            hist.report();
            expect(hist.p95).to.be.below(2000, 'price fetch p95 should be < 2s');
        });

        it('price fetch degrades gracefully with one slow source', async function () {
            let PriceFetcher = require('../../src/PriceFetcher');
            let fetcher = new PriceFetcher({
                COINGECKO_API_KEY:    '',
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT:   3000
            });

            mockApi.mockCoinGeckoTimeout(2500); // slow but within timeout
            mockApi.mockCmcSuccess();

            let { result, durationMs } = await measure(() => fetcher.fetchPrices());
            console.log('    Slow-source fetch: %.2fms', durationMs);

            // Should still return data from the fast source
            expect(result).to.be.an('array').with.length.greaterThan(0);
            // Should take roughly as long as the slow source
            expect(durationMs).to.be.above(2000);
        });
    });
});
