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

// Integration: _widenUniqueKey against a real MariaDB.
//
// The unit tier models the DDL; this tier runs it. That distinction is the whole
// point of the defect being fixed: the failing statement was a real
// ALTER TABLE ... ADD UNIQUE KEY that returned errno 1072 because the table did
// not carry the column the wider key names, and the damage was done by the DROP
// that had already run in front of it. Only a server can produce that pair.
//
// The table is a throwaway shaped like an aged capability_snapshots (narrow key,
// widen column not yet added). It is created and dropped by the test, so nothing
// the hub reads is touched.

const { expect } = require('chai');
const testDb     = require('../../helpers/testDb');

const TABLE = 'widen_key_probe';
const KEY   = 'uq_probe';
const WIDE  = '(snapshot_block, capability, signing_pubkey, source)';

// Columns of a live index, in key order.
async function indexColumns(db, table, indexName) {
    const rows = await db.doQuery(
        'SELECT column_name AS col FROM information_schema.statistics ' +
        'WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY seq_in_index',
        [table, indexName]
    );
    return rows.map(r => String(r.col).toLowerCase());
}

async function uniqueIndexNames(db, table) {
    const rows = await db.doQuery(
        'SELECT DISTINCT index_name AS n FROM information_schema.statistics ' +
        'WHERE table_schema = DATABASE() AND table_name = ? AND non_unique = 0 AND index_name <> ?',
        [table, 'PRIMARY']
    );
    return rows.map(r => String(r.n)).sort();
}

async function insertRow(db, source) {
    const cols = source === null
        ? '(snapshot_block, capability, signing_pubkey)'
        : '(snapshot_block, capability, signing_pubkey, source)';
    const vals = source === null ? [100, 'price', 'aa'] : [100, 'price', 'aa', source];
    const marks = vals.map(() => '?').join(', ');
    await db.doQuery('INSERT INTO `' + TABLE + '` ' + cols + ' VALUES (' + marks + ')', vals);
}

describe('Integration: _widenUniqueKey on a real MariaDB', function () {

    let db;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.warn('MariaDB unavailable; skipping the real-DDL widen tests');
        }
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) this.skip();
        await db.doQuery('DROP TABLE IF EXISTS `' + TABLE + '`');
        await db.doQuery(
            'CREATE TABLE `' + TABLE + '` (' +
            '  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,' +
            '  snapshot_block BIGINT UNSIGNED NOT NULL,' +
            '  capability VARCHAR(32) NOT NULL,' +
            '  signing_pubkey VARCHAR(64) NOT NULL,' +
            '  PRIMARY KEY (id),' +
            '  UNIQUE KEY `' + KEY + '` (snapshot_block, capability, signing_pubkey)' +
            ') ENGINE=InnoDB'
        );
    });

    after(async function () {
        if (testDb.isAvailable()) await db.doQuery('DROP TABLE IF EXISTS `' + TABLE + '`').catch(() => {});
        await testDb.teardown();
    });

    // The production incident, reproduced: the widen column is genuinely absent, so
    // the server really does answer errno 1072. The old sequence left this table with
    // zero indexes and accepted the duplicate below.
    it('leaves a working unique key when the widen column is missing from the table', async function () {
        await db._widenUniqueKey(TABLE, KEY, 'source', WIDE);

        expect(await indexColumns(db, TABLE, KEY)).to.deep.equal(
            ['snapshot_block', 'capability', 'signing_pubkey']);
        expect(await uniqueIndexNames(db, TABLE)).to.deep.equal([KEY]);

        await insertRow(db, null);
        let dup = null;
        try { await insertRow(db, null); } catch (e) { dup = e; }
        expect(dup, 'the table accepted a duplicate, so the key is gone').to.be.an('error');
        expect(dup.errno).to.equal(1062);
    });

    it('widens the key once the column exists, and retires the temporary index', async function () {
        await db.doQuery('ALTER TABLE `' + TABLE + "` ADD COLUMN source VARCHAR(255) NOT NULL DEFAULT ''");
        await db._widenUniqueKey(TABLE, KEY, 'source', WIDE);

        expect(await indexColumns(db, TABLE, KEY)).to.deep.equal(
            ['snapshot_block', 'capability', 'signing_pubkey', 'source']);
        expect(await uniqueIndexNames(db, TABLE), 'a temporary index was left behind').to.deep.equal([KEY]);

        // The widened key is what the snapshot mirror needs: two staking sources
        // delegating one signing key are two rows, not one absorbed duplicate.
        await insertRow(db, 'source-a');
        await insertRow(db, 'source-b');
        const rows = await db.doQuery('SELECT COUNT(*) AS c FROM `' + TABLE + '`');
        expect(Number(rows[0].c)).to.equal(2);
    });

    it('is a no-op on a second run, and never re-drops the key', async function () {
        await db.doQuery('ALTER TABLE `' + TABLE + "` ADD COLUMN source VARCHAR(255) NOT NULL DEFAULT ''");
        await db._widenUniqueKey(TABLE, KEY, 'source', WIDE);
        await db._widenUniqueKey(TABLE, KEY, 'source', WIDE);

        expect(await indexColumns(db, TABLE, KEY)).to.have.lengthOf(4);
        expect(await uniqueIndexNames(db, TABLE)).to.deep.equal([KEY]);
    });

    // A run interrupted between the temporary ADD and the rename leaves the wider
    // key under the temporary name. The next run must finish it, never restart it
    // from a state with no key.
    it('completes an interrupted widen left behind by an earlier run', async function () {
        await db.doQuery('ALTER TABLE `' + TABLE + "` ADD COLUMN source VARCHAR(255) NOT NULL DEFAULT ''");
        await db.doQuery('ALTER TABLE `' + TABLE + '` ADD UNIQUE KEY `' + KEY + '_widening` ' + WIDE);
        await db.doQuery('ALTER TABLE `' + TABLE + '` DROP INDEX `' + KEY + '`');

        await db._widenUniqueKey(TABLE, KEY, 'source', WIDE);

        expect(await indexColumns(db, TABLE, KEY)).to.have.lengthOf(4);
        expect(await uniqueIndexNames(db, TABLE)).to.deep.equal([KEY]);
    });
});
