'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('node:crypto');
const { expect } = require('chai');
const testDb = require('../../helpers/testDb');

const MIGRATION = '2026-11-27-price-snapshots-archive-anchor-stamp.sql';
const PROOF = '{"batch":{"first_round":41001,"last_round":41001,"btc_block_height":700},"sigs":[]}';
const PROOF_SHA = crypto.createHash('sha256').update(PROOF).digest('hex');
const ADMIT = { admit_block_btc: 51, admit_block_ltc: 52, admit_block_doge: 53 };
const CREATED = new Date('2026-11-27T12:00:00Z');
let db;

async function readRow(round) {
    const rows = await db.doQuery(
        'SELECT reference_block, source_action_index, batch_block_time, batch_seq, ' +
        'archived_reference_block, archived_source_action_index, archive_pending ' +
        'FROM price_snapshots WHERE round_number = ? AND coin_pair = ?', [round, 'BTC/USD']);
    expect(rows).to.have.lengthOf(1);
    return rows[0];
}

async function ageSchema() {
    await db.doQuery('CREATE TABLE IF NOT EXISTS schema_migrations (' +
        'name VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL, mode VARCHAR(16) NOT NULL, ' +
        'applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await db.doQuery('DELETE FROM schema_migrations WHERE name = ?', [MIGRATION]);
    await db.doQuery('TRUNCATE TABLE price_snapshots');
    await db.doQuery('ALTER TABLE price_snapshots DROP INDEX IF EXISTS idx_archive_pending_round');
    await db.doQuery('ALTER TABLE price_snapshots DROP COLUMN IF EXISTS archive_pending');
    await db.doQuery('ALTER TABLE price_snapshots DROP COLUMN IF EXISTS archived_source_action_index, ' +
        'DROP COLUMN IF EXISTS archived_reference_block');
    await db.doQuery('ALTER TABLE price_snapshots ADD COLUMN archive_pending TINYINT(1) ' +
        'GENERATED ALWAYS AS (batch_seq IS NULL OR archived_status <> status OR ' +
        'archived_batch_block_time <> batch_block_time OR ' +
        'archived_proof_sha <> SHA2(consensus_proof, 256)) STORED, ' +
        'ADD INDEX idx_archive_pending_round (archive_pending, round_number)');
}

async function insertStampedBatchRow() {
    await db.setBatchPriceSnapshotRound(41001, [{ pair: 'BTC/USD', price: '50000' }],
        700, 'DOGE', 1700000000, 5, PROOF, 11, 2, 1700000100, CREATED, ADMIT);
    await db.doQuery('UPDATE price_snapshots SET batch_seq = 3, archived_status = status, ' +
        'archived_batch_block_time = batch_block_time, ' +
        'archived_proof_sha = SHA2(consensus_proof, 256) WHERE round_number = 41001');
    const rows = await db.doQuery(
        'SELECT archive_pending FROM price_snapshots WHERE round_number = 41001');
    expect(Number(rows[0].archive_pending)).to.equal(0);
}

async function proveOldExpressionMissesAnchorMove() {
    await db.setBatchPriceSnapshotRound(41001, [{ pair: 'BTC/USD', price: '50000' }],
        701, 'DOGE', 1700000001, 5, PROOF, 12, 3, 1700000200, CREATED, ADMIT);
    const rows = await db.doQuery(
        'SELECT reference_block, source_action_index, archive_pending ' +
        'FROM price_snapshots WHERE round_number = 41001');
    expect(Number(rows[0].reference_block)).to.equal(701);
    expect(Number(rows[0].source_action_index)).to.equal(12);
    expect(Number(rows[0].archive_pending)).to.equal(0);
    await db.doQuery('TRUNCATE TABLE price_snapshots');
    await insertStampedBatchRow();
}

async function migrateAndCheckSeed() {
    const result = await db.runDatedMigrations({ includeManual: true, only: [MIGRATION] });
    expect(result.applied).to.deep.equal([MIGRATION]);
    const row = await readRow(41001);
    expect(Number(row.archived_reference_block)).to.equal(700);
    expect(Number(row.archived_source_action_index)).to.equal(11);
    expect(Number(row.archive_pending)).to.equal(0);
}

async function moveAnchorAndCheckPending() {
    await db.setBatchPriceSnapshotRound(41001, [{ pair: 'BTC/USD', price: '50000' }],
        701, 'DOGE', 1700000001, 5, PROOF, 12, 3, 1700000200, CREATED, ADMIT);
    const row = await readRow(41001);
    expect(Number(row.reference_block)).to.equal(701);
    expect(Number(row.source_action_index)).to.equal(12);
    expect(Number(row.batch_block_time)).to.equal(1700000100);
    expect(Number(row.archive_pending)).to.equal(1);
}

async function checkGuardedStamp() {
    const stale = await db.updatePriceSnapshotArchiveBatchSeq(
        4, 'finalized', 1700000100, PROOF_SHA, 700, 11, 41001, 'BTC/USD');
    expect(Number(stale.affectedRows)).to.equal(0);
    expect(Number((await readRow(41001)).archive_pending)).to.equal(1);
    const current = await db.updatePriceSnapshotArchiveBatchSeq(
        4, 'finalized', 1700000100, PROOF_SHA, 701, 12, 41001, 'BTC/USD');
    expect(Number(current.affectedRows)).to.equal(1);
    const row = await readRow(41001);
    expect(Number(row.archive_pending)).to.equal(0);
    expect(Number(row.archived_reference_block)).to.equal(701);
    expect(Number(row.archived_source_action_index)).to.equal(12);
}

describe('Integration: price archive anchor stamp on real MariaDB', function () {
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping the price archive anchor stamp test');
            this.skip();
        }
    });

    after(async function () {
        await testDb.teardown();
    });

    it('migrates stamped rows and re-pends an archived row when its landing anchor moves', async function () {
        await ageSchema();
        await insertStampedBatchRow();
        await proveOldExpressionMissesAnchorMove();
        await migrateAndCheckSeed();
        await moveAnchorAndCheckPending();
        await checkGuardedStamp();
    });
});
