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

const sinon        = require('sinon');
const { expect }   = require('chai');
const testDb       = require('../../helpers/testDb');

describe('Integration: Price Persistence (SC-3.x)', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping price persistence tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    // SC-3.1: Price snapshot SQL precision
    describe('SC-3.1: Price precision round-trip', function () {
        it('preserves 8-decimal precision through DB write and read', async function () {
            let db = testDb.getDb();
            let price = '100000.12345678';

            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (?, ?, ?, 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                [1, 'BTC/USD', price, Date.now()]
            );

            let rows = await db.doQuery(
                "SELECT price FROM price_snapshots WHERE round_number = 1 AND coin_pair = 'BTC/USD'"
            );

            expect(rows).to.have.lengthOf(1);
            expect(rows[0].price).to.equal(price);
        });

        it('preserves precision for very small prices (DOGE)', async function () {
            let db = testDb.getDb();
            let price = '0.00012345';

            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')`,
                [1, 'DOGE/USD', price, Date.now()]
            );

            let rows = await db.doQuery(
                "SELECT price FROM price_snapshots WHERE round_number = 1 AND coin_pair = 'DOGE/USD'"
            );

            expect(rows[0].price).to.equal(price);
        });
    });

    // SC-3.2: Fee quote calculation chain
    describe('SC-3.2: Fee quote calculation', function () {
        it('computes fee quote using latest price snapshot', async function () {
            let db = testDb.getDb();
            let now = Date.now();

            // Insert BTC/USD price
            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (?, ?, ?, 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                [1, 'BTC/USD', '100000.00000000', now]
            );

            // Use XChainHub.getFeeQuote which reads from DB
            let XChainHub = require('../../../src/XChainHub');
            let hub = new XChainHub(
                process.env.TEST_DB_HOST || '127.0.0.1',
                parseInt(process.env.TEST_DB_PORT) || 3306,
                process.env.TEST_DB_NAME || 'xchain_hub_test',
                process.env.TEST_DB_USER || 'root',
                process.env.TEST_DB_PASS || ''
            );
            hub.db = db;

            let quote = await hub.getFeeQuote('ISSUE', 'BTC');

            expect(quote.action).to.equal('ISSUE');
            expect(quote.chain).to.equal('BTC');
            expect(quote.gasCost).to.equal(100000);
            expect(quote.xchainAmount).to.equal('1.00000000');
            // coinUsd should be derived from BTC/USD snapshot
            expect(quote.coinUsd).to.equal('100000.00000000');
            expect(quote.nativeCoinAmount).to.exist;
        });

        it('returns error for unknown action', async function () {
            let db = testDb.getDb();
            let XChainHub = require('../../../src/XChainHub');
            let hub = new XChainHub(
                process.env.TEST_DB_HOST || '127.0.0.1',
                parseInt(process.env.TEST_DB_PORT) || 3306,
                process.env.TEST_DB_NAME || 'xchain_hub_test',
                process.env.TEST_DB_USER || 'root',
                process.env.TEST_DB_PASS || ''
            );
            hub.db = db;

            let quote = await hub.getFeeQuote('NONEXISTENT', 'BTC');
            expect(quote.error).to.include('unknown action');
        });
    });

    // SC-3.3: Price snapshot ordering
    describe('SC-3.3: Snapshot ordering', function () {
        it('getPrice returns most recent finalized snapshot', async function () {
            let db = testDb.getDb();
            let now = Date.now();

            // Insert snapshots for multiple rounds
            for (let round = 1; round <= 5; round++) {
                await db.doQuery(
                    `INSERT INTO price_snapshots
                        (round_number, coin_pair, price, reference_block, reference_chain,
                         block_timestamp, validator_count, consensus_round, consensus_proof, status)
                     VALUES (?, ?, ?, 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                    [round, 'BTC/USD', (100000 + round * 100).toFixed(8), now + round]
                );
            }

            // Insert a skipped round at round 6
            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (?, ?, NULL, 0, 'BTC', ?, 0, 1, '[]', 'skipped')`,
                [6, 'BTC/USD', now + 6]
            );

            let XChainHub = require('../../../src/XChainHub');
            let hub = new XChainHub(
                process.env.TEST_DB_HOST || '127.0.0.1',
                parseInt(process.env.TEST_DB_PORT) || 3306,
                process.env.TEST_DB_NAME || 'xchain_hub_test',
                process.env.TEST_DB_USER || 'root',
                process.env.TEST_DB_PASS || ''
            );
            hub.db = db;

            // getPrice should return round 5 (most recent finalized, not skipped round 6)
            let latest = await hub.getPrice('BTC/USD');
            expect(latest).to.not.be.null;
            expect(latest.round_number).to.equal(5);
            expect(latest.price).to.equal('100500.00000000');

            // getPriceSnapshots should return in descending order
            let snapshots = await hub.getPriceSnapshots(3);
            expect(snapshots).to.have.lengthOf(3);
            expect(snapshots[0].round_number).to.equal(5);
            expect(snapshots[1].round_number).to.equal(4);
            expect(snapshots[2].round_number).to.equal(3);
        });
    });
});
