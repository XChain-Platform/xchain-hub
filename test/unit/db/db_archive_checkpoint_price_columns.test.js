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
// state_checkpoints and price_snapshots gain the hub-side ANCHOR archive bookkeeping
// columns, archive_price_tombstones records archived rows a retraction deleted, and the
// pending selectors, guarded stamps and batch-seq allocator span all three. The SQL
// each method issues is asserted through a stubbed doQuery: the pending predicate is
// what re-pends a mutated price row, and the stamp guard is what refuses a stamp after
// a mid-round mutation.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const SRC_DIR = path.join(__dirname, '..', '..', '..', 'src');

function ddlColumns(table) {
    let text = fs.readFileSync(path.join(SRC_DIR, 'sql', table + '.sql'), 'utf8');
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
    const Database = proxyquire('../../../src/db', {
        mariadb: mockMariadb,
        fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
        path:    require('path')
    });
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
    return { db, mockConn };
}

function stubbedDb() {
    const { db } = makeDb();
    db.doQuery = sinon.stub().resolves([]);
    return db;
}

function lastCall(db) {
    let c = db.doQuery.lastCall;
    return { sql: c.args[0], args: c.args[1] };
}

describe('DDL: checkpoint and price archive bookkeeping', function () {
    it('state_checkpoints.sql carries batch_seq', function () {
        expect(ddlColumns('state_checkpoints')).to.include('batch_seq');
    });

    it('price_snapshots.sql carries the four bookkeeping columns', function () {
        expect(ddlColumns('price_snapshots')).to.include.members(
            ['batch_seq', 'archived_status', 'archived_batch_block_time', 'archived_proof_sha']);
    });

    it('archive_price_tombstones.sql keys on (round_number, coin_pair) and carries batch_seq', function () {
        let text = fs.readFileSync(path.join(SRC_DIR, 'sql', 'archive_price_tombstones.sql'), 'utf8');
        expect(ddlColumns('archive_price_tombstones')).to.include.members(['round_number', 'coin_pair', 'batch_seq']);
        expect(text).to.match(/PRIMARY KEY \(round_number, coin_pair\)/);
    });
});

describe('migrateArchiveBookkeepingColumns() for checkpoints and prices', function () {
    it('adds every missing column, and none once they exist', async function () {
        const { db, mockConn } = makeDb();
        let existing = { state_checkpoints: ['id'], price_snapshots: ['id', 'status'] };
        mockConn.query.callsFake(async (sql, args) => {
            if (/information_schema\.columns/.test(sql)) return (existing[args[1]] || []).map(c => ({ c }));
            return [];
        });
        await db.migrateArchiveBookkeepingColumns();
        let alters = mockConn.query.getCalls().map(c => c.args[0]).filter(s => /ALTER TABLE/.test(s));
        for (let [t, c] of [['state_checkpoints', 'batch_seq'], ['price_snapshots', 'batch_seq'],
            ['price_snapshots', 'archived_status'], ['price_snapshots', 'archived_batch_block_time'],
            ['price_snapshots', 'archived_proof_sha']]) {
            expect(alters.some(a => a.includes('ALTER TABLE `' + t + '` ADD COLUMN `' + c + '`')), t + '.' + c).to.equal(true);
        }

        existing = {
            state_checkpoints: ['id', 'batch_seq'],
            price_snapshots: ['id', 'batch_seq', 'archived_status', 'archived_batch_block_time', 'archived_proof_sha']
        };
        mockConn.query.resetHistory();
        await db.migrateArchiveBookkeepingColumns();
        expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
    });
});

describe('state_checkpoints archive selectors and stamp', function () {
    it('pending is batch_seq IS NULL, ordered by (chain, network, checkpoint_seq)', async function () {
        const db = stubbedDb();
        await db.findStateCheckpointsByBatchSeq(50);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/FROM state_checkpoints WHERE batch_seq IS NULL ORDER BY chain ASC, network ASC, checkpoint_seq ASC LIMIT \?/);
        expect(args).to.deep.equal([50]);
    });

    it('the stamp is guarded on batch_seq IS NULL and binds the row key', async function () {
        const db = stubbedDb();
        await db.updateStateCheckpointArchiveBatchSeq(7, 'BTC', 'regtest', 12);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/^UPDATE state_checkpoints SET batch_seq = \?/);
        expect(sql).to.match(/WHERE chain = \? AND network = \? AND checkpoint_seq = \? AND batch_seq IS NULL$/);
        expect(sql).to.not.match(/anchor_txid/);
        expect(args).to.deep.equal([7, 'BTC', 'regtest', 12]);
    });
});

describe('price_snapshots pending predicate', function () {
    for (let col of ['archived_status <> status', 'archived_batch_block_time <> batch_block_time',
        'archived_proof_sha <> SHA2(consensus_proof, 256)', 'batch_seq IS NULL']) {
        it('re-pends a stamped row on: ' + col, async function () {
            const db = stubbedDb();
            await db.findPriceSnapshotRoundsByBatchSeq(288);
            let { sql, args } = lastCall(db);
            expect(sql).to.include(col);
            expect(sql).to.match(/^SELECT DISTINCT round_number FROM price_snapshots WHERE .* ORDER BY round_number ASC LIMIT \?$/);
            expect(args).to.deep.equal([288]);
        });
    }

    it('reads every row of the chosen rounds, pending or not', async function () {
        const db = stubbedDb();
        await db.findPriceSnapshotsForArchiveRounds([4, 5, 9]);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/WHERE round_number IN \(\?, \?, \?\) ORDER BY round_number ASC, coin_pair ASC$/);
        expect(sql).to.not.include('batch_seq');
        expect(args).to.deep.equal([4, 5, 9]);
    });

    it('reads nothing for an empty round list without a query', async function () {
        const db = stubbedDb();
        expect(await db.findPriceSnapshotsForArchiveRounds([])).to.deep.equal([]);
        expect(db.doQuery.called).to.equal(false);
    });
});

