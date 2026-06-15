/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * C3 — Fiat oracle round lifecycle, end-to-end into FIAT-dispenser consumption.
 *
 * The "fiat oracle" is the validator PBFT price oracle producing a fiat pair
 * (e.g. BTC/USD) finalized into `price_snapshots`. A FIAT-pegged dispenser
 * (Mode 1, no ORACLE_ADDRESS) consumes it at settlement via the indexer's
 * `reversePriceMatch` -> `getPricesInTimeRange` (price_snapshots, 24h window).
 *
 * Existing coverage tests the two halves in isolation: hub integration tests
 * drive a real round to `price_snapshots`, and dispenser.test.js seeds a row
 * directly then dispenses. NOTHING chains a REAL round -> finalized fiat row ->
 * REAL reverse-match consumption. This closes that gap:
 *   1. drive a real single-validator oracle round (real PriceFetcher path,
 *      mocked external API) -> finalized BTC/USD snapshot;
 *   2. run the indexer's REAL `reversePriceMatch` (the exact dispenser
 *      consumption logic) against that finalized row and assert a FIAT
 *      dispenser settles, plus the 24h-window and affordability boundaries.
 *
 * Invisible wall (cf. C2): a single-validator round needs ORACLE_MIN_SUBMISSIONS=1
 * or it is skipped (default 2). Set it on the test hub config below.
 */

'use strict';

const sinon           = require('sinon');
const { expect }      = require('chai');
const EventEmitter    = require('events');
const path            = require('path');
const testDb          = require('../../helpers/testDb');
const mockApi         = require('../../helpers/mockExternalApi');
const { VALIDATORS_1 } = require('../../helpers/fixtures');
const OracleRound     = require('../../../src/OracleRound');
const OracleConsensus = require('../../../src/OracleConsensus');

// The REAL dispenser-side consumption logic lives in the indexer's Utility.
// reversePriceMatch + the bignumber helpers it calls are pure (mathjs + sibling
// methods; they never touch this.config), so Object.create(prototype) gives a
// constructor-free instance — avoiding the indexer config/env the constructor
// would otherwise load. Resolved by monorepo-relative path (same convention as
// xchain-e2e-test loads xchain-hub internals).
const IndexerUtility = require(path.resolve(__dirname, '../../../../xchain-indexer/src/utility.js'));
function indexerMatcher() { return Object.create(IndexerUtility.prototype); }

// Matches the indexer's FIAT_DISPENSER_PRICE_WINDOW default (config.js:154).
const FIAT_DISPENSER_PRICE_WINDOW = 86400;

// Thin price-DB shim mirroring the indexer's getPricesInTimeRange (db.js:10093)
// verbatim, reading the SAME finalized price_snapshots the round just wrote.
function makePriceDb(hubDb) {
    return {
        getPricesInTimeRange: async (coinPair, startTime, endTime) => {
            const rows = await hubDb.doQuery(
                `SELECT price, round_number, block_timestamp
                   FROM price_snapshots
                  WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL
                    AND block_timestamp BETWEEN ? AND ?
               ORDER BY block_timestamp DESC`,
                [coinPair, startTime, endTime]
            );
            return rows.map(r => ({
                price:       r.price,
                roundNumber: Number(r.round_number),
                timestamp:   Number(r.block_timestamp)
            }));
        }
    };
}

// Mirror of oracleRound.integration.test.js's createTestHub, with an explicit
// ORACLE_MIN_SUBMISSIONS=1 so the single-validator round finalizes (not skips).
function createTestHub(db, validatorAddr) {
    const pm = new EventEmitter();
    pm.validatorAddr    = validatorAddr || 'ws://validator-1:10001';
    pm.validatorPubkeys = new Map();
    pm.broadcast        = sinon.stub().callsFake((type, data) =>
        ({ type, id: 'msg-' + Date.now(), sender: pm.validatorAddr, timestamp: Date.now(), data }));
    pm.getPeerStatus    = sinon.stub().returns([]);

    return {
        db: db,
        p2pConfig: {
            ORACLE_EPOCH_START:       1704067200000,
            ORACLE_ROUND_INTERVAL:    1000,
            ORACLE_SUBMISSION_WINDOW: 500,
            ORACLE_MIN_SUBMISSIONS:   1,
            ORACLE_REWARD_PER_ROUND:  '10.00000000',
            SLASH_DEVIATION_THRESHOLD:    '0.05',
            SLASH_MISSED_ROUNDS_THRESHOLD:'30',
            PRICE_FETCH_TIMEOUT:      5000
        },
        getPeerManager: sinon.stub().returns(pm),
        getIdentity:    sinon.stub().returns({ getPubkeyHex: () => '01'.repeat(32), sign: () => 'aa'.repeat(64) }),
        getOracle:      sinon.stub().returns(null),
        getConsensus:   sinon.stub().returns(null),
        getCrossChain:  sinon.stub().returns(null),
        applyConfig:    sinon.stub().resolves(),
        _peerManager:   pm
    };
}

