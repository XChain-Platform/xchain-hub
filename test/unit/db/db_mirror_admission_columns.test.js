/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Every row a hub serves to an indexer's hub-DB mirror carries its admission-height
 * columns, on the REST bootstrap page a reconnecting mirror fills from exactly as on
 * the live stream.
 *
 * Why it is consensus: above the mirror-admission activation an indexer binds a row by
 * admit_block_<c> when the column holds a height and by effective_time (the legacy rule)
 * when it is NULL. A bootstrap select that omits the columns stores NULLs, so a mirror
 * that reconnected and a mirror that streamed the same row read different admitted sets
 * at one block. On the rail a call admitted at BTC 107 was read at B=104.
 *
 * The admission column set per table is read from the hub's own DDL (src/sql), never
 * restated here, so a table that gains an admission column is covered the moment it
 * does. The db stand-in PROJECTS each statement's select list over a seeded row with
 * every DDL column, so a column dropped from a list comes back missing, and a column the
 * table does not have is an error, as MariaDB would make it.
 ********************************************************************/

'use strict';

const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const express   = require('express');
const { expect } = require('chai');

const Database = require('../../../src/db');
const { mountSnapshotRoutes } = require('../../../src/api/rest/hub_db_snapshot.js');
const { bigIntReplacer }      = require('../../../src/lib/bigint_replacer.js');
const callFinalize  = require('../../../src/cross_chain/call/finalize.js');
const dexFinalize   = require('../../../src/cross_chain/dex/finalize.js');
const bridgePersist = require('../../../src/cross_chain/bridge/persist.js');
const rewardPart    = require('../../../src/anchor/publisher/reward.js');
const attestBatch   = require('../../../src/attestation/response_mirror/batch.js');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');

// Column names of one table's CREATE TABLE, in DDL order. A column line starts with a
// lower-case identifier followed by an upper-case type; KEY/UNIQUE/PRIMARY lines do not.
function ddlColumns(table) {
    let text = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
    let body = text.slice(text.indexOf('CREATE TABLE'));
    let cols = [];
    for (let line of body.split('\n')) {
        let m = line.match(/^\s+([a-z_][a-z0-9_]*)\s+[A-Z]/);
        if (m) cols.push(m[1]);
    }
    return cols;
}

function admissionColumns(table) {
    return ddlColumns(table).filter(c => /^admit_block(_[a-z]+)?$/.test(c));
}

// Every hub DDL table that defines an admission column: the mirrored set this file
// must cover. Measured from src/sql rather than listed, so the coverage guard below
// fails when a table gains a column and no bootstrap case follows it.
function tablesWithAdmissionColumns() {
    return fs.readdirSync(SQL_DIR)
        .filter(f => f.endsWith('.sql'))
        .map(f => f.slice(0, -4))
        .filter(t => admissionColumns(t).length > 0)
        .sort();
}

// A heights-stamped row: every DDL column present, each admission column a distinct
// non-NULL height so a dropped or swapped column cannot read as equal.
function seedRow(table) {
    let row = {};
    let h = 101;
    for (let c of ddlColumns(table)) {
        if (c === 'id') row[c] = 7;
        else if (c === 'status') row[c] = 'finalized';
        else if (/^admit_block/.test(c)) row[c] = h++ * (table.length);
        else row[c] = c + '-value';
    }
    return row;
}

// Project one statement's select list over the seeded row. `*` and `alias.*` return the
// whole row; a named column the row lacks throws, as an unknown column would.
function project(sql, row) {
    let m = String(sql).match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s/i);
    if (!m) throw new Error('not a select: ' + sql);
    let list = m[1].trim();
    if (list === '*' || /^\w+\.\*$/.test(list)) return { ...row };
    let out = {};
    for (let raw of list.split(',')) {
        let col = raw.trim();
        if (!Object.prototype.hasOwnProperty.call(row, col))
            throw new Error("Unknown column '" + col + "' in field list: " + sql);
        out[col] = row[col];
    }
    return out;
}

function projectingDb(rowsByTable) {
    let db = Object.create(Database.prototype);
    db.calls = [];
    db.doQuery = async function (sql, params) {
        db.calls.push({ sql: String(sql), params: params || [] });
        let m = String(sql).match(/\bFROM\s+(\w+)/i);
        let table = m ? m[1] : null;
        if (!table || !rowsByTable[table]) return [];
        return rowsByTable[table].map(r => project(sql, r));
    };
    return db;
}

// A broadcaster stand-in that records what the live stream would send, serialized the
// way HubDbBroadcaster.broadcastRow serializes it. A resync request is a failed read,
// which these cases must never reach.
function capturingBroadcaster() {
    return {
        subscribers: new Set(['one']),
        events: [],
        broadcastRow(event) { this.events.push(JSON.parse(JSON.stringify(event, bigIntReplacer))); },
        dropAllForResync(reason) { throw new Error('live read failed: ' + reason); }
    };
}

