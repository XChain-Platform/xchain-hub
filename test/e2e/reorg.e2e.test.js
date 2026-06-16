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
const { assertReorgConfirmed } = require('./helpers/dbAssertions');

describe('E2E: Reorg Handling Pipeline', function () {

    let cluster;

    before(async function () {
        this.timeout(15000);
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping E2E reorg tests');
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

    // E2E-REORG-001: Reorg detection → consensus → rollback cascade
    describe('E2E-REORG-001: Rollback cascade', function () {

        it('deletes attestations and records reorg after report', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);
            let db = cluster.getDb();

            // Step 1: Create an attestation for BTC chain
            await callRpc(port, 'requestattestation', {
                source_chain: 'BTC', source_action_index: 1000, dest_chain: 'LTC'
            });

            // Verify attestation exists
            let attBefore = await db.doQuery("SELECT * FROM attestations WHERE source_chain = 'BTC'");
            expect(attBefore.length).to.equal(1);

            // Step 2: Report reorg with a timestamp well before the attestation was created
            // Use timestamp = 1 (epoch start) to ensure all data is affected
            let reorgRes = await callRpc(port, 'reportreorg', {
                chain: 'BTC', reorg_height: 799999, timestamp: 1
            });
            expect(reorgRes.result.status).to.equal('success');

            // Wait for rollback — the reorgHandler in single-node mode (quorum=0)
            // executes _executeRollback synchronously within the reportReorg call,
            // but the JSON-RPC response arrives after the await completes.
            await new Promise(r => setTimeout(r, 2000));

            // Step 3: Verify rollback effects
            // Attestations for BTC created after epoch should be deleted (all of them)
            let attAfter = await db.doQuery("SELECT * FROM attestations WHERE source_chain = 'BTC'");
            expect(attAfter.length, 'BTC attestations should be deleted by reorg').to.equal(0);

            // Verify reorg recorded in history
            let reorgRows = await db.doQuery("SELECT * FROM reorg_attestations");
            expect(reorgRows.length, 'reorg_attestations should have entry').to.be.at.least(1);
        });
    });

    // E2E-REORG-002: Reorg on BTC doesn't affect LTC-only attestations
    describe('E2E-REORG-002: Chain isolation', function () {

        it('BTC reorg does not invalidate LTC-DOGE attestation', async function () {
            this.timeout(15000);

            cluster = createCluster(1);
            await cluster.start();
            let port = cluster.getPort(0);
            let db = cluster.getDb();

            // Create BTC→LTC attestation (should be affected)
            await callRpc(port, 'requestattestation', {
                source_chain: 'BTC', source_action_index: 1000, dest_chain: 'LTC'
            });

            // Create LTC→DOGE attestation (should NOT be affected)
            await callRpc(port, 'requestattestation', {
                source_chain: 'LTC', source_action_index: 2000, dest_chain: 'DOGE'
            });

            // Verify both exist
            let allBefore = await db.doQuery("SELECT * FROM attestations ORDER BY source_chain");
            expect(allBefore.length).to.equal(2);

            // Report BTC reorg
            let reorgTimestamp = Date.now() - 60000;
            await callRpc(port, 'reportreorg', {
                chain: 'BTC', reorg_height: 799999, timestamp: reorgTimestamp
            });
            await new Promise(r => setTimeout(r, 500));

            // BTC attestation should be deleted
            let btcAtts = await db.doQuery("SELECT * FROM attestations WHERE source_chain = 'BTC'");
            expect(btcAtts.length).to.equal(0);

            // LTC attestation should remain
            let ltcAtts = await db.doQuery("SELECT * FROM attestations WHERE source_chain = 'LTC'");
            expect(ltcAtts.length).to.equal(1);
            expect(ltcAtts[0].status).to.equal('attested');

            // Verify via API
            let ltcAtt = await callRpc(port, 'getattestation', {
                source_chain: 'LTC', source_action_index: 2000
            });
            expect(ltcAtt.result.status).to.equal('attested');
        });
    });
});
