'use strict';

/**
 * Scenario 6 — Dependency Degradation
 *
 * Tests hub behavior when external dependencies (price APIs, database) are
 * slow or failing. Measures impact on response times and verifies graceful
 * degradation.
 */

const { expect }        = require('chai');
const sinon             = require('sinon');
const nock              = require('nock');
const { createCluster }  = require('../e2e/helpers/cluster');
const { callRpc }        = require('../e2e/helpers/rpcClient');
const testDb             = require('../helpers/testDb');
const mockApi            = require('../helpers/mockExternalApi');
const { seedAll }        = require('./helpers/seed-data');
const { measure, Histogram } = require('./helpers/metrics');
const { blast }          = require('./helpers/concurrent');

describe('Performance: Dependency Degradation', function () {
    this.timeout(120000);

    let cluster;

    before(async function () {
        try {
            await testDb.setup();
        } catch (e) {
            console.log('    MariaDB unavailable — skipping resilience tests');
            this.skip();
        }
        mockApi.setup();

        cluster = createCluster(1, {
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT: 3000
        });
        await cluster.start();

        let db = cluster.getDb();
        await seedAll(db, {
            validators: 5,
            priceRounds: 100,
            attestations: 20
        });
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

    // ─── 6a. Slow Price API ─────────────────────────────────────────

    describe('6a: slow price API', function () {
        it('oracle round completes despite slow CoinGecko', async function () {
            // CoinGecko responds slowly (2.5s), CoinMarketCap is fast
            mockApi.mockCoinGeckoTimeout(2500);
            mockApi.mockCmcSuccess();

            let { durationMs } = await measure(async () => {
                await cluster.triggerOracleRound(0);
            });

            console.log('    Oracle round with slow CoinGecko: %.2fms', durationMs);
            // Should complete but take longer than normal
            expect(durationMs).to.be.above(2000, 'should wait for slow source');
            expect(durationMs).to.be.below(15000, 'should not hang indefinitely');
        });

        it('API queries unaffected by slow price fetch', async function () {
            let port = cluster.getPort(0);

            // Baseline
            let baseResult = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                20
            );

            // Start a slow oracle round in background
            mockApi.reset();
            mockApi.mockCoinGeckoTimeout(2800);
            mockApi.mockCmcSuccess();

            let oraclePromise = cluster.triggerOracleRound(0);

            // Queries during slow oracle
            let duringResult = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                20
            );

            await oraclePromise;

            console.log('    Baseline p95: %.2fms', baseResult.histogram.p95);
            console.log('    During slow oracle p95: %.2fms', duringResult.histogram.p95);
            expect(duringResult.errors).to.equal(0, 'queries should not error');
        });
    });

    // ─── 6b. Failed Price API ───────────────────────────────────────

    describe('6b: failed price API', function () {
        it('oracle round handles CoinGecko 503', async function () {
            mockApi.mockCoinGeckoError(503);
            mockApi.mockCmcSuccess();

            let { durationMs } = await measure(async () => {
                await cluster.triggerOracleRound(0);
            });

            console.log('    Oracle round with CoinGecko 503: %.2fms', durationMs);
            // Should still complete (using CoinMarketCap data only)
            expect(durationMs).to.be.below(10000);
        });

        it('oracle round handles both APIs failing', async function () {
            mockApi.mockCoinGeckoError(500);
            mockApi.mockCmcError(500);

            let { durationMs } = await measure(async () => {
                // Should not throw — graceful degradation
                try {
                    await cluster.triggerOracleRound(0);
                } catch (e) {
                    // Expected — no data to submit
                }
            });

            console.log('    Oracle round with both APIs down: %.2fms', durationMs);
            expect(durationMs).to.be.below(10000, 'should fail fast when both sources down');
        });

        it('read queries still work when price APIs are down', async function () {
            let port = cluster.getPort(0);
            mockApi.mockCoinGeckoError(500);
            mockApi.mockCmcError(500);

            // Existing data should still be queryable
            let { histogram, errors } = await blast(
                () => callRpc(port, 'getpricesnapshots', { limit: 50 }),
                20
            );
            histogram.name = 'queries-during-api-outage';
            histogram.report();
            expect(errors).to.equal(0, 'read queries should work regardless of API state');
        });
    });

    // ─── 6c. Price Fetch with Varied Latency ────────────────────────

    describe('6c: varied API latency', function () {
        it('price fetch timing scales with slowest source', async function () {
            let PriceFetcher = require('../../src/PriceFetcher');
            let fetcher = new PriceFetcher({
                COINGECKO_API_KEY:    '',
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT:   5000
            });

            let latencies = [0, 100, 500, 1000, 2000];
            let results   = [];

            for (let latency of latencies) {
                mockApi.reset();
                // CoinGecko at variable latency, CMC always fast
                nock('https://api.coingecko.com')
                    .get('/api/v3/simple/price')
                    .query(true)
                    .delayConnection(latency)
                    .reply(200, mockApi.DEFAULT_COINGECKO_RESPONSE);
                mockApi.mockCmcSuccess();

                let { result, durationMs } = await measure(() => fetcher.fetchPrices());
                results.push({ latency, durationMs, prices: result ? result.length : 0 });
            }

            console.log('\n    API Latency Impact:');
            console.log('    %-12s  %-12s  %-8s', 'Injected(ms)', 'Actual(ms)', 'Prices');
            for (let r of results) {
                console.log('    %-12d  %-12.1f  %-8d', r.latency, r.durationMs, r.prices);
            }

            // All should return prices
            for (let r of results) {
                expect(r.prices).to.be.greaterThan(0, 'should return prices at ' + r.latency + 'ms latency');
            }
        });
    });

    // ─── 6d. Concurrent Load During Degradation ─────────────────────

    describe('6d: load during degradation', function () {
        it('hub serves queries while oracle fails repeatedly', async function () {
            let port = cluster.getPort(0);

            // Fail all oracle rounds
            mockApi.mockCoinGeckoError(503);
            mockApi.mockCmcError(503);

            // Try oracle in background (will fail)
            let oracleAttempts = 3;
            let oraclePromises = [];
            for (let i = 0; i < oracleAttempts; i++) {
                oraclePromises.push(
                    cluster.triggerOracleRound(0).catch(() => {})
                );
            }

            // Concurrent queries
            let { histogram, errors } = await blast(
                () => callRpc(port, 'getallconfigs', {}),
                30
            );

            await Promise.all(oraclePromises);

            histogram.name = 'queries-during-oracle-failures';
            histogram.report();
            expect(errors).to.equal(0, 'queries should succeed during oracle failures');
        });
    });

    // ─── 6e. Recovery After Degradation ─────────────────────────────

    describe('6e: recovery after degradation', function () {
        it('response times recover after dependency restoration', async function () {
            let port = cluster.getPort(0);

            // Phase 1: Baseline
            let baseline = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                20
            );

            // Phase 2: Degradation (heavy oracle failures)
            mockApi.mockCoinGeckoError(500);
            mockApi.mockCmcError(500);
            for (let i = 0; i < 3; i++) {
                await cluster.triggerOracleRound(0).catch(() => {});
            }

            let duringDegradation = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                20
            );

            // Phase 3: Recovery
            mockApi.reset();
            mockApi.mockCoinGeckoSuccess();
            mockApi.mockCmcSuccess();
            await cluster.triggerOracleRound(0);

            let afterRecovery = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                20
            );

            console.log('\n    Recovery Timeline:');
            console.log('    Baseline p95:     %.2fms', baseline.histogram.p95);
            console.log('    Degradation p95:  %.2fms', duringDegradation.histogram.p95);
            console.log('    Recovery p95:     %.2fms', afterRecovery.histogram.p95);

            // Recovery p95 should be within 3x of baseline
            let baselineP95 = Math.max(baseline.histogram.p95, 1);
            expect(afterRecovery.histogram.p95 / baselineP95).to.be.below(3,
                'recovery p95 should be within 3x of baseline');
        });
    });
});
