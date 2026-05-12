'use strict';

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');

describe('E2E: Fee Quote Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E fee tests');
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
            await new Promise(r => setTimeout(r, 500));
            let round = cluster.getHub(0).oracle.getCurrentRound();
            await cluster.triggerOracleFinalization(0, round);

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

            // ISSUE = 100k gas, ISSUE_SUBTOKEN = 50k gas
            let issue = await callRpc(port, 'getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(issue.result.gasCost).to.equal(100000);

            let subtoken = await callRpc(port, 'getfeequote', { action: 'ISSUE_SUBTOKEN', chain: 'BTC' });
            expect(subtoken.result.gasCost).to.equal(50000);

            let vmDeploy = await callRpc(port, 'getfeequote', { action: 'VM_DEPLOY_BASE', chain: 'BTC' });
            expect(vmDeploy.result.gasCost).to.equal(100000);
        });
    });

    // E2E-FEE-002: No oracle data — partial response
    describe('E2E-FEE-002: Fee quote without oracle data', function () {

        it('returns gas info without native coin conversion when no price data', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // No oracle round run — no price data
            let fee = await callRpc(port, 'getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(fee.result.gasCost).to.equal(100000);
            expect(fee.result.xchainAmount).to.equal('1.00000000');
            // No native coin conversion without price data
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
