'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const testDb = require('../../helpers/testDb');

const ADMIT = { admit_block_btc: 11, admit_block_ltc: 12, admit_block_doge: 13 };
const OTHER = { admit_block_btc: 21, admit_block_ltc: 22, admit_block_doge: 23 };
const CREATED = new Date('2026-01-01T00:00:00Z');
let db;

async function rows(round) {
    return db.doQuery('SELECT * FROM price_snapshots WHERE round_number = ? ORDER BY coin_pair', [round]);
}

async function producer(round, pairs) {
    await db.setFinalizedPriceSnapshotRound(round, pairs, 101, 1700000000, 3,
        '[{"own":1}]', ADMIT);
}

async function incoming(method, round, pairs, referenceChain, action, generation) {
    const common = [round, pairs, 900, referenceChain, 1700000500, 5];
    if (method === 'setBatchPriceSnapshotRound') {
        return db[method](...common, '{"batch":{}}', action, generation,
            1700000600, CREATED, OTHER);
    }
    return db[method](...common, '[{"pushed":1}]', action, generation, CREATED, OTHER);
}

function registerProducerAndPlaceholderCases() {
    for (const method of ['setBatchPriceSnapshotRound', 'setPushedPriceSnapshotRound']) {
        it(method + ' preserves every signed producer column', async function () {
            await producer(20, [{ coinPair: 'BTC/USD', price: '50000' }]);
            await incoming(method, 20, [{ pair: 'BTC/USD', price: '99999' }], 'DOGE', 42, 4);
            const row = (await rows(20))[0];
            expect(row.price).to.equal('50000');
            expect(Number(row.reference_block)).to.equal(101);
            expect(row.reference_chain).to.equal('BTC');
            expect(Number(row.block_timestamp)).to.equal(1700000000);
            expect(Number(row.validator_count)).to.equal(3);
            expect(row.consensus_proof).to.equal('[{"own":1}]');
            expect(row.source_action_index).to.equal(null);
            expect(Number(row.consensus_round)).to.equal(1);
            expect([row.admit_block_btc, row.admit_block_ltc, row.admit_block_doge].map(Number))
                .to.deep.equal([11, 12, 13]);
        });

        it(method + ' fully upgrades a skipped placeholder', async function () {
            await db.setSkippedPriceSnapshotRound(21, ['BTC/USD'], 50, 1699999999);
            await incoming(method, 21, [{ pair: 'BTC/USD', price: '99999' }], 'DOGE', 42, 4);
            const row = (await rows(21))[0];
            expect(row.status).to.equal('finalized');
            expect(row.price).to.equal('99999');
            expect(Number(row.reference_block)).to.equal(900);
            expect(row.reference_chain).to.equal('DOGE');
            expect(Number(row.source_action_index)).to.equal(42);
            expect(Number(row.push_generation)).to.equal(4);
            expect(Number(row.consensus_round)).to.equal(1);
        });
    }
}

function registerMovableRowCases() {
    for (const method of ['setBatchPriceSnapshotRound', 'setPushedPriceSnapshotRound']) {
        it(method + ' inserts a new key as a finalized row', async function () {
            await incoming(method, 30, [{ pair: 'BTC/USD', price: '99999' }], 'DOGE', 42, 4);
            const row = (await rows(30))[0];
            expect(row.status).to.equal('finalized');
            expect(Number(row.reference_block)).to.equal(900);
            expect(Number(row.consensus_round)).to.equal(1);
            expect(row.consensus_proof).to.equal(method === 'setBatchPriceSnapshotRound' ? '{"batch":{}}' : '[{"pushed":1}]');
        });

        it(method + ' moves an orphaned batch row and a pushed row of another chain', async function () {
            await incoming('setBatchPriceSnapshotRound', 31, [{ pair: 'BTC/USD', price: '1' }], 'DOGE', 7, 2);
            await incoming('setPushedPriceSnapshotRound', 32, [{ pair: 'BTC/USD', price: '2' }], 'LTC', 8, 1);
            await incoming(method, 31, [{ pair: 'BTC/USD', price: '99999' }], 'DOGE', 42, 4);
            await incoming(method, 32, [{ pair: 'BTC/USD', price: '99999' }], 'DOGE', 42, 4);
            for (const round of [31, 32]) {
                const row = (await rows(round))[0];
                expect(row.price).to.equal('99999');
                expect(Number(row.reference_block)).to.equal(900);
                expect(row.reference_chain).to.equal('DOGE');
                expect(Number(row.source_action_index)).to.equal(42);
                expect(Number(row.push_generation)).to.equal(4);
                expect([row.admit_block_btc, row.admit_block_ltc, row.admit_block_doge].map(Number))
                    .to.deep.equal([21, 22, 23]);
            }
        });

        it(method + ' keeps a disputed row disputed while landing metadata moves', async function () {
            await producer(33, [{ coinPair: 'BTC/USD', price: '50000' }]);
            await db.doQuery("UPDATE price_snapshots SET status = 'disputed' WHERE round_number = 33");
            await incoming(method, 33, [{ pair: 'BTC/USD', price: '99999' }], 'DOGE', 42, 4);
            const row = (await rows(33))[0];
            expect(row.status).to.equal('disputed');
            expect(row.price).to.equal('99999');
            expect(Number(row.reference_block)).to.equal(900);
            expect(row.consensus_proof).to.not.equal('[{"own":1}]');
        });
    }
}

