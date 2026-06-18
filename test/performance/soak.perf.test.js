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
 * Scenario 5: Sustained Operation (Soak Test)
 *
 * Runs the hub under moderate load for an extended period to detect
 * memory leaks, performance degradation, and resource exhaustion.
 *
 * Default duration: 2 minutes (configurable via SOAK_DURATION_MS env var).
 */

const { expect }        = require('chai');
const { createCluster }  = require('../e2e/helpers/cluster');
const { callRpc }        = require('../e2e/helpers/rpcClient');
const testDb             = require('../helpers/testDb');
const mockApi            = require('../helpers/mockExternalApi');
const { seedAll }        = require('./helpers/seed-data');
const { Histogram, MemoryTracker } = require('./helpers/metrics');
const { weightedPick }   = require('./helpers/concurrent');

const SOAK_DURATION_MS = parseInt(process.env.SOAK_DURATION_MS) || 120000;  // 2 min default
const WINDOW_MS        = 15000;  // 15-second measurement windows

const METHOD_MIX = [
    { weight: 40, value: { method: 'getprice',          params: { coin_pair: 'BTC/USD' } } },
    { weight: 20, value: { method: 'getfeequote',       params: { action: 'ISSUE', chain: 'BTC' } } },
    { weight: 15, value: { method: 'getpricesnapshots',  params: { limit: 50 } } },
    { weight: 10, value: { method: 'getallconfigs',      params: {} } },
    { weight: 10, value: { method: 'getvalidators',      params: {} } },
    { weight:  5, value: { method: 'getattestations',    params: { status: 'confirmed', limit: 20 } } }
];

describe('Performance: Soak Test', function () {
    this.timeout(SOAK_DURATION_MS + 60000);

    let cluster;

    before(async function () {
        try {
            await testDb.setup();
        } catch (e) {
            console.log('    MariaDB unavailable: skipping soak tests');
            this.skip();
        }
        mockApi.setup();

        cluster = createCluster(1, {
            COINMARKETCAP_API_KEY: 'test-key'
        });
        await cluster.start();

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

    // ─── Sustained Query Load ───────────────────────────────────────

    it('sustained API load with memory tracking (' + (SOAK_DURATION_MS / 1000) + 's)', async function () {
        let port    = cluster.getPort(0);
        let memTracker = new MemoryTracker();
        memTracker.start(5000);  // snapshot every 5s

        let windows         = [];
        let totalRequests   = 0;
        let totalErrors     = 0;
        let concurrency     = 10;
        let startTime       = Date.now();

        while (Date.now() - startTime < SOAK_DURATION_MS) {
            let windowHist = new Histogram('window-' + windows.length);
            let windowStart = Date.now();
            let windowErrors = 0;

            // Run queries in this time window
            while (Date.now() - windowStart < WINDOW_MS) {
                let promises = [];
                for (let i = 0; i < concurrency; i++) {
                    promises.push((async () => {
                        let pick  = weightedPick(METHOD_MIX);
                        let start = process.hrtime.bigint();
                        try {
                            await callRpc(port, pick.method, pick.params);
                            let ms = Number(process.hrtime.bigint() - start) / 1e6;
                            windowHist.add(ms);
                        } catch (e) {
                            windowErrors++;
                        }
                    })());
                }
                await Promise.all(promises);
                totalRequests += concurrency;
            }

            totalErrors += windowErrors;
            windows.push({
                index:    windows.length,
                count:    windowHist.count,
                p50:      windowHist.p50,
                p95:      windowHist.p95,
                p99:      windowHist.p99,
                errors:   windowErrors
            });
        }

        memTracker.stop();

        // ─── Report ─────────────────────────────────────────────
        console.log('\n    Soak Test Summary (%ds, %d requests):', (SOAK_DURATION_MS / 1000), totalRequests);
        console.log('    %-10s  %-8s  %-8s  %-8s  %-8s  %-6s', 'Window', 'Count', 'p50', 'p95', 'p99', 'Errs');
        for (let w of windows) {
            console.log('    %-10d  %-8d  %-8.1f  %-8.1f  %-8.1f  %-6d',
                w.index, w.count, w.p50, w.p95, w.p99, w.errors);
        }
        console.log('    Total errors: %d / %d (%.2f%%)',
            totalErrors, totalRequests, (totalErrors / totalRequests) * 100);
        memTracker.report();

        // ─── Assertions ─────────────────────────────────────────

        // Memory should not grow more than 50% over the soak duration
        let memGrowth = memTracker.growthRatio('heapUsed');
        expect(memGrowth).to.be.below(1.5,
            'heap growth should be < 50% (was ' + ((memGrowth - 1) * 100).toFixed(1) + '%)');

        // p95 should not degrade more than 3x from first to last window
        if (windows.length >= 3) {
            let firstP95 = windows[0].p95;
            let lastP95  = windows[windows.length - 1].p95;
            if (firstP95 > 0) {
                expect(lastP95 / firstP95).to.be.below(3,
                    'p95 should not degrade more than 3x over the soak period');
            }
        }

        // Error rate should be below 5%
        expect(totalErrors / totalRequests).to.be.below(0.05,
            'error rate should be < 5%');
    });

    // ─── Sustained Oracle + Queries ─────────────────────────────────

    it('sustained oracle rounds with background queries (60s)', async function () {
        let port     = cluster.getPort(0);
        let duration = Math.min(60000, SOAK_DURATION_MS / 2);
        let memTracker = new MemoryTracker();
        memTracker.start(5000);

        let oracleRounds  = 0;
        let oracleHist    = new Histogram('oracle-rounds');
        let queryHist     = new Histogram('background-queries');
        let queryErrors   = 0;
        let startTime     = Date.now();
        let running       = true;

        // Background query loop
        let queryLoop = (async () => {
            while (running) {
                let pick  = weightedPick(METHOD_MIX);
                let start = process.hrtime.bigint();
                try {
                    await callRpc(port, pick.method, pick.params);
                    queryHist.add(Number(process.hrtime.bigint() - start) / 1e6);
                } catch (e) {
                    queryErrors++;
                }
            }
        })();

        // Oracle round loop
        while (Date.now() - startTime < duration) {
            mockApi.reset();
            mockApi.mockCoinGeckoSuccess();
            mockApi.mockCmcSuccess();

            let start = process.hrtime.bigint();
            try {
                await cluster.triggerOracleRound(0);
                oracleHist.add(Number(process.hrtime.bigint() - start) / 1e6);
                oracleRounds++;
            } catch (e) {
                // oracle round may fail if price APIs not mocked in time
            }

            // Short pause between rounds
            await new Promise(r => setTimeout(r, 2000));
        }

        running = false;
        await queryLoop;
        memTracker.stop();

        console.log('\n    Sustained oracle + query summary:');
        console.log('    Oracle rounds: %d', oracleRounds);
        oracleHist.report();
        queryHist.report();
        console.log('    Query errors: %d', queryErrors);
        memTracker.report();

        expect(oracleRounds).to.be.at.least(2, 'should complete at least 2 oracle rounds');
        expect(memTracker.growthRatio('heapUsed')).to.be.below(1.5, 'heap growth < 50%');
    });
});
