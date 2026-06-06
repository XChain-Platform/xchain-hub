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
const { waitForPrice, waitForPriceSnapshot } = require('./helpers/waitFor');
const { assertPriceSnapshot, assertSkippedRound, assertRewardDistributed } = require('./helpers/dbAssertions');

describe('E2E: Oracle Price Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E oracle tests');
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
        this.timeout(15000);
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        priceMocks.reset();
    });

    afterEach(async function () {
        this.timeout(10000);
        if (cluster) {
            await cluster.stop();
            cluster = null;
        }
    });

    // E2E-ORACLE-001: Price fetch → single-node finalization → serving
    describe('E2E-ORACLE-001: Normal price pipeline (single-node)', function () {

        it('fetches prices, finalizes round, serves via getprice', async function () {
            this.timeout(15000);

            // Mock CoinGecko prices
            priceMocks.mockCoinGeckoSuccess({
                bitcoin:  { usd: 100000 },
                litecoin: { usd: 85 },
                dogecoin: { usd: 0.15 }
            });

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Trigger oracle round manually
            await cluster.triggerOracleRound(0);

            // Wait for submission window, then finalize
            await new Promise(r => setTimeout(r, 500));
            let oracle = cluster.getHub(0).oracle;
            let round = oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round);

            // Verify via JSON-RPC
            let btcPrice = await callRpc(port, 'getprice', { coin_pair: 'BTC/USD' });
            expect(btcPrice.result.price).to.equal('100000.00000000');
            expect(btcPrice.result.coin_pair).to.equal('BTC/USD');
            expect(btcPrice.result.status).to.equal('finalized');

            let ltcPrice = await callRpc(port, 'getprice', { coin_pair: 'LTC/USD' });
            expect(ltcPrice.result.price).to.equal('85.00000000');

            let dogePrice = await callRpc(port, 'getprice', { coin_pair: 'DOGE/USD' });
            expect(dogePrice.result.price).to.equal('0.15000000');

            // Verify snapshots via API
            let snapshots = await callRpc(port, 'getpricesnapshots', { limit: 10 });
            expect(snapshots.result).to.be.an('array');
            let finalized = snapshots.result.filter(s => s.status === 'finalized');
            expect(finalized.length).to.equal(3);  // BTC, LTC, DOGE

            // Verify DB state directly
            let db = cluster.getDb();
            await assertPriceSnapshot(db, round, 'BTC/USD', { price: '100000.00000000', validatorCount: 1 });
            await assertPriceSnapshot(db, round, 'LTC/USD', { price: '85.00000000' });
            await assertPriceSnapshot(db, round, 'DOGE/USD', { price: '0.15000000' });
        });

        it('oracle submissions are visible via getoraclesubmissions', async function () {
            this.timeout(15000);

            priceMocks.mockCoinGeckoSuccess();

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            await cluster.triggerOracleRound(0);

            let subs = await callRpc(port, 'getoraclesubmissions');
            expect(subs.result.currentRound).to.be.greaterThan(0);
            expect(subs.result.roundInterval).to.equal(999999999);

            // Check submissions exist for the current round
            let roundSubs = subs.result.submissions[subs.result.currentRound];
            expect(roundSubs).to.exist;
            let senders = Object.keys(roundSubs);
            expect(senders.length).to.equal(1);
        });
    });

    // E2E-ORACLE-003: One external API down
    describe('E2E-ORACLE-003: One API down — graceful degradation', function () {

        it('continues with remaining source when CoinGecko fails', async function () {
            this.timeout(15000);

            // CoinGecko down, CMC up
            priceMocks.mockCoinGeckoError(503);
            priceMocks.mockCmcSuccess();

            cluster = createCluster(1, { COINMARKETCAP_API_KEY: 'test-key' });
            await cluster.start();
            let port = cluster.getPort(0);

            await cluster.triggerOracleRound(0);
            await new Promise(r => setTimeout(r, 500));
            let round = cluster.getHub(0).oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round);

            // Should still have prices from CMC
            let btc = await callRpc(port, 'getprice', { coin_pair: 'BTC/USD' });
            expect(btc.result.price).to.exist;
            expect(btc.result.status).to.equal('finalized');
            expect(parseFloat(btc.result.price)).to.be.greaterThan(0);
        });
    });

    // E2E-ORACLE-004: All APIs down — round skipped
    describe('E2E-ORACLE-004: All APIs down — round skipped', function () {

        it('skips round when no prices are fetched', async function () {
            this.timeout(15000);

            // Both sources down
            priceMocks.mockCoinGeckoError(503);
            priceMocks.mockCmcError(503);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            await cluster.triggerOracleRound(0);
            await new Promise(r => setTimeout(r, 500));
            let round = cluster.getHub(0).oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round);

            // Round should be skipped
            let db = cluster.getDb();
            await assertSkippedRound(db, round);

            // getprice should return no data
            let btc = await callRpc(port, 'getprice', { coin_pair: 'BTC/USD' });
            expect(btc.result.error).to.include('no price data');

            // Hub should still be operational
            let ping = await callRpc(port, 'ping');
            expect(ping.result.status).to.equal('success');
        });
    });

    // E2E-ORACLE-006: Rewards distributed after finalization
    describe('E2E-ORACLE-006: Reward distribution', function () {

        it('distributes rewards to participating validator after round finalization', async function () {
            this.timeout(15000);

            priceMocks.mockCoinGeckoSuccess();

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);
            let pubkey = cluster.getKeypair(0).pubkeyHex;

            await cluster.triggerOracleRound(0);
            await new Promise(r => setTimeout(r, 500));
            let round = cluster.getHub(0).oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round);

            // Wait a moment for async reward distribution
            await new Promise(r => setTimeout(r, 500));

            // Verify rewards in DB
            let db = cluster.getDb();
            await assertRewardDistributed(db, round, 1);

            // Verify via API — validator status shows unclaimed rewards
            let status = await callRpc(port, 'getvalidatorstatus', { signing_pubkey: pubkey });
            expect(status.result.validator).to.exist;
            let unclaimed = parseFloat(status.result.unclaimedRewards);
            expect(unclaimed).to.be.greaterThan(0);
        });
    });

    // E2E-ORACLE: Previous round data persists after new round
    describe('E2E-ORACLE: Multiple rounds', function () {

        it('previous round prices remain accessible after new round', async function () {
            this.timeout(20000);

            priceMocks.mockCoinGeckoSuccess({
                bitcoin: { usd: 100000 }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 }
            });

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Round 1
            await cluster.triggerOracleRound(0);
            await new Promise(r => setTimeout(r, 500));
            let round1 = cluster.getHub(0).oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round1);

            // Update prices
            priceMocks.reset();
            priceMocks.mockCoinGeckoSuccess({
                bitcoin: { usd: 105000 }, litecoin: { usd: 90 }, dogecoin: { usd: 0.18 }
            });

            // Round 2
            await cluster.triggerOracleRound(0);
            await new Promise(r => setTimeout(r, 500));
            let round2 = cluster.getHub(0).oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round2);

            // getprice returns the latest round
            let btc = await callRpc(port, 'getprice', { coin_pair: 'BTC/USD' });
            expect(btc.result.price).to.equal('105000.00000000');

            // getpricesnapshots returns both rounds
            let snapshots = await callRpc(port, 'getpricesnapshots', { limit: 10 });
            let btcSnapshots = snapshots.result.filter(s => s.coin_pair === 'BTC/USD' && s.status === 'finalized');
            expect(btcSnapshots.length).to.equal(2);
        });
    });
});
