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
const StateAnchorPublisher = require('../../../../src/anchor/publisher');
const { ARCHIVE_MAX_PRICE_ROUNDS } = require('../../../../src/anchor/publisher/constants.js');

const SRC_DIR = path.join(__dirname, '..', '..', '..', '..', 'src');

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
    const Database = proxyquire('../../../../src/db', {
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
    it('uses the archive-pending round index without hashing proofs in the read', async function () {
        const db = stubbedDb();
        await db.findPriceSnapshotRoundsByBatchSeq(288);
        const { sql, args } = lastCall(db);
        expect(sql).to.match(/^SELECT DISTINCT round_number FROM price_snapshots FORCE INDEX \(idx_archive_pending_round\) WHERE archive_pending = 1 .* ORDER BY round_number ASC LIMIT \?$/);
        expect(sql).to.not.include('SHA2');
        expect(sql).to.not.include('archived_batch_block_time <> batch_block_time');
        expect(args).to.deep.equal([288]);
    });

    it('uses the same indexed predicate when reading from the common floor', async function () {
        const db = stubbedDb();
        await db.findPriceSnapshotRoundsByBatchSeqFromRound(42, 288);
        const { sql, args } = lastCall(db);
        expect(sql).to.include('FORCE INDEX (idx_archive_pending_round) WHERE archive_pending = 1');
        expect(sql).to.include('AND round_number >= ? ORDER BY round_number ASC LIMIT ?');
        expect(sql).to.not.include('SHA2');
        expect(args).to.deep.equal([42, 288]);
    });

    it('materializes every mutable pending condition behind the indexed read', function () {
        const migration = fs.readFileSync(path.join(SRC_DIR, 'sql', 'migrations',
            '2026-10-24-z-price-snapshots-archive-pending-index.sql'), 'utf8');
        expect(migration).to.include('GENERATED ALWAYS AS');
        for (const condition of ['batch_seq IS NULL', 'archived_status <> status',
            'archived_batch_block_time <> batch_block_time',
            'archived_proof_sha <> SHA2(consensus_proof, 256)']) {
            expect(migration).to.include(condition);
        }
        expect(migration).to.include('idx_archive_pending_round` (`archive_pending`, `round_number`)');
    });

    it('reads every row of the chosen rounds, pending or not', async function () {
        const db = stubbedDb();
        await db.findPriceSnapshotsForArchiveRounds([4, 5, 9]);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/WHERE round_number IN \(\?, \?, \?\) AND status <> 'skipped' AND consensus_proof NOT LIKE '\["%' ORDER BY round_number ASC, coin_pair ASC$/);
        expect(sql).to.not.include('batch_seq');
        expect(args).to.deep.equal([4, 5, 9]);
    });

    it('reads nothing for an empty round list without a query', async function () {
        const db = stubbedDb();
        expect(await db.findPriceSnapshotsForArchiveRounds([])).to.deep.equal([]);
        expect(db.doQuery.called).to.equal(false);
    });
});

describe('folded archive pending-price budget', function () {
    it('keeps a seeded maximum price page that resolves after the old one-second fallback', async function () {
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const seededRounds = Array.from({ length: ARCHIVE_MAX_PRICE_ROUNDS + 1 },
                (_, i) => ({ round_number: i + 1 }));
            const seededPrices = seededRounds.flatMap(({ round_number }) => [
                { round_number, coin_pair: 'BTC/USD' },
                { round_number, coin_pair: 'DOGE/USD' }
            ]);
            const empty = async () => [];
            const pub = Object.create(StateAnchorPublisher.prototype);
            pub.maxBatch = 1000;
            pub.roundTimeoutMs = 60000;
            pub.priceArchiveFloor = () => 0;
            pub.priceRoundsAboveCommonFloor = async rows => rows;
            pub.pendingArchiveRewards = empty;
            pub.db = {
                findCrossChainMatchesByBatchSeq: empty,
                findCrossChainCallsByBatchSeq: empty,
                findBridgeTransfersByBatchSeq: empty,
                findPolicySnapshotsByBatchSeq: empty,
                findStateCheckpointsByBatchSeq: empty,
                findPriceSnapshotRoundsByBatchSeq: async limit => {
                    expect(limit).to.equal(ARCHIVE_MAX_PRICE_ROUNDS + 1);
                    await new Promise(resolve => setTimeout(resolve, 1250));
                    return seededRounds;
                },
                findPriceSnapshotsForArchiveRounds: async rounds =>
                    seededPrices.filter(row => rounds.includes(row.round_number)),
                findPriceTombstonesByBatchSeq: empty
            };
            pub.buildFoldArchiveSection = async () => pub.gatherArchiveRows();

            let settled = false;
            const folded = pub.collectFoldArchive([], 'regtest').then(result => {
                settled = true;
                return result;
            });

            expect(pub.archiveFoldSubdeadlineMs).to.equal(30000);
            await clock.tickAsync(1000);
            expect(settled).to.equal(false);
            await clock.tickAsync(250);

            const rows = await folded;
            expect(rows.prices).to.have.length(ARCHIVE_MAX_PRICE_ROUNDS * 2);
            expect(rows.cappedOrTrimmed).to.equal(true);
            expect(clock.countTimers()).to.equal(0);
        } finally {
            clock.restore();
        }
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
        expect(sql).to.include('archived_batch_block_time <> batch_block_time');
        expect(sql).to.include('archived_proof_sha <> SHA2(consensus_proof, 256)');
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
        expect(sql).to.match(/^INSERT INTO archive_price_tombstones \(round_number, coin_pair\) SELECT round_number, coin_pair FROM price_snapshots WHERE source_chain = \? AND source_action_index >= \? AND source_action_index <= \? AND push_generation <= \? AND batch_seq IS NOT NULL ON DUPLICATE KEY UPDATE archive_price_tombstones\.batch_seq = NULL$/);
        expect(args).to.deep.equal(['DOGE', 5, 9, 2]);
    });

    it('open-ended, unfenced retraction binds the chain and lower bound only', async function () {
        const db = stubbedDb();
        await db.insertPriceTombstonesForRetraction('BTC', 5, undefined, undefined, false, false);
        let { sql, args } = lastCall(db);
        expect(sql).to.match(/source_action_index >= \? AND batch_seq IS NOT NULL ON DUPLICATE KEY UPDATE archive_price_tombstones\.batch_seq = NULL$/);
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
        const { retractFromActionIndex } = require('../../../../src/oracle/price_aggregator/retract.js');
        const order = [];
        const self = {
            hub: null,
            emit: () => {},
            fenceNetwork: () => 'regtest',
            db: {
                bumpPriceIngestWatermark: async () => {},
                findSelfFinalizedRoundsForBatchRetraction: async () => [],
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
