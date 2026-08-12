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

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');
const { waitUntil }     = require('../helpers/waitUntil');

// getFeeQuote refuses to quote without a finalized XCHAIN/USD oracle price
// (fails closed); the oracle round only finalizes coin/USD pairs, so tests
// seed the XCHAIN=$1 placeholder directly.
async function seedXchainUsd(cluster) {
    await cluster.getDb().doQuery(
        `INSERT INTO price_snapshots (round_number, coin_pair, price, validator_count, consensus_proof, status)
         VALUES (1, 'XCHAIN/USD', '1.00000000', 1, '{}', 'finalized')`
    );
}

describe('E2E: Fee Quote Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable: skipping E2E fee tests');
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

    // E2E-FEE-001: Fee quote uses live oracle prices
    describe('E2E-FEE-001: Fee quote from oracle data', function () {

        it('calculates fee quote using finalized BTC/USD price', async function () {
            this.timeout(15000);

            priceMocks.mockCoinGeckoSuccess({
                bitcoin: { usd: 100000 }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 }
            });

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Run oracle round to populate prices
            await cluster.triggerOracleRound(0);
            let round = cluster.getHub(0).oracle.getCurrentRound();
            await waitUntil(async () => {
                let rows = await cluster.getDb().doQuery('SELECT 1 FROM oracle_submissions WHERE round_number = ?', [round]);
                return rows.length > 0;
            }, { timeoutMs: 10000, label: 'the round submission row to land' });
            await cluster.triggerOracleFinalization(0, round);

            // getFeeQuote fails closed without a finalized XCHAIN/USD price
            // (native-fee hub-DB gate); XCHAIN/USD comes from user-published
            // PRICE actions, not the oracle round, so seed the $1 placeholder.
            await seedXchainUsd(cluster);

            // Get fee quote for ISSUE action on BTC
            let fee = await callRpc(port, 'getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(fee.result.action).to.equal('ISSUE');
            expect(fee.result.chain).to.equal('BTC');
            expect(fee.result.gasCost).to.equal(100000);
            expect(fee.result.gasPrice).to.equal('0.00001000');
            expect(fee.result.xchainAmount).to.equal('1.00000000');

            // With BTC/USD at $100,000 and XCHAIN=$1 placeholder:
            // native amount = $1 / $100,000 = 0.00001000 BTC
            expect(fee.result.coinUsd).to.equal('100000.00000000');
            expect(fee.result.nativeCoinAmount).to.exist;
            let nativeAmount = parseFloat(fee.result.nativeCoinAmount);
            expect(nativeAmount).to.be.greaterThan(0);
        });

        it('calculates different gas costs for different actions', async function () {
            this.timeout(15000);

            priceMocks.mockCoinGeckoSuccess();

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);
            await seedXchainUsd(cluster);

            // ISSUE = 100k gas, ISSUE_SUBTOKEN = 50k gas
            let issue = await callRpc(port, 'getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(issue.result.gasCost).to.equal(100000);

            let subtoken = await callRpc(port, 'getfeequote', { action: 'ISSUE_SUBTOKEN', chain: 'BTC' });
            expect(subtoken.result.gasCost).to.equal(50000);

            let vmDeploy = await callRpc(port, 'getfeequote', { action: 'VM_DEPLOY_BASE', chain: 'BTC' });
            expect(vmDeploy.result.gasCost).to.equal(100000);
        });
    });

    // E2E-FEE-002: No oracle data (partial response)
    describe('E2E-FEE-002: Fee quote without oracle data', function () {

        it('returns gas info without native coin conversion when no price data', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // XCHAIN/USD alone (the fail-closed minimum); no BTC/USD data
            await seedXchainUsd(cluster);
            let fee = await callRpc(port, 'getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(fee.result.gasCost).to.equal(100000);
            expect(fee.result.xchainAmount).to.equal('1.00000000');
            // No native coin conversion without coin price data
            expect(fee.result.nativeCoinAmount).to.not.exist;
        });

        it('returns error for unknown action', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            let fee = await callRpc(port, 'getfeequote', { action: 'NONEXISTENT', chain: 'BTC' });
            expect(fee.result.error).to.include('unknown action');
        });
    });
});
