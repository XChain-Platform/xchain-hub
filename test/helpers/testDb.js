'use strict';

const mariadb  = require('mariadb');
const Database = require('../../src/db');

const DB_HOST = process.env.TEST_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.TEST_DB_PORT) || 3306;
const DB_NAME = process.env.TEST_DB_NAME || 'xchain_hub_test';
const DB_USER = process.env.TEST_DB_USER || 'root';
const DB_PASS = process.env.TEST_DB_PASS || '';

const ALL_TABLES = [
    'attestations', 'configs', 'consensus_state', 'governance_proposals',
    'governance_votes', 'oracle_submissions', 'p2p_peers', 'price_snapshots',
    'reorg_attestations', 'slash_proposals', 'swap_records', 'validator_rewards',
    'validators'
];

let db        = null;
let available = false;

/**
 * Create the test database and verify all tables.
 * Call once in a top-level before() hook.
 */
async function setup() {
    let conn;
    try {
        conn = await mariadb.createConnection({
            host:           DB_HOST,
            port:           DB_PORT,
            user:           DB_USER,
            password:       DB_PASS,
            connectTimeout: 5000
        });
        await conn.query('CREATE DATABASE IF NOT EXISTS `' + DB_NAME + '`');
        await conn.end();
    } catch (e) {
        if (conn) await conn.end().catch(() => {});
        throw e;
    }

    db = new Database(DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS);
    await db.verifyTables();
    available = true;
}

/**
 * Truncate every table between tests for isolation.
 */
async function truncateAll() {
    if (!db) return;
    await db.doQuery('SET FOREIGN_KEY_CHECKS = 0');
    for (let table of ALL_TABLES) {
        await db.doQuery('TRUNCATE TABLE `' + table + '`');
    }
    await db.doQuery('SET FOREIGN_KEY_CHECKS = 1');
}

/**
 * Close the connection pool. Call in after().
 */
async function teardown() {
    if (db) {
        await db.close();
        db = null;
    }
    available = false;
}

function getDb()      { return db; }
function isAvailable() { return available; }

module.exports = { setup, teardown, truncateAll, getDb, isAvailable };
