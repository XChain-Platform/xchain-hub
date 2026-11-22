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

// A reorg rollback makes three writes (attestation DELETE, price dispute UPDATE,
// reorg_attestations row). Against a real InnoDB table, a failure in a later write
// must leave the earlier ones rolled back, so the hub is never left with attestations
// cut while the orphaned prices still read finalized.

const sinon        = require('sinon');
const { expect }   = require('chai');
const testDb       = require('../../helpers/testDb');
const { VALIDATORS_1 } = require('../../helpers/fixtures');
const ReorgHandler = require('../../../src/anchor/reorg_handler');
const { createIntegrationHub } = require('../../helpers/integrationHub');

const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

function registerPriceDisputeFailureCase() {
    it('a failed price dispute leaves the attestation DELETE rolled back', async function () {
        let db = testDb.getDb();
        let reorgTimestamp = Date.now() - 60000;
        await seedRollbackFixtures(db, reorgTimestamp);
        let before = await readRollbackState(db);

        sinon.stub(db, 'updatePriceSnapshotByBlockTimestamp').rejects(new Error('Lock wait timeout exceeded'));
        let { handler, confirmed } = await startSingleNodeHandler(db);

        let reorgId = await reportExpectingFailure(handler, reorgTimestamp);

        let after = await readRollbackState(db);
        expect(after.attestations, 'every attestation is still present').to.deep.equal(before.attestations);
        expect(after.prices, 'no price row changed status').to.deep.equal(before.prices);
        expect(after.reorgRows).to.have.lengthOf(0);
        expect(handler.processed.has(reorgId)).to.equal(false);
        expect(confirmed).to.have.lengthOf(0);
        await handler.stop();
    });
}

function registerReorgAttestationFailureCase() {
    it('a failed reorg_attestations insert leaves the DELETE and the dispute rolled back', async function () {
        let db = testDb.getDb();
        let reorgTimestamp = Date.now() - 60000;
        await seedRollbackFixtures(db, reorgTimestamp);
        let before = await readRollbackState(db);

        sinon.stub(db, 'setReorgAttestation').rejects(new Error('Connection lost: The server closed the connection.'));
        let { handler, confirmed } = await startSingleNodeHandler(db);

        let reorgId = await reportExpectingFailure(handler, reorgTimestamp);

        let after = await readRollbackState(db);
        expect(after.attestations).to.deep.equal(before.attestations);
        expect(after.prices).to.deep.equal(before.prices);
        expect(after.reorgRows).to.have.lengthOf(0);
        expect(handler.processed.has(reorgId)).to.equal(false);
        expect(confirmed).to.have.lengthOf(0);
        await handler.stop();
    });
}

function registerTransientRetryCase() {
    it('a retried attempt after a transient failure lands the whole rollback once', async function () {
        let db = testDb.getDb();
        let reorgTimestamp = Date.now() - 60000;
        await seedRollbackFixtures(db, reorgTimestamp);

        let dispute = sinon.stub(db, 'updatePriceSnapshotByBlockTimestamp');
        dispute.onFirstCall().rejects(new Error('Lock wait timeout exceeded'));
        dispute.callThrough();
        let { handler, confirmed } = await startSingleNodeHandler(db, 2);

        await handler.reportReorg('BTC', 800000, reorgTimestamp, OLD_HASH, NEW_HASH);

        let after = await readRollbackState(db);
        expect(after.attestations.map(a => a.id)).to.deep.equal(['BTC:1:LTC', 'BTC:2:LTC']);
        expect(after.prices.map(p => p.status)).to.deep.equal(['finalized', 'finalized', 'disputed', 'disputed']);
        expect(after.reorgRows).to.have.lengthOf(1);
        expect(dispute.callCount).to.equal(2);
        expect(confirmed).to.have.lengthOf(1);
        await handler.stop();
    });
}

describe('Integration: reorg rollback is all-or-nothing on MariaDB', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable, skipping reorg rollback atomicity tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    registerPriceDisputeFailureCase();
    registerReorgAttestationFailureCase();
    registerTransientRetryCase();
});

// attempts defaults to one: most cases are about what a single failed attempt leaves.
async function startSingleNodeHandler(db, attempts = 1) {
    let hub = createIntegrationHub(db, VALIDATORS_1[0].addr);
    let handler = new ReorgHandler(hub);
    sinon.stub(handler, 'verifyReorgAgainstOwnNode').resolves(true);
    handler.setValidatorSet(VALIDATORS_1);
    handler.rollbackRetryAttempts = attempts;
    handler.rollbackRetryBaseMs = 10;
    await handler.start();
    let confirmed = [];
    handler.on('reorg:confirmed', e => confirmed.push(e));
    return { handler, confirmed };
}

async function reportExpectingFailure(handler, reorgTimestamp) {
    let thrown = null;
    try {
        await handler.reportReorg('BTC', 800000, reorgTimestamp, OLD_HASH, NEW_HASH);
    } catch (err) {
        thrown = err;
    }
    expect(thrown, 'the injected write failure reaches the caller').to.be.an('error');
    return 'BTC:800000:' + reorgTimestamp;
}

// Two attestations before the reorg and three after; two price rows before and two after.
async function seedRollbackFixtures(db, reorgTimestamp) {
    for (let i = 1; i <= 5; i++) {
        let createdAt = i <= 2 ? new Date(reorgTimestamp - 120000) : new Date(reorgTimestamp + i * 1000);
        await db.doQuery(
            `INSERT INTO attestations
                (attestation_id, source_chain, source_action_index, dest_chain,
                 confirmations, status, validator_count, consensus_proof, created_at)
             VALUES (?, 'BTC', ?, 'LTC', 3, 'attested', 1, '[]', ?)`,
            ['BTC:' + i + ':LTC', i, createdAt]
        );
    }
    for (let i = 1; i <= 4; i++) {
        // block_timestamp is Unix seconds, as the oracle writes it.
        let ts = Math.floor((i <= 2 ? reorgTimestamp - 120000 : reorgTimestamp + i * 1000) / 1000);
        await db.doQuery(
            `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain,
                 block_timestamp, validator_count, consensus_round, consensus_proof, status)
             VALUES (?, 'BTC/USD', '100000.00000000', 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
            [i, ts]
        );
    }
}

async function readRollbackState(db) {
    let attestations = await db.doQuery(
        'SELECT attestation_id, status FROM attestations ORDER BY attestation_id');
    let prices = await db.doQuery(
        'SELECT round_number, status FROM price_snapshots ORDER BY round_number');
    let reorgRows = await db.doQuery('SELECT reorg_id FROM reorg_attestations');
    return {
        attestations: attestations.map(r => ({ id: r.attestation_id, status: r.status })),
        prices: prices.map(r => ({ round: Number(r.round_number), status: r.status })),
        reorgRows: Array.from(reorgRows)
    };
}
