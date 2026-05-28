'use strict';

/**
 * Scenario 1 — API Query Saturation
 *
 * Measures JSON-RPC API throughput and latency under concurrent load.
 * Uses a real Express server via cluster.createCluster(1) and pre-seeded DB.
 */

const { expect }       = require('chai');
const { createCluster } = require('../e2e/helpers/cluster');
const { callRpc }       = require('../e2e/helpers/rpcClient');
const testDb            = require('../helpers/testDb');
const mockApi           = require('../helpers/mockExternalApi');
const { seedAll }       = require('./helpers/seed-data');
const { Histogram }     = require('./helpers/metrics');
const { blast, ramp, weightedPick } = require('./helpers/concurrent');

// Weighted method distribution matching real-world query patterns
const METHOD_MIX = [
    { weight: 40, value: { method: 'getprice',          params: { coin_pair: 'BTC/USD' } } },
    { weight: 20, value: { method: 'getfeequote',       params: { action: 'ISSUE', chain: 'BTC' } } },
    { weight: 15, value: { method: 'getpricesnapshots',  params: { limit: 50 } } },
    { weight: 10, value: { method: 'getallconfigs',      params: {} } },
    { weight: 10, value: { method: 'getattestations',    params: { status: 'confirmed', limit: 20 } } },
    { weight:  5, value: { method: 'getvalidators',      params: {} } }
];

describe('Performance: API Query Saturation', function () {
    this.timeout(120000);

    let cluster;

    before(async function () {
        try {
            await testDb.setup();
        } catch (e) {
            console.log('    MariaDB unavailable — skipping API load tests');
            this.skip();
        }
        mockApi.setup();

        cluster = createCluster(1, {
            COINMARKETCAP_API_KEY: '' // disable CMC
        });
        await cluster.start();

        // Seed with realistic data
        let db = cluster.getDb();
        await seedAll(db, {
            validators: 10,
            priceRounds: 200,
            submissionRounds: 10,
            attestations: 50,
            proposals: 10
        });
    });

    after(async function () {
        if (cluster) await cluster.stop();
        mockApi.teardown();
        await testDb.teardown();
    });

    // ─── Individual Method Baselines ────────────────────────────────

    describe('single-method baselines', function () {
        let port;
        before(function () { port = cluster.getPort(0); });

        let methods = [
            { name: 'ping',              params: {} },
            { name: 'getprice',          params: { coin_pair: 'BTC/USD' } },
            { name: 'getfeequote',       params: { action: 'ISSUE', chain: 'BTC' } },
            { name: 'getpricesnapshots',  params: { limit: 50 } },
            { name: 'getpricesnapshots',  params: { limit: 1000 } },
            { name: 'getallconfigs',      params: {} },
            { name: 'getvalidators',      params: {} },
            { name: 'getattestations',    params: { status: 'confirmed', limit: 20 } },
            { name: 'getproposals',       params: {} }
        ];

        for (let m of methods) {
            let label = m.name + (m.params.limit ? '(limit=' + m.params.limit + ')' : '');
            it('baseline: ' + label, async function () {
                let hist = new Histogram(label);
                // 50 sequential calls for baseline
                for (let i = 0; i < 50; i++) {
                    let start = process.hrtime.bigint();
                    let res   = await callRpc(port, m.name, m.params);
                    let ms    = Number(process.hrtime.bigint() - start) / 1e6;
                    hist.add(ms);
                    expect(res).to.have.property('result');
                }
                hist.report();
                expect(hist.p95).to.be.below(500, label + ' p95 should be < 500ms');
            });
        }
    });

    // ─── Concurrent Blast Tests ─────────────────────────────────────

    describe('concurrent blast', function () {
        let port;
        before(function () { port = cluster.getPort(0); });

        it('50 concurrent getprice requests', async function () {
            let { histogram, errors } = await blast(
                () => callRpc(port, 'getprice', { coin_pair: 'BTC/USD' }),
                50
            );
            histogram.name = 'getprice x50';
            histogram.report();
            expect(errors).to.equal(0, 'should have zero errors');
            expect(histogram.p95).to.be.below(2000, 'p95 should be < 2s');
        });

        it('100 concurrent mixed-method requests', async function () {
            let { histogram, errors } = await blast(
                () => {
                    let pick = weightedPick(METHOD_MIX);
                    return callRpc(port, pick.method, pick.params);
                },
                100
            );
            histogram.name = 'mixed x100';
            histogram.report();
            expect(errors).to.equal(0, 'should have zero errors');
            expect(histogram.p95).to.be.below(3000, 'p95 should be < 3s');
        });

        it('200 concurrent getallconfigs requests', async function () {
            let { histogram, errors } = await blast(
                () => callRpc(port, 'getallconfigs', {}),
                200
            );
            histogram.name = 'getallconfigs x200';
            histogram.report();
            // Some 429s expected at 200 concurrent under rate limit
            expect(histogram.p95).to.be.below(5000, 'p95 should be < 5s');
        });
    });

    // ─── Ramp Test ──────────────────────────────────────────────────

    describe('ramp-up concurrency', function () {
        let port;
        before(function () { port = cluster.getPort(0); });

        it('ramp 10 → 25 → 50 → 100 concurrent mixed requests', async function () {
            let { histograms, errors } = await ramp(
                () => {
                    let pick = weightedPick(METHOD_MIX);
                    return callRpc(port, pick.method, pick.params);
                },
                [10, 25, 50, 100],
                100 // 100 total calls per level
            );

            console.log('\n    Ramp results:');
            for (let level of [10, 25, 50, 100]) {
                histograms[level].report();
                console.log('      errors: %d', errors[level]);
            }

            // p95 at concurrency=10 should be fast
            expect(histograms[10].p95).to.be.below(1000, 'p95 at concurrency=10 should be < 1s');
        });
    });

    // ─── Large Result Set Performance ───────────────────────────────

    describe('large result sets', function () {
        let port;
        before(function () { port = cluster.getPort(0); });

        it('getpricesnapshots with limit=1000 under concurrency', async function () {
            let { histogram, errors } = await blast(
                () => callRpc(port, 'getpricesnapshots', { limit: 1000 }),
                20
            );
            histogram.name = 'snapshots(1000) x20';
            histogram.report();
            expect(errors).to.equal(0);
        });
    });

    // ─── Write Method Performance ───────────────────────────────────

    describe('write method throughput', function () {
        let port;
        before(function () { port = cluster.getPort(0); });

        it('50 concurrent updateconfig requests', async function () {
            let { histogram, errors } = await blast(
                (i) => callRpc(port, 'updateconfig', {
                    config: { BTC: { regtest: { decoder: { ['perf_param_' + i]: String(i) } } } }
                }),
                50
            );
            histogram.name = 'updateconfig x50';
            histogram.report();
            expect(errors).to.equal(0, 'should have zero errors');
        });

        it('30 concurrent registervalidator requests', async function () {
            let { histogram, errors } = await blast(
                (i) => {
                    let hex = String(i + 100).padStart(2, '0');
                    return callRpc(port, 'registervalidator', {
                        signing_pubkey: hex.repeat(32),
                        addr: 'ws://perf-validator-' + i + ':10001'
                    });
                },
                30
            );
            histogram.name = 'registervalidator x30';
            histogram.report();
            expect(errors).to.equal(0);
        });
    });
});