function registerLandingClockAndMixedPairCases() {
    it('keeps the earliest landing clock on a producer row and on a moved row', async function () {
        await producer(34, [{ coinPair: 'BTC/USD', price: '50000' }]);
        await incoming('setBatchPriceSnapshotRound', 34, [{ pair: 'BTC/USD', price: '1' }], 'DOGE', 42, 4);
        expect(Number((await rows(34))[0].batch_block_time)).to.equal(1700000600);
        const later = [34, [{ pair: 'BTC/USD', price: '1' }], 900, 'DOGE', 1700000500, 5, '{"batch":{}}', 42, 4, 1700000900, CREATED, OTHER];
        await db.setBatchPriceSnapshotRound(...later);
        expect(Number((await rows(34))[0].batch_block_time)).to.equal(1700000600);
        later[9] = 1700000100;
        await db.setBatchPriceSnapshotRound(...later);
        const row = (await rows(34))[0];
        expect(Number(row.batch_block_time)).to.equal(1700000100);
        expect(row.consensus_proof).to.equal('[{"own":1}]');
        expect(Number(row.reference_block)).to.equal(101);
    });

    it('moves a BTC pushed row with a null action and generation zero', async function () {
        await incoming('setPushedPriceSnapshotRound', 22,
            [{ pair: 'BTC/USD', price: '50000' }], 'BTC', null, 0);
        await incoming('setBatchPriceSnapshotRound', 22,
            [{ pair: 'BTC/USD', price: '70000' }], 'DOGE', 45, 5);
        const row = (await rows(22))[0];
        expect(row.price).to.equal('70000');
        expect(row.reference_chain).to.equal('DOGE');
        expect(Number(row.source_action_index)).to.equal(45);
        expect(Number(row.push_generation)).to.equal(5);
        expect(row.consensus_proof).to.equal('{"batch":{}}');
    });

    it('preserves one producer pair while upgrading one skipped pair atomically', async function () {
        await producer(23, [{ coinPair: 'BTC/USD', price: '50000' }]);
        await db.setSkippedPriceSnapshotRound(23, ['LTC/USD'], 50, 1699999999);
        await incoming('setBatchPriceSnapshotRound', 23, [
            { pair: 'BTC/USD', price: '99999' }, { pair: 'LTC/USD', price: '70' }
        ], 'DOGE', 42, 4);
        const stored = await rows(23);
        expect(stored[0].price).to.equal('50000');
        expect(stored[0].consensus_proof).to.equal('[{"own":1}]');
        expect(stored[1].price).to.equal('70');
        expect(stored[1].consensus_proof).to.equal('{"batch":{}}');
    });
}

describe('Integration: batch and push upserts on a real MariaDB', function () {
    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            if (Object.prototype.hasOwnProperty.call(process.env, 'TEST_DB_PASS')) throw e;
            console.warn('MariaDB unavailable; skipping batch and push upsert tests');
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

    registerProducerAndPlaceholderCases();
    registerMovableRowCases();
    registerLandingClockAndMixedPairCases();
});
