'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The finalize upsert runs on a real MariaDB. Its guards read the held row's status, and
// MariaDB applies the assignments of one statement left to right, so the order is what
// these cases pin: a statement-shape test cannot tell a working guard from one that
// reads a status it has already overwritten.

const { expect } = require('chai');
const testDb = require('../../helpers/testDb');

const ADMIT = { admit_block_btc: 11, admit_block_ltc: 12, admit_block_doge: 13 };
const OTHER = { admit_block_btc: 21, admit_block_ltc: 22, admit_block_doge: 23 };
const PAIR = [{ pair: 'BTC/USD', coinPair: 'BTC/USD', price: '50000' }];
const MOVED = [{ pair: 'BTC/USD', coinPair: 'BTC/USD', price: '99999' }];
const CREATED = new Date('2026-01-01T00:00:00Z');

let db;

async function row(round) {
    const rows = await db.doQuery('SELECT * FROM price_snapshots WHERE round_number = ? AND coin_pair = ?',
        [round, 'BTC/USD']);
    return rows[0];
}

async function holdPushed(round) {
    await db.setPushedPriceSnapshotRound(round, PAIR, 900, 'DOGE', 1700000000, 5,
        '[{"landed":1}]', 42, 3, CREATED, ADMIT);
}

async function finalizeOther(round) {
    await db.setFinalizedPriceSnapshotRound(round, MOVED, 101, 1700000500, 9, '[{"own":1}]', OTHER);
}

describe('Integration: finalize upsert on a real MariaDB', function () {
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping the real finalize upsert test');
            this.skip();
        }
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) this.skip();
        await testDb.truncateAll();
    });

    after(async function () {
        await testDb.teardown();
    });

    it('inserts a new key as a finalized producer row', async function () {
        await finalizeOther(7);
        const r = await row(7);
        expect(r.status).to.equal('finalized');
        expect(r.price).to.equal('99999');
        expect(Number(r.reference_block)).to.equal(101);
        expect(r.consensus_proof).to.equal('[{"own":1}]');
    });

    it('upgrades a skipped placeholder in every payload column', async function () {
        await db.setSkippedPriceSnapshotRound(8, ['BTC/USD'], 50, 1699999999);
        await finalizeOther(8);
        const r = await row(8);
        expect(r.status).to.equal('finalized');
        expect(r.price).to.equal('99999');
        expect(Number(r.reference_block)).to.equal(101);
        expect(Number(r.block_timestamp)).to.equal(1700000500);
        expect(Number(r.validator_count)).to.equal(9);
        expect(r.consensus_proof).to.equal('[{"own":1}]');
        expect([r.admit_block_btc, r.admit_block_ltc, r.admit_block_doge].map(Number)).to.deep.equal([21, 22, 23]);
    });

    it('leaves a finalized pushed row whole instead of mixing in the producer payload', async function () {
        await holdPushed(9);
        await finalizeOther(9);
        const r = await row(9);
        expect(r.status).to.equal('finalized');
        expect(r.price).to.equal('50000');
        expect(Number(r.reference_block)).to.equal(900);
        expect(r.reference_chain).to.equal('DOGE');
        expect(r.source_chain).to.equal('DOGE');
        expect(Number(r.source_action_index)).to.equal(42);
        expect(Number(r.validator_count)).to.equal(5);
        expect(r.consensus_proof).to.equal('[{"landed":1}]');
        expect([r.admit_block_btc, r.admit_block_ltc, r.admit_block_doge].map(Number)).to.deep.equal([11, 12, 13]);
    });

    it('keeps a disputed row disputed with its payload untouched', async function () {
        await holdPushed(10);
        await db.doQuery("UPDATE price_snapshots SET status = 'disputed' WHERE round_number = 10");
        await finalizeOther(10);
        const r = await row(10);
        expect(r.status).to.equal('disputed');
        expect(r.price).to.equal('50000');
        expect(Number(r.reference_block)).to.equal(900);
        expect(r.consensus_proof).to.equal('[{"landed":1}]');
    });
});
