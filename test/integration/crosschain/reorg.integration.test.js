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

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const testDb         = require('../../helpers/testDb');
const { buildEnvelope } = require('../../helpers/testPeerNetwork');
const { VALIDATORS_1, VALIDATORS_4 } = require('../../helpers/fixtures');
const ReorgHandler   = require('../../../src/ReorgHandler');

function createTestHub(db, validatorAddr) {
    let pm = new EventEmitter();
    pm.validatorAddr    = validatorAddr || 'ws://validator-1:10001';
    pm.validatorPubkeys = new Map();
    pm.broadcast        = sinon.stub().callsFake((type, data) => {
        return { type, id: 'msg-' + Date.now(), sender: pm.validatorAddr, timestamp: Date.now(), data };
    });
    pm.getPeerStatus    = sinon.stub().returns([]);

    return {
        db: db,
        p2pConfig: {},
        getPeerManager: sinon.stub().returns(pm),
        getIdentity:    sinon.stub().returns(null),
        getOracle:      sinon.stub().returns(null),
        getConsensus:   sinon.stub().returns(null),
        getCrossChain:  sinon.stub().returns(null),
        _peerManager:   pm
    };
}

describe('Integration: Reorg Handling (SC-5.x)', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping reorg tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    // SC-5.1: Reorg rollback of attestations and price disputes
    describe('SC-5.1: Rollback cascading writes', function () {
        it('deletes attestations after reorg timestamp and disputes price snapshots', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let reorgTimestamp = Date.now() - 60000; // 1 minute ago

            // Insert attestations: 2 before reorg, 3 after
            for (let i = 1; i <= 5; i++) {
                let createdAt = i <= 2
                    ? new Date(reorgTimestamp - 120000) // 2 min before reorg
                    : new Date(reorgTimestamp + i * 1000); // after reorg

                await db.doQuery(
                    `INSERT INTO attestations
                        (attestation_id, source_chain, source_action_index, dest_chain,
                         confirmations, status, validator_count, consensus_proof, created_at)
                     VALUES (?, 'BTC', ?, 'LTC', 3, 'attested', 1, '[]', ?)`,
                    ['BTC:' + i + ':LTC', i, createdAt]
                );
            }

            // Insert price snapshots (some after reorg timestamp)
            for (let i = 1; i <= 4; i++) {
                let ts = i <= 2 ? reorgTimestamp - 120000 : reorgTimestamp + i * 1000;
                await db.doQuery(
                    `INSERT INTO price_snapshots
                        (round_number, coin_pair, price, reference_block, reference_chain,
                         block_timestamp, validator_count, consensus_round, consensus_proof, status)
                     VALUES (?, 'BTC/USD', '100000.00000000', 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                    [i, ts]
                );
            }

            // Track reorg event
            let reorgEvent = null;
            let reorgHandler = new ReorgHandler(hub);
            reorgHandler.setValidatorSet(VALIDATORS_1);
            await reorgHandler.start();
            reorgHandler.on('reorg:confirmed', (e) => { reorgEvent = e; });

            await reorgHandler.reportReorg('BTC', 800000, reorgTimestamp);

            await new Promise(r => setTimeout(r, 200));

            // Verify: attestations after reorg timestamp should be deleted
            let remainingAtts = await db.doQuery("SELECT * FROM attestations WHERE source_chain = 'BTC'");
            expect(remainingAtts).to.have.lengthOf(2);
            // Only the ones created before the reorg timestamp should remain
            for (let att of remainingAtts) {
                expect(att.source_action_index).to.be.at.most(2);
            }

            // Verify: price snapshots after reorg timestamp should be disputed
            let disputed = await db.doQuery("SELECT * FROM price_snapshots WHERE status = 'disputed'");
            expect(disputed.length).to.be.greaterThan(0);

            let finalized = await db.doQuery("SELECT * FROM price_snapshots WHERE status = 'finalized'");
            expect(finalized).to.have.lengthOf(2);

            // Verify: reorg_attestations record created
            let reorgs = await db.doQuery("SELECT * FROM reorg_attestations");
            expect(reorgs).to.have.lengthOf(1);
            expect(reorgs[0].source_chain).to.equal('BTC');
            expect(reorgs[0].reorg_height).to.equal(800000);
            expect(reorgs[0].status).to.equal('confirmed');

            // Verify affected chains
            let affected = JSON.parse(reorgs[0].affected_chains);
            expect(affected).to.include('LTC');
            expect(affected).to.include('DOGE');
            expect(affected).to.not.include('BTC');

            // Verify event emitted
            expect(reorgEvent).to.not.be.null;
            expect(reorgEvent.sourceChain).to.equal('BTC');

            await reorgHandler.stop();
        });
    });

    // SC-5.2: Reorg consensus requirement (multi-validator)
    describe('SC-5.2: Reorg with multi-validator consensus', function () {
        it('finalizes reorg after PREPARE and COMMIT quorum', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_4[0].addr);

            // Insert a test attestation that should be rolled back
            let reorgTimestamp = Date.now() - 10000;
            await db.doQuery(
                `INSERT INTO attestations
                    (attestation_id, source_chain, source_action_index, dest_chain,
                     confirmations, status, validator_count, consensus_proof, created_at)
                 VALUES ('BTC:99:LTC', 'BTC', 99, 'LTC', 3, 'attested', 1, '[]', ?)`,
                [new Date(reorgTimestamp + 5000)]
            );

            let reorgHandler = new ReorgHandler(hub);
            reorgHandler.setValidatorSet(VALIDATORS_4);
            await reorgHandler.start();

            let reorgEvent = null;
            reorgHandler.on('reorg:confirmed', (e) => { reorgEvent = e; });

            // Report reorg — initiates consensus
            await reorgHandler.reportReorg('BTC', 800000, reorgTimestamp);

            await new Promise(r => setTimeout(r, 50));

            // Get the pending reorg
            let reorgId = 'BTC:800000:' + reorgTimestamp;
            let pending = reorgHandler.pendingReorgs.get(reorgId);
            expect(pending).to.exist;

            // Inject PREPARE from 2 other validators (quorum = 3 for N=4)
            for (let i = 1; i < 3; i++) {
                hub._peerManager.emit('message', buildEnvelope('XCHAIN_REORG_PREPARE', {
                    reorgId: reorgId,
                    chain: 'BTC',
                    reorgHeight: 800000,
                    timestamp: reorgTimestamp,
                    affectedChains: ['LTC', 'DOGE'],
                    digest: pending.digest
                }, VALIDATORS_4[i].addr));
            }

            await new Promise(r => setTimeout(r, 50));

            // Inject COMMIT from 2 other validators
            for (let i = 1; i < 3; i++) {
                hub._peerManager.emit('message', buildEnvelope('XCHAIN_REORG_COMMIT', {
                    reorgId: reorgId,
                    digest: pending.digest
                }, VALIDATORS_4[i].addr));
            }

            await new Promise(r => setTimeout(r, 300));

            // Verify rollback executed
            let atts = await db.doQuery("SELECT * FROM attestations WHERE attestation_id = 'BTC:99:LTC'");
            expect(atts).to.have.lengthOf(0);

            // Verify reorg recorded
            let reorgs = await db.doQuery("SELECT * FROM reorg_attestations WHERE reorg_id = ?", [reorgId]);
            expect(reorgs).to.have.lengthOf(1);

            expect(reorgEvent).to.not.be.null;

            await reorgHandler.stop();
        });
    });

    // SC-5.3: Duplicate reorg report prevention
    describe('SC-5.3: Duplicate reorg prevention', function () {
        it('ignores duplicate reorg reports after processing', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let reorgHandler = new ReorgHandler(hub);
            reorgHandler.setValidatorSet(VALIDATORS_1);
            await reorgHandler.start();

            let reorgTimestamp = Date.now() - 10000;

            // Report same reorg twice
            await reorgHandler.reportReorg('BTC', 800000, reorgTimestamp);
            await reorgHandler.reportReorg('BTC', 800000, reorgTimestamp);

            await new Promise(r => setTimeout(r, 200));

            // Should only have one reorg record
            let reorgs = await db.doQuery("SELECT * FROM reorg_attestations");
            expect(reorgs).to.have.lengthOf(1);

            await reorgHandler.stop();
        });
    });
});
