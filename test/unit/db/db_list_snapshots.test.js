/* GENERATED */
'use strict';

const fs          = require('fs');
const path        = require('path');
const sinon       = require('sinon');
const { expect }  = require('chai');

const Database = require('../../../src/db');
const { HUB_SCHEMA_VERSION } = require('../../../src/hub_schema_version.js');
const { mountSnapshotRoutes } = require('../../../src/api/rest/hub_db_snapshot.js');
const { ADMIT_COLUMN_CHAINS, admissionReadSet } = require('../../../src/lib/admission_height.js');
const { AdmissionHeightWatermark } = require('../../../src/peers/hub_db/admission_height_watermark.js');

const SQL_FILE = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'list_snapshots.sql');

function ddlColumns(text) {
    const body = text.slice(text.indexOf('CREATE TABLE'));
    return body.split('\n').map(line => {
        const m = line.match(/^\s+([a-z_][a-z0-9_]*)\s+[A-Z]/);
        return m && m[1];
    }).filter(Boolean);
}

function stubDb() {
    const db = Object.create(Database.prototype);
    db.doQuery = sinon.stub();
    return db;
}

function fakeResponse() {
    return {
        statusCode: 200,
        body: null,
        type() { return this; },
        send(value) { this.body = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) { this.body = JSON.stringify(value); return this; },
        parsed() { return JSON.parse(this.body); }
    };
}

describe('list_snapshots hub table', function () {
    afterEach(function () { sinon.restore(); });

    it('declares the complete append-only row and its two unique identities', function () {
        const sql = fs.readFileSync(SQL_FILE, 'utf8');
        expect(ddlColumns(sql)).to.deep.equal([
            'id', 'snapshot_id', 'snapshot_block', 'network', 'home_chain',
            'home_list_index', 'list_type', 'seq', 'kind', 'added', 'removed',
            'members_hash', 'name', 'description', 'meta_hash', 'origin_block',
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
            'finalizing_view', 'validator_signatures', 'status', 'anchor_txid',
            'batch_seq', 'btc_chain_id', 'created_at'
        ]);
        expect(sql).to.match(/CREATE UNIQUE INDEX\s+\w+\s+ON list_snapshots\s*\(network, home_chain, home_list_index, seq\)/);
        expect(sql).to.match(/CREATE UNIQUE INDEX\s+snapshot_id\s+ON list_snapshots\s*\(snapshot_id\)/);
    });

    it('inserts exactly LIST_SNAPSHOT_COLUMNS with INSERT IGNORE and reports duplicates', async function () {
        const db = stubDb();
        const row = {};
        for (const [i, col] of Database.LIST_SNAPSHOT_COLUMNS.entries()) row[col] = 'v' + i;
        db.doQuery.onFirstCall().resolves({ affectedRows: 1 });
        db.doQuery.onSecondCall().resolves({ affectedRows: 0 });

        expect(await db.insertListSnapshot(row)).to.equal(true);
        expect(await db.insertListSnapshot(row)).to.equal(false);

        const [sql, params] = db.doQuery.firstCall.args;
        expect(sql).to.equal(
            'INSERT IGNORE INTO list_snapshots (' + Database.LIST_SNAPSHOT_COLUMNS.join(', ') + ') VALUES (' +
            Database.LIST_SNAPSHOT_COLUMNS.map(() => '?').join(', ') + ')');
        expect(params).to.deep.equal(Database.LIST_SNAPSHOT_COLUMNS.map(c => row[c]));
        expect(Database.LIST_SNAPSHOT_COLUMNS.slice(10, 14)).to.deep.equal([
            'members_hash', 'name', 'description', 'meta_hash'
        ]);
        expect(Database.LIST_SNAPSHOT_COLUMNS.slice(-4)).to.deep.equal([
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'btc_chain_id'
        ]);
    });

    it('migrates the nullable metadata columns for an existing list_snapshots table', async function () {
        const db = stubDb();
        db.migrateAddNullableColumn = sinon.stub().resolves();

        await db.migrateAdmissionColumns();

        expect(db.migrateAddNullableColumn.calledWithExactly('list_snapshots', 'name',
            'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL', true)).to.equal(true);
        expect(db.migrateAddNullableColumn.calledWithExactly('list_snapshots', 'description',
            'VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL', true)).to.equal(true);
        expect(db.migrateAddNullableColumn.calledWithExactly(
            'list_snapshots', 'meta_hash', 'CHAR(64) NULL', true)).to.equal(true);
    });

    it('returns zero when no prior list version exists', async function () {
        const db = stubDb();
        db.doQuery.resolves([{ seq: null }]);
        expect(await db.getLatestListSeq('regtest', 'DOGE', 41)).to.equal(0);
    });

    it('reads a version chain in sequence order with fold and metadata inputs', async function () {
        const db = stubDb();
        const metaHash = 'a'.repeat(64);
        db.doQuery.resolves([{ name: 'Custodians', description: null, meta_hash: metaHash }]);
        const rows = await db.findListSnapshotChain('regtest', 'DOGE', 41, 7);
        const [sql, params] = db.doQuery.firstCall.args;
        expect(sql).to.match(/^SELECT seq, kind, list_type, added, removed, members_hash, name, description, meta_hash, origin_block FROM list_snapshots/);
        expect(sql).to.match(/seq <= \?/);
        expect(sql).to.match(/ORDER BY seq ASC$/);
        expect(params).to.deep.equal(['regtest', 'DOGE', 41, 7]);
        expect(rows[0].meta_hash).to.equal(metaHash);
    });
});

describe('list_snapshots mirror page', function () {
    afterEach(function () { sinon.restore(); });

    it('pages the REST route and stamps the current schema version', async function () {
        const routes = {};
        const app = {
            use() {},
            get(route, handler) { routes[route] = handler; }
        };
        const db = {
            findListSnapshots: sinon.stub().resolves([{ id: 13, snapshot_id: 'a'.repeat(64) }]),
            getChainTip: sinon.stub().resolves({ chainId: 'b'.repeat(64) })
        };
        mountSnapshotRoutes(app, {
            hub: { db, network: 'regtest', hubDbBroadcaster: { admissionHeights: () => ({ list_snapshots: { BTC: 20 } }) } },
            logger: { error() {} },
            bigIntReplacer: (key, value) => value,
            HUB_NETWORK: 'regtest',
            HUB_API_KEY: ''
        });

        const res = fakeResponse();
        await routes['/hub-db/snapshot/list_snapshots']({ query: { since_id: '12', limit: '25' } }, res);
        expect(res.statusCode).to.equal(200);
        expect(db.findListSnapshots.calledOnceWithExactly(12, 25)).to.equal(true);
        expect(res.parsed()).to.include({ table: 'list_snapshots', count: 1, schema_version: HUB_SCHEMA_VERSION });
        expect(res.parsed().heights).to.deep.equal({ list_snapshots: { BTC: 20 } });
        expect(res.parsed().btc_chain_id).to.equal('b'.repeat(64));
    });

    it('assigns all federation chains and the xdex terminal window', function () {
        expect(admissionReadSet('list_snapshots', {}, ADMIT_COLUMN_CHAINS))
            .to.deep.equal(['BTC', 'DOGE', 'LTC']);
        const watermark = new AdmissionHeightWatermark();
        expect(watermark.roundTerminalMs('list_snapshots'))
            .to.equal(watermark.roundTerminalMs('policy_snapshots'));
    });
});
