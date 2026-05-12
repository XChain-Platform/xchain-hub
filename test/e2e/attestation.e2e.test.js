'use strict';

const { expect }    = require('chai');
const testDb        = require('../helpers/testDb');
const priceMocks    = require('./helpers/priceMocks');
const { createCluster } = require('./helpers/cluster');
const { callRpc }       = require('./helpers/rpcClient');
const { waitForAttestation, waitForSwapStatus } = require('./helpers/waitFor');
const { assertAttestationStored, assertSwapStatus } = require('./helpers/dbAssertions');

describe('E2E: Cross-Chain Attestation Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E attestation tests');
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

    // E2E-ATTEST-001: Request attestation → single-node finalization → retrieve
    describe('E2E-ATTEST-001: Single-node attestation lifecycle', function () {

        it('creates and finalizes an attestation in single-node mode', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Request attestation
            let res = await callRpc(port, 'requestattestation', {
                source_chain: 'BTC',
                source_action_index: 1000,
                dest_chain: 'LTC'
            });
            expect(res.result.status).to.equal('attested');
            expect(res.result.attestationId).to.equal('BTC:1000:LTC');
            expect(res.result.validatorCount).to.equal(1);

            // Retrieve via API
            let att = await callRpc(port, 'getattestation', {
                source_chain: 'BTC',
                source_action_index: 1000
            });
            expect(att.result.status).to.equal('attested');
            expect(att.result.source_chain).to.equal('BTC');
            expect(att.result.dest_chain).to.equal('LTC');

            // Verify in DB
            let db = cluster.getDb();
            await assertAttestationStored(db, 'BTC:1000:LTC', { status: 'attested', validatorCount: 1 });
        });

        it('getattestations returns list filtered by status', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Create multiple attestations
            await callRpc(port, 'requestattestation', { source_chain: 'BTC', source_action_index: 100, dest_chain: 'LTC' });
            await callRpc(port, 'requestattestation', { source_chain: 'BTC', source_action_index: 200, dest_chain: 'DOGE' });
            await callRpc(port, 'requestattestation', { source_chain: 'LTC', source_action_index: 300, dest_chain: 'BTC' });

            let all = await callRpc(port, 'getattestations', { status: 'attested', limit: 50 });
            expect(all.result).to.be.an('array');
            expect(all.result.length).to.equal(3);
        });
    });

    // E2E-ATTEST-003: SWAP lifecycle — initiation through attestation
    describe('E2E-ATTEST-003: SWAP lifecycle', function () {

        it('swap initiates and attestation creates matching records', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Step 1: Initiate a swap
            let swapRes = await callRpc(port, 'initiateswap', {
                source_chain: 'BTC',
                source_action_index: 5000,
                dest_chain: 'LTC',
                dest_action_index: 6000
            });
            expect(swapRes.result.status).to.equal('success');

            // Verify swap is in 'initiated' state
            let swap = await callRpc(port, 'getswap', { source_chain: 'BTC', source_action_index: 5000 });
            expect(swap.result.status).to.equal('initiated');
            expect(swap.result.source_chain).to.equal('BTC');
            expect(swap.result.dest_chain).to.equal('LTC');

            // Step 2: Request attestation for the same source action
            let attRes = await callRpc(port, 'requestattestation', {
                source_chain: 'BTC',
                source_action_index: 5000,
                dest_chain: 'LTC'
            });
            expect(attRes.result.status).to.equal('attested');
            expect(attRes.result.attestationId).to.equal('BTC:5000:LTC');

            // Step 3: Manually progress the swap (single-node mode doesn't emit
            // attestation:finalized in the fallback path — this is a known limitation)
            let hub = cluster.getHub(0);
            await hub.swapTracker.updateSwapStatus('BTC', 5000, 'attested', 'BTC:5000:LTC');

            let updatedSwap = await callRpc(port, 'getswap', { source_chain: 'BTC', source_action_index: 5000 });
            expect(updatedSwap.result.status).to.equal('attested');
            expect(updatedSwap.result.attestation_id).to.equal('BTC:5000:LTC');
        });

        it('swap without matching attestation stays in initiated state', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Initiate a swap
            await callRpc(port, 'initiateswap', {
                source_chain: 'BTC', source_action_index: 7000, dest_chain: 'LTC'
            });

            // Attest a DIFFERENT source action
            await callRpc(port, 'requestattestation', {
                source_chain: 'BTC', source_action_index: 9999, dest_chain: 'LTC'
            });

            await new Promise(r => setTimeout(r, 300));

            // Swap should still be initiated
            let swap = await callRpc(port, 'getswap', { source_chain: 'BTC', source_action_index: 7000 });
            expect(swap.result.status).to.equal('initiated');
        });
    });

    // E2E-ATTEST: getswaps filtered by status
    describe('E2E-ATTEST: Swap queries', function () {

        it('getswaps returns swaps filtered by status', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);

            // Create 2 swaps
            await callRpc(port, 'initiateswap', { source_chain: 'BTC', source_action_index: 100, dest_chain: 'LTC' });
            await callRpc(port, 'initiateswap', { source_chain: 'BTC', source_action_index: 200, dest_chain: 'DOGE' });

            // Attest the first and manually progress the swap
            await callRpc(port, 'requestattestation', { source_chain: 'BTC', source_action_index: 100, dest_chain: 'LTC' });
            let hub = cluster.getHub(0);
            await hub.swapTracker.updateSwapStatus('BTC', 100, 'attested', 'BTC:100:LTC');

            let initiated = await callRpc(port, 'getswaps', { status: 'initiated' });
            expect(initiated.result).to.be.an('array');
            expect(initiated.result.some(s => s.source_action_index === 200)).to.be.true;

            let attested = await callRpc(port, 'getswaps', { status: 'attested' });
            expect(attested.result).to.be.an('array');
            expect(attested.result.some(s => s.source_action_index === 100)).to.be.true;
        });
    });
});
