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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Scenario 3 — P2P Message Flood
 *
 * Stress-tests the WebSocket peer mesh under high message volume.
 * Measures message processing latency, dedup cache behavior,
 * and rate limiting accuracy.
 */

const { expect }       = require('chai');
const WebSocket        = require('ws');
const testDb           = require('../helpers/testDb');
const { buildEnvelope, createPeerPair, sendEnvelope, waitForEvent } = require('../helpers/testPeerNetwork');
const { measure, Histogram, MemoryTracker } = require('./helpers/metrics');

describe('Performance: P2P Message Flood', function () {
    this.timeout(120000);

    let db;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.log('    MariaDB unavailable — skipping P2P flood tests');
            this.skip();
        }
    });

    after(async function () {
        await testDb.teardown();
    });

    // ─── Message Processing Latency ─────────────────────────────────

    describe('message processing latency', function () {
        let pm, peerWs;

        beforeEach(async function () {
            let pair = await createPeerPair(db);
            pm     = pair.pm;
            peerWs = pair.peerWs;
        });

        afterEach(async function () {
            if (peerWs && peerWs.readyState === WebSocket.OPEN) peerWs.close();
            if (pm) await pm.stop();
        });

        it('single message round-trip latency', async function () {
            let hist = new Histogram('msg-latency');

            for (let i = 0; i < 100; i++) {
                let env   = buildEnvelope('PERF_TEST', { seq: i }, 'ws://peer-' + i + ':10001');
                let start = process.hrtime.bigint();

                let msgPromise = waitForEvent(pm, 'message', 5000);
                sendEnvelope(peerWs, env);
                await msgPromise;

                let ms = Number(process.hrtime.bigint() - start) / 1e6;
                hist.add(ms);
            }

            hist.report();
            expect(hist.p95).to.be.below(50, 'single message p95 should be < 50ms');
        });

        it('burst of 50 messages', async function () {
            let received = 0;
            let hist     = new Histogram('burst-50');
            let allDone  = new Promise((resolve) => {
                pm.on('message', () => {
                    received++;
                    if (received >= 50) resolve();
                });
            });

            let start = process.hrtime.bigint();
            for (let i = 0; i < 50; i++) {
                let env = buildEnvelope('BURST_TEST', { seq: i }, 'ws://burst-peer-' + i + ':10001');
                sendEnvelope(peerWs, env);
            }

            await Promise.race([
                allDone,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);

            let totalMs = Number(process.hrtime.bigint() - start) / 1e6;
            console.log('    50-message burst: %.2fms total, %d received', totalMs, received);

            expect(received).to.equal(50, 'all 50 messages should be received');
            expect(totalMs).to.be.below(5000, 'burst should complete within 5s');
        });
    });

    // ─── Dedup Cache Behavior ───────────────────────────────────────

    describe('dedup cache', function () {
        let pm, peerWs;

        beforeEach(async function () {
            let pair = await createPeerPair(db);
            pm     = pair.pm;
            peerWs = pair.peerWs;
        });

        afterEach(async function () {
            if (peerWs && peerWs.readyState === WebSocket.OPEN) peerWs.close();
            if (pm) await pm.stop();
        });

        it('duplicate messages are correctly filtered', async function () {
            let received = 0;
            pm.on('message', () => { received++; });

            let env = buildEnvelope('DEDUP_TEST', { value: 1 }, 'ws://dedup-peer:10001');

            // Send same message 10 times
            for (let i = 0; i < 10; i++) {
                sendEnvelope(peerWs, env);
            }

            // Wait for processing
            await new Promise(r => setTimeout(r, 500));

            // Only first should be processed
            expect(received).to.equal(1, 'duplicates should be filtered');
        });

        it('dedup cache handles high volume of unique messages', async function () {
            let received = 0;
            let target   = 500;
            let allDone  = new Promise((resolve) => {
                pm.on('message', () => {
                    received++;
                    if (received >= target) resolve();
                });
            });

            let memBefore = process.memoryUsage().heapUsed;

            for (let i = 0; i < target; i++) {
                let env = buildEnvelope('CACHE_TEST', { seq: i }, 'ws://cache-peer-' + i + ':10001');
                sendEnvelope(peerWs, env);
            }

            await Promise.race([
                allDone,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000))
            ]);

            let memAfter = process.memoryUsage().heapUsed;
            let memGrowthMB = (memAfter - memBefore) / 1024 / 1024;

            console.log('    %d unique messages: mem growth %.2f MB', target, memGrowthMB);
            expect(received).to.equal(target);
            // 500 messages should not consume more than 50 MB
            expect(memGrowthMB).to.be.below(50, 'memory growth should be < 50MB for 500 messages');
        });
    });

    // ─── Rate Limiting ──────────────────────────────────────────────

    describe('rate limiting', function () {
        it('messages exceeding rate limit are dropped', async function () {
            let PeerManager = require('../../src/PeerManager');

            // Create a PeerManager with a very low rate limit for testing
            let pm = new PeerManager({
                P2P_VALIDATOR_ADDR:     'ws://hub-rl:10001',
                P2P_PORT:               0,
                P2P_HOST:               '127.0.0.1',
                REQUIRE_SIGNATURES:     false,
                P2P_HEARTBEAT_INTERVAL: 600000,
                P2P_RECONNECT_BASE:     60000,
                P2P_MSG_DEDUP_TTL:      60000,
                P2P_MSG_RATE_LIMIT:     20   // low limit for testing
            }, db);

            await pm.start();
            let port = pm.httpServer.address().port;

            let peerWs = new WebSocket('ws://127.0.0.1:' + port);
            await new Promise((resolve, reject) => {
                peerWs.on('open', resolve);
                peerWs.on('error', reject);
            });

            let received = 0;
            pm.on('message', () => { received++; });

            // Send 50 messages from same peer (limit is 20)
            for (let i = 0; i < 50; i++) {
                let env = buildEnvelope('RATE_TEST', { seq: i }, 'ws://rate-peer:10001');
                sendEnvelope(peerWs, env);
            }

            await new Promise(r => setTimeout(r, 1000));

            console.log('    Sent 50 msgs (limit=20): %d received', received);
            // Should receive approximately the rate limit, not all 50
            expect(received).to.be.at.most(25, 'rate limiter should cap messages');
            expect(received).to.be.at.least(15, 'should receive at least some messages');

            peerWs.close();
            await pm.stop();
        });
    });

    // ─── Multi-Peer Connections ─────────────────────────────────────

    describe('multi-peer connections', function () {
        it('handles messages from multiple concurrent peers', async function () {
            let PeerManager = require('../../src/PeerManager');

            let pm = new PeerManager({
                P2P_VALIDATOR_ADDR:          'ws://hub-multi:10001',
                P2P_PORT:                    0,
                P2P_HOST:                    '127.0.0.1',
                REQUIRE_SIGNATURES:          false,
                P2P_HEARTBEAT_INTERVAL:      600000,
                P2P_RECONNECT_BASE:          60000,
                P2P_MSG_DEDUP_TTL:           60000,
                P2P_MAX_CONNECTIONS_PER_IP:  10  // allow more for testing
            }, db);

            await pm.start();
            let port = pm.httpServer.address().port;

            // Connect 5 peers
            let peers = [];
            for (let i = 0; i < 5; i++) {
                let ws = new WebSocket('ws://127.0.0.1:' + port);
                await new Promise((resolve, reject) => {
                    ws.on('open', resolve);
                    ws.on('error', reject);
                });
                peers.push(ws);
            }

            let received = 0;
            let allDone  = new Promise((resolve) => {
                pm.on('message', () => {
                    received++;
                    if (received >= 25) resolve();
                });
            });

            // Each peer sends 5 unique messages
            let start = process.hrtime.bigint();
            for (let p = 0; p < peers.length; p++) {
                for (let m = 0; m < 5; m++) {
                    let env = buildEnvelope('MULTI_TEST', { peer: p, seq: m },
                        'ws://multi-peer-' + p + ':10001');
                    sendEnvelope(peers[p], env);
                }
            }

            await Promise.race([
                allDone,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
            ]);

            let totalMs = Number(process.hrtime.bigint() - start) / 1e6;
            console.log('    5 peers x 5 msgs: %.2fms, %d received', totalMs, received);

            expect(received).to.equal(25);

            for (let ws of peers) ws.close();
            await pm.stop();
        });
    });
});
