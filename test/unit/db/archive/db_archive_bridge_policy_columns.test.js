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
//
// bridge_transfers and policy_snapshots gain the hub-side ANCHOR archive
// bookkeeping columns cross_chain_matches and cross_chain_calls already carry:
// the DDL, the idempotent migration step wired into runColumnAndFenceMigrations,
// the pending-row finders and guarded stamps, and the batch-seq allocator
// spanning both tables.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');

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

function makeDb() {
    const mockConn = {
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
        end:     sinon.stub().resolves()
    };
    const mockPool = {
        getConnection: sinon.stub().resolves(mockConn),
        end:           sinon.stub().resolves()
    };
    const mockMariadb = {
        createPool:       sinon.stub().returns(mockPool),
        createConnection: sinon.stub().resolves(mockConn)
    };
    const Database = proxyquire('../../../../src/db', {
        mariadb: mockMariadb,
        fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
        path:    require('path')
    });
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
    return { db, mockConn, mockPool };
}

const NULLABLE_COLUMNS_MIGRATION = require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations',
    '2026-10-19-nullable-mirror-columns.sql'), 'utf8');

function addsColumn(table, column) {
    return NULLABLE_COLUMNS_MIGRATION.split('\n').some(l => l.startsWith('ALTER TABLE `' + table + '` ADD COLUMN IF NOT EXISTS `' + column + '` '));
}

function registerDdlTests() {
    describe('DDL: archive bookkeeping columns', function () {
        it('bridge_transfers.sql carries batch_seq, archived_status and anchor_txid', function () {
            expect(ddlColumns('bridge_transfers')).to.include.members(['batch_seq', 'archived_status', 'anchor_txid']);
        });

        it('policy_snapshots.sql carries batch_seq and anchor_txid, but no archived_status (append-only)', function () {
            let cols = ddlColumns('policy_snapshots');
            expect(cols).to.include.members(['batch_seq', 'anchor_txid']);
            expect(cols).to.not.include('archived_status');
        });
    });
}

function registerMigrateArchiveColumnsTests() {
    describe('dated nullable-column migration', function () {
        it('adds every bookkeeping column on both tables', function () {
            for (let c of ['batch_seq', 'archived_status', 'anchor_txid'])
                expect(addsColumn('bridge_transfers', c), 'bridge_transfers.' + c).to.equal(true);
            for (let c of ['batch_seq', 'anchor_txid'])
                expect(addsColumn('policy_snapshots', c), 'policy_snapshots.' + c).to.equal(true);
            expect(addsColumn('policy_snapshots', 'archived_status')).to.equal(false);
        });
    });
}

function registerFinderTests() {
    describe('findBridgeTransfersByBatchSeq(limit)', function () {
        it('selects pending rows only, bounded by limit', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'doQuery').resolves([]);
            await db.findBridgeTransfersByBatchSeq(25);
            let [sql, params] = db.doQuery.getCall(0).args;
            expect(sql).to.match(/FROM bridge_transfers/);
            expect(sql).to.match(/batch_seq IS NULL OR archived_status <> status/);
            expect(params).to.deep.equal([25]);
        });
    });

    describe('findPolicySnapshotsByBatchSeq(limit)', function () {
        it('selects pending rows only, bounded by limit', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'doQuery').resolves([]);
            await db.findPolicySnapshotsByBatchSeq(10);
            let [sql, params] = db.doQuery.getCall(0).args;
            expect(sql).to.match(/FROM policy_snapshots/);
            expect(sql).to.match(/batch_seq IS NULL/);
            expect(sql).to.not.match(/archived_status/);
            expect(params).to.deep.equal([10]);
        });
    });
}

function registerUpdateTests() {
    describe('updateBridgeTransferArchiveBatchSeq(batchSeq, status, txid, transferId)', function () {
        it('stamps batch_seq/archived_status/anchor_txid, guarded on the pending predicate', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'doQuery').resolves({ affectedRows: 1 });
            await db.updateBridgeTransferArchiveBatchSeq(42, 'finalized', 'txid123', 'transfer-abc');
            let [sql, params] = db.doQuery.getCall(0).args;
            expect(sql).to.match(/UPDATE bridge_transfers SET/);
            expect(sql).to.match(/batch_seq = \?/);
            expect(sql).to.match(/archived_status = \?/);
            expect(sql).to.match(/anchor_txid = COALESCE\(\?, anchor_txid\)/);
            expect(sql).to.match(/WHERE transfer_id = \? AND \(batch_seq IS NULL OR archived_status <> status\)/);
            expect(params).to.deep.equal([42, 'finalized', 'txid123', 'transfer-abc']);
        });
    });

    describe('updatePolicySnapshotArchiveBatchSeq(batchSeq, txid, snapshotId)', function () {
        it('stamps batch_seq/anchor_txid, guarded on batch_seq IS NULL', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'doQuery').resolves({ affectedRows: 1 });
            await db.updatePolicySnapshotArchiveBatchSeq(42, 'txid123', 'snapshot-abc');
            let [sql, params] = db.doQuery.getCall(0).args;
            expect(sql).to.match(/UPDATE policy_snapshots SET/);
            expect(sql).to.match(/batch_seq = \?/);
            expect(sql).to.match(/anchor_txid = COALESCE\(\?, anchor_txid\)/);
            expect(sql).to.not.match(/archived_status/);
            expect(sql).to.match(/WHERE snapshot_id = \? AND batch_seq IS NULL/);
            expect(params).to.deep.equal([42, 'txid123', 'snapshot-abc']);
        });
    });
}

function registerBatchSeqAllocatorTests() {
    describe('getNextAnchorBatchSeq()', function () {
        it('spans bridge_transfers and policy_snapshots alongside the existing three tables', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'doQuery').resolves([{ next_seq: 0 }]);
            await db.getNextAnchorBatchSeq();
            let sql = db.doQuery.getCall(0).args[0];
            for (let table of ['cross_chain_matches', 'cross_chain_calls', 'validator_rewards', 'bridge_transfers', 'policy_snapshots'])
                expect(sql).to.match(new RegExp('MAX\\(batch_seq\\) FROM ' + table));
        });
    });
}

function registerSnapshotRouteCommentTest() {
    describe('src/api/rest/hub_db_snapshot.js: bridge_transfers route comment', function () {
        it('documents the new hub-side-only archive columns rather than claiming every column is mirror-consumed', function () {
            let text = fs.readFileSync(
                path.join(__dirname, '..', '..', '..', '..', 'src', 'api', 'rest', 'hub_db_snapshot.js'), 'utf8');
            let start = text.indexOf('GET /hub-db/snapshot/bridge_transfers');
            expect(start).to.be.greaterThan(-1);
            let section = text.slice(start, start + 1200);
            expect(section).to.not.match(/every column on this table is mirror-consumed/);
            expect(section).to.match(/batch_seq/);
            expect(section).to.match(/hub-side/);
        });
    });
}

describe('hub bridge/policy archive bookkeeping', function () {
    afterEach(function () { sinon.restore(); });

    registerDdlTests();
    registerMigrateArchiveColumnsTests();
        registerFinderTests();
    registerUpdateTests();
    registerBatchSeqAllocatorTests();
    registerSnapshotRouteCommentTest();
});
