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
 * Scenario 4: Database Stress
 *
 * Tests MariaDB connection pool behavior, query latency under concurrency,
 * and circuit breaker activation/recovery.
 */

const { expect }         = require('chai');
const testDb             = require('../helpers/testDb');
const { makeValidator, SAMPLE_PRICES } = require('../helpers/fixtures');
const { measure, Histogram } = require('./helpers/metrics');
const { blast }          = require('./helpers/concurrent');

describe('Performance: Database Stress', function () {
    this.timeout(120000);

    let db;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.log('    MariaDB unavailable: skipping DB stress tests');
            this.skip();
        }
    });

    after(async function () {
        await testDb.teardown();
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });

    // ─── Write Throughput ───────────────────────────────────────────

    describe('write throughput', function () {
        it('insertion rate for oracle_submissions', async function () {
            let hist = new Histogram('insert-submission');
            let count = 200;

            for (let i = 0; i < count; i++) {
                let v = makeValidator((i % 10) + 1);
                let pair = SAMPLE_PRICES[i % 3].coinPair;
                let price = (parseFloat(SAMPLE_PRICES[i % 3].price) * (1 + Math.random() * 0.01)).toFixed(8);

                let { durationMs } = await measure(() =>
                    db.doQuery(
                        `INSERT INTO oracle_submissions
                            (round, coin_pair, validator_pubkey, price, sources, submitted_at)
                         VALUES (?, ?, ?, ?, 2, NOW())`,
                        [Math.floor(i / 30) + 1, pair, v.pubkey, price]
                    )
                );
                hist.add(durationMs);
            }

            hist.report();
            console.log('    %d inserts, total: %.0fms, avg: %.2fms/insert',
                count, hist.mean * count, hist.mean);
            expect(hist.p95).to.be.below(100, 'single insert p95 should be < 100ms');
        });

        it('concurrent writes to configs table', async function () {
            let { histogram, errors } = await blast(
                (i) => db.doQuery(
                    `INSERT INTO configs (coin, network, module, param_name, param_value)
                     VALUES (?, 'regtest', 'decoder', ?, ?)
                     ON DUPLICATE KEY UPDATE param_value = VALUES(param_value)`,
                    [['BTC', 'LTC', 'DOGE'][i % 3], 'perf_param_' + i, String(i)]
                ),
                50
            );
            histogram.name = 'concurrent-config-write x50';
            histogram.report();
            expect(errors).to.equal(0, 'should have zero write errors');
            expect(histogram.p95).to.be.below(500, 'concurrent write p95 should be < 500ms');
        });

        it('concurrent writes to price_snapshots', async function () {
            let { histogram, errors } = await blast(
                (i) => {
                    let pair = SAMPLE_PRICES[i % 3].coinPair;
                    return db.doQuery(
                        `INSERT INTO price_snapshots
                            (round_number, coin_pair, price, sources, validator_count, consensus_proof, status, created_at)
                         VALUES (?, ?, ?, 2, 3, '{}', 'finalized', NOW())`,
                        [i + 1, pair, (100000 + i).toFixed(8)]
                    );
                },
                60  // 20 rounds × 3 pairs
            );
            histogram.name = 'concurrent-snapshot-write x60';
            histogram.report();
            expect(errors).to.equal(0);
        });
    });

    // ─── Read Throughput ────────────────────────────────────────────

    describe('read throughput', function () {
        before(async function () {
            // Seed data for reads
            for (let r = 1; r <= 100; r++) {
                for (let p of SAMPLE_PRICES) {
                    await db.doQuery(
                        `INSERT IGNORE INTO price_snapshots
                            (round_number, coin_pair, price, sources, validator_count, consensus_proof, status, created_at)
                         VALUES (?, ?, ?, 2, 3, '{}', 'finalized', NOW())`,
                        [r, p.coinPair, p.price]
                    );
                }
            }
            for (let i = 1; i <= 10; i++) {
                let v = makeValidator(i);
                await db.doQuery(
                    'INSERT IGNORE INTO validators (signing_pubkey, addr, status) VALUES (?, ?, ?)',
                    [v.pubkey, v.addr, 'active']
                );
            }
        });

        it('concurrent reads of price_snapshots', async function () {
            let { histogram, errors } = await blast(
                () => db.doQuery(
                    "SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC LIMIT 50"
                ),
                50
            );
            histogram.name = 'read-snapshots x50';
            histogram.report();
            expect(errors).to.equal(0);
            expect(histogram.p95).to.be.below(200, 'concurrent read p95 should be < 200ms');
        });

        it('concurrent reads of validators', async function () {
            let { histogram, errors } = await blast(
                () => db.doQuery("SELECT * FROM validators WHERE status = 'active'"),
                50
            );
            histogram.name = 'read-validators x50';
            histogram.report();
            expect(errors).to.equal(0);
            expect(histogram.p95).to.be.below(100, 'validator read p95 should be < 100ms');
        });

        it('large result set read (1000 snapshots)', async function () {
            let { durationMs } = await measure(() =>
                db.doQuery(
                    "SELECT * FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC LIMIT 1000"
                )
            );
            console.log('    Read 1000 snapshots: %.2fms', durationMs);
            expect(durationMs).to.be.below(1000, 'large read should be < 1s');
        });
    });

    // ─── Mixed Read/Write Concurrency ───────────────────────────────

    describe('mixed read/write concurrency', function () {
        it('concurrent reads and writes do not deadlock', async function () {
            let writeHist = new Histogram('mixed-writes');
            let readHist  = new Histogram('mixed-reads');
            let errors    = 0;

            let promises = [];

            // 25 writes
            for (let i = 0; i < 25; i++) {
                promises.push((async () => {
                    let start = process.hrtime.bigint();
                    try {
                        await db.doQuery(
                            `INSERT INTO configs (coin, network, module, param_name, param_value)
                             VALUES ('BTC', 'regtest', 'decoder', ?, ?)
                             ON DUPLICATE KEY UPDATE param_value = VALUES(param_value)`,
                            ['mixed_param_' + i, String(i)]
                        );
                        writeHist.add(Number(process.hrtime.bigint() - start) / 1e6);
                    } catch (e) { errors++; }
                })());
            }

            // 25 reads
            for (let i = 0; i < 25; i++) {
                promises.push((async () => {
                    let start = process.hrtime.bigint();
                    try {
                        await db.doQuery("SELECT * FROM price_snapshots LIMIT 50");
                        readHist.add(Number(process.hrtime.bigint() - start) / 1e6);
                    } catch (e) { errors++; }
                })());
            }

            await Promise.all(promises);

            writeHist.report();
            readHist.report();
            expect(errors).to.equal(0, 'no errors during mixed operations');
        });
    });

    // ─── Connection Pool Saturation ─────────────────────────────────

    describe('connection pool behavior', function () {
        it('handles more concurrent queries than pool size (10)', async function () {
            // Fire 30 queries simultaneously (3x pool size)
            let { histogram, errors } = await blast(
                (i) => db.doQuery('SELECT SLEEP(0.05), ? AS idx', [i]),
                30
            );
            histogram.name = 'pool-saturation x30';
            histogram.report();

            // All should succeed, but later ones will wait for pool
            expect(errors).to.equal(0, 'all queries should complete');
            // With pool of 10 and 50ms sleep, 30 queries need ~3 batches = ~150ms
            expect(histogram.max).to.be.below(5000, 'max wait should be < 5s');
        });

        it('pool recovers after brief overload', async function () {
            // Overload
            await blast(
                () => db.doQuery('SELECT SLEEP(0.02)'),
                50
            );

            // Recovery: should be fast again
            let { histogram, errors } = await blast(
                () => db.doQuery('SELECT 1'),
                10
            );
            histogram.name = 'post-overload x10';
            histogram.report();

            expect(errors).to.equal(0);
            expect(histogram.p95).to.be.below(200, 'post-overload p95 should be < 200ms');
        });
    });

    // ─── Parameterized Query Performance ────────────────────────────

    describe('parameterized queries', function () {
        it('setParam upsert performance', async function () {
            let hist = new Histogram('setParam');

            for (let i = 0; i < 100; i++) {
                let { durationMs } = await measure(() =>
                    db.setParam('BTC', 'regtest', 'decoder', 'perf_' + i, String(i))
                );
                hist.add(durationMs);
            }

            hist.report();
            expect(hist.p95).to.be.below(100, 'setParam p95 should be < 100ms');
        });

        it('getConfig read performance', async function () {
            // Seed some config first
            for (let i = 0; i < 20; i++) {
                await db.setParam('BTC', 'mainnet', 'decoder', 'param_' + i, String(i));
            }

            let hist = new Histogram('getConfig');
            for (let i = 0; i < 100; i++) {
                let { durationMs } = await measure(() =>
                    db.getConfig('BTC', 'mainnet', 'decoder')
                );
                hist.add(durationMs);
            }

            hist.report();
            expect(hist.p95).to.be.below(50, 'getConfig p95 should be < 50ms');
        });

        it('getAllConfigs with many entries', async function () {
            // Seed configs across multiple coins/networks
            let coins = ['BTC', 'LTC', 'DOGE'];
            let networks = ['mainnet', 'testnet', 'regtest'];
            for (let c of coins) {
                for (let n of networks) {
                    for (let i = 0; i < 5; i++) {
                        await db.setParam(c, n, 'decoder', 'perf_' + i, String(i));
                    }
                }
            }

            let hist = new Histogram('getAllConfigs');
            for (let i = 0; i < 50; i++) {
                let { durationMs } = await measure(() => db.getAllConfigs());
                hist.add(durationMs);
            }

            hist.report();
            expect(hist.p95).to.be.below(100, 'getAllConfigs p95 should be < 100ms');
        });
    });
});