function get(port, urlPath) {
    return new Promise((resolve, reject) => {
        let req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
                catch (e) { reject(new Error('non-JSON body from ' + urlPath + ': ' + body)); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function pick(row, cols) {
    let out = {};
    for (let c of cols) out[c] = Object.prototype.hasOwnProperty.call(row, c) ? row[c] : '<absent>';
    return out;
}

// The REST bootstrap reads, one per mirrored table carrying admission columns.
const BOOTSTRAP_READS = {
    cross_chain_calls:          (db) => db.findCrossChainCallsById(0, 10),
    cross_chain_matches:        (db) => db.findCrossChainMatchesById(0, 10),
    bridge_transfers:           (db) => db.findBridgeTransfers(0, 10),
    policy_snapshots:           (db) => db.findPolicySnapshots(0, 10),
    price_snapshots:            (db) => db.findPriceSnapshotsById(0, 10),
    oracle_prices:              (db) => db.findOraclePricesAfterId(0, 10),
    attestation_responses:      (db) => db.findAttestationResponsesById(0, 10),
    anchor_reward_attestations: (db) => db.findAnchorRewardAttestations(0, 10),
};

// The read-back each live broadcast path streams, driven through the real mixin method
// where one exists. price_snapshots streams findPriceSnapshotsForRound's rows from a
// function private to the round store, so that read is taken directly. oracle_prices is
// absent on purpose: its live row is the aggregator's in-memory object, not a table read.
const LIVE_PATHS = {
    cross_chain_calls: async (db, b, row) => {
        await callFinalize.mirrorCallRow.call({ db: db, broadcaster: b }, row);
    },
    cross_chain_matches: async (db, b, row) => {
        await dexFinalize.mirrorMatchRow.call({ db: db, broadcaster: b }, row);
    },
    bridge_transfers: async (db, b, row) => {
        await bridgePersist.mirrorRow.call({ db: db, broadcaster: b }, 'bridge_transfers', 'transfer_id', row.transfer_id);
    },
    policy_snapshots: async (db, b, row) => {
        await bridgePersist.mirrorRow.call({ db: db, broadcaster: b }, 'policy_snapshots', 'snapshot_id', row.snapshot_id);
    },
    price_snapshots: async (db, b, row) => {
        for (let r of await db.findPriceSnapshotsForRound(row.round_number))
            b.broadcastRow({ table: 'price_snapshots', row: r });
    },
    attestation_responses: async (db, b, row) => {
        await attestBatch.rebroadcastRow.call({ hubDb: () => db, broadcaster: () => b }, row);
    },
    anchor_reward_attestations: async (db, b, row) => {
        await rewardPart.broadcastRewardAttestationRow.call({ db: db, hub: { hubDbBroadcaster: b } },
            row.chain, row.network, row.reward_type, row.round_reference, row.snapshot_block, row.publisher);
    },
};

describe('hub-DB mirror: admission columns on the bootstrap page and the live stream', function () {
    this.timeout(10000);

    it('covers every hub table whose DDL defines an admission column', function () {
        let tables = tablesWithAdmissionColumns();
        // Non-vacuity: the seven signed rails plus the unsigned oracle rail.
        expect(tables).to.have.lengthOf(8);
        expect(Object.keys(BOOTSTRAP_READS).sort()).to.deep.equal(tables);
    });

    registerPerQueryCases();
    registerEquivalenceCases();
});

// One case per bootstrap read and per live read-back: the query itself selects the columns.
function registerPerQueryCases() {
    describe('each bootstrap read selects every admission column', function () {
        for (let table of Object.keys(BOOTSTRAP_READS)) {
            it(table, async function () {
                let seeded = seedRow(table);
                let cols = admissionColumns(table);
                let rows = await BOOTSTRAP_READS[table](projectingDb({ [table]: [seeded] }));
                expect(rows).to.have.lengthOf(1);
                expect(pick(rows[0], cols)).to.deep.equal(pick(seeded, cols));
            });
        }
    });

    describe('each live read-back streams every admission column', function () {
        for (let table of Object.keys(LIVE_PATHS)) {
            it(table, async function () {
                let seeded = seedRow(table);
                let cols = admissionColumns(table);
                let b = capturingBroadcaster();
                await LIVE_PATHS[table](projectingDb({ [table]: [seeded] }), b, seeded);
                expect(b.events).to.have.lengthOf(1);
                expect(b.events[0].table).to.equal(table);
                expect(pick(b.events[0].row, cols)).to.deep.equal(pick(seeded, cols));
            });
        }
    });
}

// The real REST routes on a real socket, so the page is what a reconnecting indexer fetches.
async function bootSnapshotApp(db) {
    let app = express();
    mountSnapshotRoutes(app, {
        hub: { db: db, network: 'regtest', hubDbBroadcaster: null },
        logger: { error() {}, warn() {}, info() {} },
        bigIntReplacer: bigIntReplacer,
        HUB_NETWORK: 'regtest',
        HUB_API_KEY: ''
    });
    return new Promise((resolve) => { let s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

// The same seeded row read through the bootstrap page and through the live stream.
function registerEquivalenceCases() {
    describe('a reconnecting mirror and a streaming mirror receive the same admission heights', function () {
        let server, port, db;

        before(async function () {
            let rowsByTable = {};
            for (let table of Object.keys(BOOTSTRAP_READS)) rowsByTable[table] = [seedRow(table)];
            db = projectingDb(rowsByTable);
            server = await bootSnapshotApp(db);
            port = server.address().port;
        });

        after(function () { if (server) server.close(); });

        for (let table of Object.keys(LIVE_PATHS)) {
            it(table + ': GET /hub-db/snapshot page equals the live row:inserted frame', async function () {
                let seeded = seedRow(table);
                let cols = admissionColumns(table);

                let page = await get(port, '/hub-db/snapshot/' + table + '?since_id=0&limit=10');
                expect(page.status).to.equal(200);
                expect(page.json.rows).to.have.lengthOf(1);
                let bootstrapped = pick(page.json.rows[0], cols);

                let b = capturingBroadcaster();
                await LIVE_PATHS[table](db, b, seeded);
                expect(b.events).to.have.lengthOf(1);
                let streamed = pick(b.events[0].row, cols);

                // Non-vacuity: the heights are real, so a NULL-bound legacy copy cannot match.
                for (let c of cols) expect(streamed[c], c).to.be.a('number');
                expect(bootstrapped).to.deep.equal(streamed);
            });
        }
    });
}
