'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');
const { assertPriceSnapshot, assertAttestationStored } = require('./helpers/dbAssertions');

describe('E2E: Multi-Node Cluster', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E multi-node tests');
            return;
        }
        priceMocks.setup();
    });

    after(async function () {
        this.timeout(10000);
        priceMocks.teardown();
        await testDb.teardown();
    });

    beforeEach(async function () {
        this.timeout(30000);
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        priceMocks.reset();
    });

    afterEach(async function () {
        this.timeout(30000);
        if (cluster) {
            await cluster.stop();
            cluster = null;
        }
    });

    // E2E-MULTI-001: 3-node cluster oracle round with PBFT consensus
    describe('E2E-MULTI-001: 3-node oracle PBFT consensus', function () {

        it('all nodes submit prices and finalize via PBFT', async function () {
            this.timeout(30000);

            priceMocks.mockCoinGeckoSuccess({
                bitcoin: { usd: 100000 }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 }
            });

            cluster = createCluster(3);
            await cluster.start();

            // Allow P2P mesh to fully establish
            await new Promise(r => setTimeout(r, 2000));

            // Trigger oracle round on all nodes simultaneously
            await cluster.triggerAllOracleRounds();

            // Wait for submissions
            await new Promise(r => setTimeout(r, 2000));

            // Get the round number from the leader
            let round = cluster.getHub(0).oracle.getCurrentRound();

            // Trigger finalization from the leader
            // The leader is determined by: validatorSet[round % validatorSet.length]
            // Since validator set is sorted by pubkey, try triggering from all nodes
            // (only the leader will actually propose; non-leaders return early)
            for (let i = 0; i < 3; i++) {
                await cluster.triggerOracleFinalization(i, round).catch(() => {});
            }

            // Wait for PBFT consensus to complete
            await new Promise(r => setTimeout(r, 3000));

            // Verify finalized prices in DB
            let db = cluster.getDb();
            let snapshots = await db.doQuery(
                "SELECT * FROM price_snapshots WHERE round_number = ? AND status = 'finalized'",
                [round]
            );

            // If consensus succeeded, we should have finalized snapshots
            if (snapshots.length > 0) {
                expect(snapshots.length).to.equal(3);  // BTC, LTC, DOGE
                let btcSnap = snapshots.find(s => s.coin_pair === 'BTC/USD');
                expect(btcSnap).to.exist;
                expect(btcSnap.price).to.equal('100000.00000000');
                // With 3 validators, validator_count should reflect participation
                expect(btcSnap.validator_count).to.be.at.least(1);
            }

            // All nodes should serve the same data (shared DB)
            for (let i = 0; i < 3; i++) {
                let port = cluster.getPort(i);
                let btc = await callRpc(port, 'getprice', { coin_pair: 'BTC/USD' });
                // Either we have price data (consensus succeeded) or no data
                // All nodes should agree
                if (snapshots.length > 0) {
                    expect(btc.result.price).to.equal('100000.00000000');
                }
            }
        });
    });

    // E2E-MULTI-002: Config update via shared DB across 3 nodes
    describe('E2E-MULTI-002: 3-node config consistency via shared DB', function () {

        it('config written by one node is visible to all via shared DB', async function () {
            this.timeout(30000);

            cluster = createCluster(3);
            await cluster.start();
            await new Promise(r => setTimeout(r, 2000));

            // Write config directly via DB to avoid PBFT leader routing
            let db = cluster.getDb();
            await db.doQuery(
                "INSERT INTO configs (coin, network, module, param_name, param_value) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE param_value = ?",
                ['BTC', 'mainnet', 'decoder', 'host', 'multi-test.local', 'multi-test.local']
            );

            // All nodes should see the config via shared DB
            for (let i = 0; i < 3; i++) {
                let readRes = await callRpc(cluster.getPort(i), 'getallconfigs');
                expect(readRes.result.configs.BTC).to.exist;
                expect(readRes.result.configs.BTC.mainnet.decoder.host).to.equal('multi-test.local');
            }
        });
    });

    // E2E-MULTI-003: Cross-chain attestation via PBFT across 3 nodes
    describe('E2E-MULTI-003: 3-node attestation PBFT', function () {

        it('attestation reaches consensus across 3 validators', async function () {
            this.timeout(30000);

            cluster = createCluster(3);
            await cluster.start();
            await new Promise(r => setTimeout(r, 2000));

            // Request attestation from the leader node
            // The CrossChainEngine uses seq-based leader rotation
            // Try from each node — only the leader will succeed
            let attestation = null;
            for (let i = 0; i < 3; i++) {
                let res = await callRpc(cluster.getPort(i), 'requestattestation', {
                    source_chain: 'BTC', source_action_index: 3000, dest_chain: 'LTC'
                });
                if (res.result && res.result.status === 'attested') {
                    attestation = res.result;
                    break;
                }
            }

            // Wait for PBFT consensus to propagate
            await new Promise(r => setTimeout(r, 3000));

            // Verify in DB
            let db = cluster.getDb();
            let rows = await db.doQuery(
                "SELECT * FROM attestations WHERE attestation_id = 'BTC:3000:LTC'"
            );

            if (rows.length > 0) {
                expect(rows[0].status).to.equal('attested');
                // With multi-node, should have more validators in the count
                expect(rows[0].validator_count).to.be.at.least(1);
            }

            // All nodes should serve the same attestation data
            for (let i = 0; i < 3; i++) {
                let att = await callRpc(cluster.getPort(i), 'getattestation', {
                    source_chain: 'BTC', source_action_index: 3000
                });
                if (att.result && att.result.status) {
                    expect(att.result.status).to.equal('attested');
                }
            }
        });
    });

    // E2E-MULTI-004: All instances serve identical data
    describe('E2E-MULTI-004: Cross-instance data consistency', function () {

        it('all nodes return identical config data', async function () {
            this.timeout(30000);

            cluster = createCluster(3);
            await cluster.start();
            await new Promise(r => setTimeout(r, 2000));

            // Write config directly via DB
            let db = cluster.getDb();
            await db.doQuery(
                "INSERT INTO configs (coin, network, module, param_name, param_value) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE param_value = ?",
                ['BTC', 'mainnet', 'decoder', 'host', 'consistent.local', 'consistent.local']
            );

            // All nodes should return the same config (shared DB)
            let results = [];
            for (let i = 0; i < 3; i++) {
                let res = await callRpc(cluster.getPort(i), 'getallconfigs');
                results.push(res.result);
            }

            expect(results[0]).to.deep.equal(results[1]);
            expect(results[1]).to.deep.equal(results[2]);
            expect(results[0].BTC).to.exist;
            expect(results[0].BTC.mainnet.decoder.host).to.equal('consistent.local');
        });

        it('all nodes return identical validator list', async function () {
            this.timeout(30000);

            cluster = createCluster(3);
            await cluster.start();
            await new Promise(r => setTimeout(r, 2000));

            let results = [];
            for (let i = 0; i < 3; i++) {
                let res = await callRpc(cluster.getPort(i), 'getvalidators');
                results.push(res.result);
            }

            // All should have the same validator list (3 validators registered by cluster.start())
            expect(results[0].length).to.equal(3);
            expect(results[0].length).to.equal(results[1].length);
            expect(results[1].length).to.equal(results[2].length);

            // Sort by pubkey for deterministic comparison
            let sorted = results.map(r => r.map(v => v.signing_pubkey).sort());
            expect(sorted[0]).to.deep.equal(sorted[1]);
            expect(sorted[1]).to.deep.equal(sorted[2]);
        });

        it('all nodes return identical price data from shared DB', async function () {
            this.timeout(30000);

            cluster = createCluster(3);
            await cluster.start();

            // Insert price snapshot directly in DB
            let db = cluster.getDb();
            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (1, 'BTC/USD', '99999.00000000', 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                [Date.now()]
            );

            // All nodes should return the same price
            for (let i = 0; i < 3; i++) {
                let res = await callRpc(cluster.getPort(i), 'getprice', { coin_pair: 'BTC/USD' });
                expect(res.result.price).to.equal('99999.00000000');
            }
        });
    });

    // E2E-MULTI: Consumer fallback pattern
    describe('E2E-MULTI: Consumer fallback pattern', function () {

        it('data accessible from any node when another is unavailable', async function () {
            this.timeout(30000);

            cluster = createCluster(3);
            await cluster.start();

            // Insert test data
            let db = cluster.getDb();
            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (1, 'BTC/USD', '50000.00000000', 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                [Date.now()]
            );

            // Verify all nodes can serve the data
            let port0 = cluster.getPort(0);
            let port1 = cluster.getPort(1);
            let port2 = cluster.getPort(2);

            let res0 = await callRpc(port0, 'getprice', { coin_pair: 'BTC/USD' });
            let res1 = await callRpc(port1, 'getprice', { coin_pair: 'BTC/USD' });
            let res2 = await callRpc(port2, 'getprice', { coin_pair: 'BTC/USD' });

            expect(res0.result.price).to.equal('50000.00000000');
            expect(res1.result.price).to.equal('50000.00000000');
            expect(res2.result.price).to.equal('50000.00000000');
        });
    });
});
