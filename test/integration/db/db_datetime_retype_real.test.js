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

const mariadb = require('mariadb');
const { expect } = require('chai');
const Database = require('../../../src/db');
const { DATETIME_COLUMNS } = require('../../../src/db/schema/datetime_columns.js');
const testDb = require('../../helpers/testDb');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_NAME = process.env.TEST_DB_NAME || 'xchain_hub_test';
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';
const FRESH_DB_NAME = DB_NAME + '_datetime_retype_fresh';
const STORED_TIME = '2026-01-15 12:34:56';
const SHIFTED_TIME = '2026-01-15 06:34:56';

let db;
let freshDb;

describe('Integration: DATETIME retype on a real MariaDB', function () {
    registerHooks();
    it('preserves stored times, definitions, and idempotence', rehearseDatetimeRetype);
});

function registerHooks() {
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
            await rebuildSchema(db);
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping the real DATETIME retype test');
            this.skip();
        }
    });

    after(async function () {
        if (db) await dropAllTables(db);
        if (freshDb) {
            await freshDb.close();
            await dropDatabase(FRESH_DB_NAME);
        }
        await testDb.teardown();
    });
}

async function rehearseDatetimeRetype() {
    this.timeout(300000);
    await ageDatetimeColumns();
    await insertFixtures();

    // Prove the aged columns still render stored instants through the session zone.
    expect(await readFixtureTimes()).to.deep.equal([SHIFTED_TIME, SHIFTED_TIME, SHIFTED_TIME]);

    await db.runDatetimeColumnMigrations();
    const migrated = await columnMetadata(db);
    // Verify every listed column migrated and now ignores the session zone.
    expect(Object.values(migrated).map(v => v.dataType)).to.deep.equal(
        DATETIME_COLUMNS.map(() => 'datetime'));
    expect(await readFixtureTimes()).to.deep.equal([STORED_TIME, STORED_TIME, STORED_TIME]);

    await db.runDatetimeColumnMigrations();
    // Verify the second pass changes neither definitions nor stored values.
    expect(await columnMetadata(db)).to.deep.equal(migrated);
    expect(await readFixtureTimes()).to.deep.equal([STORED_TIME, STORED_TIME, STORED_TIME]);

    freshDb = new Database(DB_HOST, DB_PORT, FRESH_DB_NAME, DB_USER, DB_PASS);
    await freshDb.createDatabase();
    await rebuildSchema(freshDb);
    // Verify the migrated definitions exactly match a fresh installation.
    expect(definitionFields(migrated)).to.deep.equal(definitionFields(await columnMetadata(freshDb)));
}

async function rebuildSchema(database) {
    await dropAllTables(database);
    await database.verifyTables();
}

async function dropAllTables(database) {
    const rows = await database.doQuery(
        'SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
        [database.dbName]
    );
    await database.doQuery('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const row of rows) await database.doQuery('DROP TABLE IF EXISTS `' + row.tableName + '`');
    } finally {
        await database.doQuery('SET FOREIGN_KEY_CHECKS = 1');
    }
}

async function ageDatetimeColumns() {
    for (const entry of DATETIME_COLUMNS) {
        const timestampDef = entry.columnDef.replace(/^DATETIME\b/, 'TIMESTAMP');
        await db.doQuery('ALTER TABLE `' + entry.table + '` MODIFY `' + entry.column + '` ' + timestampDef);
    }
}

async function withRawConnection(dbName, timeZone, action) {
    const connection = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: dbName
    });
    try {
        await connection.query('SET time_zone = ?', [timeZone]);
        return await action(connection);
    } finally {
        await connection.end();
    }
}

async function insertFixtures() {
    await withRawConnection(DB_NAME, '+00:00', async connection => {
        await connection.query(
            'INSERT INTO price_snapshots ' +
            '(round_number, coin_pair, validator_count, consensus_proof, status, created_at) ' +
            'VALUES (1, ?, 1, ?, ?, ?)', ['BTC/USD', '{}', 'finalized', STORED_TIME]);
        await connection.query(
            'INSERT INTO cross_chain_matches ' +
            '(match_id, snapshot_block, network, a_chain, a_action_index, a_amount, a_payout_addr, ' +
            'b_chain, b_action_index, b_amount, b_payout_addr, effective_time, validator_signatures, created_at) ' +
            'VALUES (?, 1, ?, ?, 1, ?, ?, ?, 2, ?, ?, 1, ?, ?)',
            ['datetime-probe', 'regtest', 'BTC', '1', 'a', 'LTC', '1', 'b', '[]', STORED_TIME]);
        await connection.query(
            'INSERT INTO attestations ' +
            '(attestation_id, source_chain, source_action_index, dest_chain, updated_at) ' +
            'VALUES (?, ?, 1, ?, ?)', ['datetime-probe', 'BTC', 'LTC', STORED_TIME]);
    });
}

async function readFixtureTimes() {
    return withRawConnection(DB_NAME, '-06:00', async connection => {
        const format = "DATE_FORMAT(??, '%Y-%m-%d %H:%i:%s') AS rendered";
        const targets = [
            ['price_snapshots', 'created_at'],
            ['cross_chain_matches', 'created_at'],
            ['attestations', 'updated_at']
        ];
        const values = [];
        for (const [table, column] of targets) {
            const sql = 'SELECT ' + format.replace('??', '`' + column + '`') +
                ' FROM `' + table + '` LIMIT 1';
            const rows = await connection.query(sql);
            values.push(rows[0].rendered);
        }
        return values;
    });
}

async function columnMetadata(database) {
    const metadata = {};
    for (const entry of DATETIME_COLUMNS) {
        const rows = await database.doQuery(
            'SELECT DATA_TYPE AS dataType, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, ' +
            'COLUMN_DEFAULT AS columnDefault, EXTRA AS extra FROM information_schema.COLUMNS ' +
            'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            [database.dbName, entry.table, entry.column]
        );
        // Require the full migration list to name live columns in both schemas.
        expect(rows, entry.table + '.' + entry.column + ' is missing').to.have.lengthOf(1);
        metadata[entry.table + '.' + entry.column] = rows[0];
    }
    return metadata;
}

function definitionFields(metadata) {
    return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, {
        columnType: value.columnType,
        isNullable: value.isNullable,
        columnDefault: value.columnDefault,
        extra: value.extra
    }]));
}

async function dropDatabase(dbName) {
    const connection = await mariadb.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS
    });
    try {
        await connection.query('DROP DATABASE IF EXISTS `' + dbName + '`');
    } finally {
        await connection.end();
    }
}