describe('price_snapshots stamp', function () {
    it('is guarded on status, batch_block_time and proof digest still equalling the archived values', async function () {
        const db = stubbedDb();
        await db.updatePriceSnapshotArchiveBatchSeq(3, 'finalized', 1700, 'ab'.repeat(32), 11, 'BTC/USD');
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/SET batch_seq = \?, archived_status = \?, archived_batch_block_time = \?, archived_proof_sha = \?/);
        expect(sql).to.match(/WHERE round_number = \? AND coin_pair = \? AND status = \? AND batch_block_time = \? AND SHA2\(consensus_proof, 256\) = \?/);
        expect(sql).to.include('(batch_seq IS NULL OR archived_status <> status');
        expect(args).to.deep.equal([3, 'finalized', 1700, 'ab'.repeat(32), 11, 'BTC/USD', 'finalized', 1700, 'ab'.repeat(32)]);
    });

    it('refuses a stamp after a mid-round mutation: the WHERE compares the live row to the archived values', async function () {
        const db = stubbedDb();
        db.doQuery.resolves({ affectedRows: 0 });
        let r = await db.updatePriceSnapshotArchiveBatchSeq(3, 'finalized', 1700, 'cd'.repeat(32), 11, 'BTC/USD');
        expect(r.affectedRows).to.equal(0);
        let { sql, args } = lastCall(db);
        // every archived value is bound a second time into the WHERE, so a row whose
        // status, landing clock or proof changed since the build matches no row
        expect(args.slice(6)).to.deep.equal(['finalized', 1700, 'cd'.repeat(32)]);
        expect(sql.indexOf('WHERE')).to.be.greaterThan(sql.indexOf('archived_proof_sha = ?'));
    });
});

describe('archive_price_tombstones', function () {
    it('insertPriceTombstonesForRetraction copies only archived rows over the delete predicate', async function () {
        const db = stubbedDb();
        await db.insertPriceTombstonesForRetraction('DOGE', 5, 9, 2, true, true);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/^INSERT IGNORE INTO archive_price_tombstones \(round_number, coin_pair\) SELECT round_number, coin_pair FROM price_snapshots WHERE source_chain = \? AND source_action_index >= \? AND source_action_index <= \? AND push_generation <= \? AND batch_seq IS NOT NULL$/);
        expect(args).to.deep.equal(['DOGE', 5, 9, 2]);
    });

    it('open-ended, unfenced retraction binds the chain and lower bound only', async function () {
        const db = stubbedDb();
        await db.insertPriceTombstonesForRetraction('BTC', 5, undefined, undefined, false, false);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/source_action_index >= \? AND batch_seq IS NOT NULL$/);
        expect(args).to.deep.equal(['BTC', 5]);
    });

    it('a tombstone is pending while unstamped and no live row holds its key', async function () {
        const db = stubbedDb();
        await db.findPriceTombstonesByBatchSeq(20);
        let { sql, args } = lastCall(db);
        expect(sql).to.include('batch_seq IS NULL AND NOT EXISTS (SELECT 1 FROM price_snapshots p');
        expect(sql).to.include('p.round_number = archive_price_tombstones.round_number');
        expect(sql).to.include('p.coin_pair = archive_price_tombstones.coin_pair');
        expect(args).to.deep.equal([20]);
    });

    it('the tombstone stamp is refused once a live row holds the key', async function () {
        const db = stubbedDb();
        await db.updatePriceTombstoneArchiveBatchSeq(4, 11, 'BTC/USD');
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/^UPDATE archive_price_tombstones SET batch_seq = \? WHERE round_number = \? AND coin_pair = \? AND batch_seq IS NULL AND NOT EXISTS \(SELECT 1 FROM price_snapshots p/);
        expect(args).to.deep.equal([4, 11, 'BTC/USD']);
    });
});

describe('retraction records tombstones before deleting', function () {
    it('retractFromActionIndex inserts the tombstones, then deletes the rows', async function () {
        const { retractFromActionIndex } = require('../../../src/oracle/price_aggregator/retract.js');
        const order = [];
        const self = {
            hub: null,
            emit: () => {},
            fenceNetwork: () => 'regtest',
            db: {
                bumpPriceIngestWatermark: async () => {},
                insertPriceTombstonesForRetraction: async () => { order.push('tombstone'); return { affectedRows: 1 }; },
                deletePriceSnapshotsForRetraction: async () => { order.push('delete-snapshots'); return { affectedRows: 1 }; },
                deleteOraclePricesForRetraction: async () => { order.push('delete-oracle'); return { affectedRows: 0 }; }
            }
        };
        let r = await retractFromActionIndex.call(self, 'DOGE', 10);
        expect(order).to.deep.equal(['tombstone', 'delete-snapshots', 'delete-oracle']);
        expect(r.retracted.price_snapshots).to.equal(1);
    });
});

describe('getNextAnchorBatchSeq() spans the new sources', function () {
    it('takes the max over checkpoints, price rows and tombstones as well', async function () {
        const db = stubbedDb();
        await db.getNextAnchorBatchSeq();
        let { sql } = lastCall(db);
        for (let t of ['cross_chain_matches', 'cross_chain_calls', 'validator_rewards',
            'state_checkpoints', 'price_snapshots', 'archive_price_tombstones']) {
            expect(sql, t).to.include('(SELECT MAX(batch_seq) FROM ' + t + ')');
        }
    });
});