// Drive ONE real single-validator oracle round to finalization. Returns the
// finalized BTC/USD snapshot row { price, block_timestamp }.
async function driveFiatRound(db) {
    const hub = createTestHub(db, VALIDATORS_1[0].addr);
    hub._peerManager.validatorPubkeys.set(VALIDATORS_1[0].addr, VALIDATORS_1[0].pubkey);
    mockApi.mockCoinGeckoSuccess();   // bitcoin.usd = 100000

    const oracleRound     = new OracleRound(hub);
    const oracleConsensus = new OracleConsensus(hub, oracleRound);
    oracleConsensus.setValidatorSet(VALIDATORS_1);
    oracleRound.setConsensus(oracleConsensus);

    await oracleRound._executeRound();
    await new Promise(r => setTimeout(r, 100));   // let fire-and-forget submission writes land
    await oracleConsensus.finalizeRound(oracleRound.getCurrentRound());

    const rows = await db.doQuery(
        "SELECT price, block_timestamp FROM price_snapshots WHERE coin_pair = 'BTC/USD' AND status = 'finalized'"
    );
    return rows[0];
}

describe('Integration: Fiat oracle round -> FIAT dispenser consumption (C3)', function () {

    before(async function () {
        try { await testDb.setup(); }
        catch (e) { console.warn('MariaDB unavailable — skipping C3 fiat-oracle tests'); }
        mockApi.setup();
    });

    after(async function () {
        mockApi.teardown();
        await testDb.teardown();
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        mockApi.reset();
    });

    afterEach(function () { sinon.restore(); });

    it('a real round finalizes a BTC/USD snapshot that a FIAT dispenser consumes', async function () {
        const db = testDb.getDb();
        const snap = await driveFiatRound(db);

        // The fiat row was produced by a real round (not a direct seed).
        expect(snap, 'finalized BTC/USD snapshot from the round').to.exist;
        expect(Number(snap.price)).to.equal(100000);
        const snapTs = Number(snap.block_timestamp);

        // FIAT dispenser: priced at 100 USD/token, GET_COIN=BTC. Buyer pays
        // 0.0025 BTC. btc_per_token = 100/100000 = 0.001; units = floor(0.0025/0.001) = 2.
        const match = await indexerMatcher().reversePriceMatch(
            '0.0025', '100', 'BTC/USD', snapTs + 1, FIAT_DISPENSER_PRICE_WINDOW, makePriceDb(db)
        );
        expect(match, 'dispenser reverse-match should consume the finalized snapshot').to.not.equal(null);
        expect(match.units).to.equal(2);
        expect(Number(match.snapshot.price)).to.equal(100000);
    });

    it('does not settle when the finalized snapshot is older than the 24h price window', async function () {
        const db = testDb.getDb();
        const snap = await driveFiatRound(db);
        const snapTs = Number(snap.block_timestamp);

        // Dispense block_time is > 24h after the snapshot -> snapshot falls outside
        // [block_time - window, block_time] -> no match.
        const match = await indexerMatcher().reversePriceMatch(
            '0.0025', '100', 'BTC/USD', snapTs + FIAT_DISPENSER_PRICE_WINDOW + 10, FIAT_DISPENSER_PRICE_WINDOW, makePriceDb(db)
        );
        expect(match).to.equal(null);
    });

    it('does not settle when the coin payment cannot afford a single unit', async function () {
        const db = testDb.getDb();
        const snap = await driveFiatRound(db);
        const snapTs = Number(snap.block_timestamp);

        // btc_per_token = 0.001; paying 0.0005 BTC -> floor(0.5) = 0 units -> no match.
        const match = await indexerMatcher().reversePriceMatch(
            '0.0005', '100', 'BTC/USD', snapTs + 1, FIAT_DISPENSER_PRICE_WINDOW, makePriceDb(db)
        );
        expect(match).to.equal(null);
    });
});
