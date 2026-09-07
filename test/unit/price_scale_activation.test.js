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
// test/unit/price_scale_activation.test.js
//
// PRICE v0 canonical price-value flag day, hub side.
//
// The hub and the chain must agree on which price VALUES are well-formed. The
// hub decides twice per round, once at single-round ingest and once at batch
// ingest, and the indexer decides again when the action lands on chain. If the
// hub's rule is tighter than the chain's it withholds a round the federation
// finalized; if looser, it stores one the chain refused. So both sides of the
// gate are driven here, and the vendored copy is pinned against the indexer's
// byte for byte.
//
// Every case drives the REAL aggregator with real Ed25519 quorum signatures over
// the real canonical builders. The gate is moved by stubbing the module's own
// pattern selector at a threshold, the same way the straddle cases drive the
// sig-tally gate, so both branches are exercised while the shipped map stays
// unarmed on mainnet.

const crypto            = require('crypto');
const fs                = require('fs');
const path              = require('path');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../src/PriceAggregator');
const { createMockHub } = require('../helpers/mockHub');
const priceScale        = require('../../src/price_scale_activation.js');
const { PRICE_MAX }     = require('../../src/constants.js');

// Sibling checkout, same resolution convention as price_pair_activation.test.js.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'price_scale_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'price_scale_activation.js');

// The three values the loose rule admits and every other price lane refuses.
const WIDE     = '1.' + '0'.repeat(39) + '1';   // 42 chars: over-runs price_snapshots.price
const NEAR_ZERO = '0.000000001';                // 1e-9: bcformat(...,8) renders it '0.00000000'
const LEADING_ZEROS = '0'.repeat(60) + '1.5';   // 63 chars, and legal under a scale cap alone
const HONEST   = '50000.00000000';              // exactly what bcformat(price, 8) emits

function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

// Mirror of the canonical PRICE v0 payload (xchain-indexer/src/ed25519.js
// buildPriceV0Payload). The mockHub has no `network`, so the EQUIV header is off
// and this is the bare-JSON branch.
function buildPriceV0Payload(round, timestamp, pairs, btcBlockHeight) {
    let sortedPairs = pairs
        .map(p => ({ pair: p.pair, price: String(p.price) }))
        .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
    return JSON.stringify({
        round:            parseInt(round),
        timestamp:        parseInt(timestamp),
        btc_block_height: parseInt(btcBlockHeight),
        pairs:            sortedPairs
    });
}

describe('PRICE v0 canonical price-value flag day: hub copy @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        it('is byte-identical to the indexer copy of price_scale_activation.js', function () {
            // Byte-identity rather than value-identity: the activation map, the scale
            // bound, both patterns AND the fail-closed edge cases all have to match, and
            // a value-only check would miss a divergent guard clause.
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; the hub would withhold a ' +
                    'round the chain finalized, or store one the chain refused');
        });
    });

    describe('the rule this hub ships', function () {

        it('is UNARMED on mainnet, so nothing changes there yet', function () {
            expect(priceScale.PRICE_SCALE_ACTIVATION.mainnet).to.equal(9999999999);
            let now = Math.floor(Date.now() / 1000);
            expect(priceScale.isPriceScaleCanonicalActive(now, 'mainnet')).to.equal(false);
            expect(priceScale.isValidPriceValue(WIDE, now, 'mainnet')).to.equal(true);
            expect(priceScale.isValidPriceValue(NEAR_ZERO, now, 'mainnet')).to.equal(true);
        });

        it('runs from genesis on testnet and regtest', function () {
            for (const network of ['testnet', 'regtest']) {
                expect(priceScale.isPriceScaleCanonicalActive(0, network), network).to.equal(true);
                expect(priceScale.isValidPriceValue(WIDE, 0, network), network).to.equal(false);
                expect(priceScale.isValidPriceValue(HONEST, 0, network), network).to.equal(true);
            }
        });

        it('fails CLOSED to the legacy pattern on anything it cannot evaluate', function () {
            for (const blockTime of [null, undefined, '', false, NaN, 'abc']) {
                expect(priceScale.isPriceScaleCanonicalActive(blockTime, 'regtest'),
                    String(blockTime)).to.equal(false);
            }
            expect(priceScale.isPriceScaleCanonicalActive(0, 'nosuchnet')).to.equal(false);
        });

        it('refuses the leading-zero form a scale cap alone would admit', function () {
            // The half the scale rule cannot carry on its own: 60 leading zeros is
            // 8-dp-legal and 63 characters long, so it truncates exactly as WIDE does.
            expect(/^[0-9]+(\.[0-9]{1,8})?$/.test(LEADING_ZEROS)).to.equal(true);
            expect(priceScale.PRICE_VALUE_RE_CANONICAL.test(LEADING_ZEROS)).to.equal(false);
        });

        it('bounds every accepted price to 19 characters, inside price_snapshots.price', function () {
            // The property the storage seam rests on: with no leading zeros and at most 8
            // decimals, the exclusive PRICE_MAX ceiling caps the integer side at 10 digits.
            let widest = String(PRICE_MAX - 1) + '.' + '1'.repeat(priceScale.PRICE_SCALE_MAX_DECIMALS);
            expect(priceScale.PRICE_VALUE_RE_CANONICAL.test(widest)).to.equal(true);
            expect(widest.length).to.equal(19);
            expect(widest.length).to.be.below(40);
        });
    });

    // -----------------------------------------------------------------------
    // Both sides of the flag day, driven through the real ingest paths.
    // -----------------------------------------------------------------------
    describe('receiveValidatedRound(): both sides of the gate', function () {

        const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
        const BTC_HEIGHT = 799000;
        const GATE       = 1700000000;   // stands in for an armed activation instant

        let hub, agg;

        // Move the gate to GATE, resolved on the same key the aggregator passes it.
        function armGateAt(threshold) {
            sinon.stub(priceScale, 'priceValuePattern').callsFake(
                (key) => parseInt(key) >= threshold
                    ? priceScale.PRICE_VALUE_RE_CANONICAL
                    : priceScale.PRICE_VALUE_RE_LEGACY);
        }

        function makeRound(price, timestamp) {
            let pairs   = [{ pair: 'BTC/USD', price: price }];
            let payload = buildPriceV0Payload(5, timestamp, pairs, BTC_HEIGHT);
            return {
                round: 5,
                timestamp: timestamp,
                btc_block_height: BTC_HEIGHT,
                block_index: 800000,
                action_index: 42,
                pairs: pairs,
                sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
            };
        }

        function stubDb() {
            let inserts = [];
            hub.db.doQuery.callsFake(async (sql, params) => {
                if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
                if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
                return [];
            });
            return inserts;
        }

        beforeEach(function () {
            hub = createMockHub();
            agg = new PriceAggregator(hub);
            hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
                capability: 'price',
                blockIndex: 800000,
                count:      V.length,
                validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
            }) };
            armGateAt(GATE);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('BELOW the gate accepts the over-wide price and stores it byte-exact', async function () {
            // The pre-activation branch is the deployed behaviour and must not move: a
            // replay of history below the threshold has to reach the same rows.
            let inserts = stubDb();
            let events  = [];
            agg.on('row:inserted', e => events.push(e));

            let result = await agg.receiveValidatedRound('BTC', makeRound(WIDE, GATE - 1));

            expect(result.accepted).to.equal(true);
            expect(inserts.length).to.equal(1);
            expect(inserts[0]).to.include(WIDE);
            expect(events.map(e => e.row.price)).to.deep.equal([WIDE]);
        });

        it('AT the gate refuses the over-wide price before any database work', async function () {
            stubDb();
            let result = await agg.receiveValidatedRound('BTC', makeRound(WIDE, GATE));

            expect(result).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
            expect(hub.db.doQuery.called).to.equal(false);
        });

        it('AT the gate refuses the near-zero value the v1 lane and the producers refuse', async function () {
            stubDb();
            let below = await agg.receiveValidatedRound('BTC', makeRound(NEAR_ZERO, GATE - 1));
            expect(below.accepted, 'the loose rule admits it below the gate').to.equal(true);

            let at = await agg.receiveValidatedRound('BTC', makeRound(NEAR_ZERO, GATE));
            expect(at).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        });

        it('AT the gate refuses the leading-zero form a scale cap alone would admit', async function () {
            stubDb();
            let below = await agg.receiveValidatedRound('BTC', makeRound(LEADING_ZEROS, GATE - 1));
            expect(below.accepted).to.equal(true);

            let at = await agg.receiveValidatedRound('BTC', makeRound(LEADING_ZEROS, GATE));
            expect(at).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        });

        it('accepts the honest producer price on BOTH sides, so arming refuses no real round', async function () {
            for (const timestamp of [GATE - 1, GATE]) {
                hub = createMockHub();
                agg = new PriceAggregator(hub);
                hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
                    capability: 'price', blockIndex: 800000, count: V.length,
                    validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
                }) };
                let inserts = stubDb();

                let result = await agg.receiveValidatedRound('BTC', makeRound(HONEST, timestamp));

                expect(result.accepted, 'timestamp ' + timestamp).to.equal(true);
                expect(inserts[0]).to.include(HONEST);
            }
        });
    });

    describe('receiveValidatedBatch(): both sides of the gate', function () {

        const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
        const FIRST_ROUND  = 100;
        const LAST_ROUND   = 105;
        const BATCH_ANCHOR = 799005;
        const BLOCK_INDEX  = 800000;
        const GATE         = 1700004000;   // stands in for an armed activation instant

        let hub, agg;

        function armGateAt(threshold) {
            sinon.stub(priceScale, 'priceValuePattern').callsFake(
                (key) => parseInt(key) >= threshold
                    ? priceScale.PRICE_VALUE_RE_CANONICAL
                    : priceScale.PRICE_VALUE_RE_LEGACY);
        }

        // Six rounds; the price under test rides round index 3, so a case that passes by
        // only grading the first round is still visible.
        function makeBatch(price, blockTime) {
            let rounds = [];
            for (let i = 0; i < 6; i++) {
                rounds.push({
                    round:            FIRST_ROUND + i,
                    timestamp:        1700000000 + (i * 600),
                    btc_block_height: 799000 + i,
                    pairs: [{ pair: 'BTC/USD', price: i === 3 ? price : HONEST }]
                });
            }
            let payload = agg._buildPriceBatchPayload(
                FIRST_ROUND, LAST_ROUND, BATCH_ANCHOR,
                rounds.map(r => ({ round: r.round, timestamp: r.timestamp,
                                   btcBlockHeight: r.btc_block_height, pairs: r.pairs })));
            return {
                first_round:      FIRST_ROUND,
                last_round:       LAST_ROUND,
                btc_block_height: BATCH_ANCHOR,
                rounds:           rounds,
                block_time:       blockTime,
                action_index:     42,
                block_index:      BLOCK_INDEX,
                push_generation:  0,
                sigs:             V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
            };
        }

        function stubDb() {
            let inserts = [];
            hub.db.doQuery.callsFake(async (sql, params) => {
                if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
                if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
                return [];
            });
            return inserts;
        }

        beforeEach(function () {
            hub = createMockHub();
            agg = new PriceAggregator(hub);
            hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
                capability: 'price',
                blockIndex: BLOCK_INDEX,
                count:      V.length,
                validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
            }) };
            sinon.stub(console, 'log');
            armGateAt(GATE);
        });

        afterEach(function () {
            sinon.restore();
        });

        it('BELOW the gate accepts the over-wide price and stores it byte-exact', async function () {
            let inserts = stubDb();
            let result  = await agg.receiveValidatedBatch('BTC', makeBatch(WIDE, GATE - 1));

            expect(result.accepted).to.equal(true);
            let flat = [].concat(...inserts);
            expect(flat).to.include(WIDE);
        });

        it('AT the gate refuses the WHOLE batch, storing nothing partial', async function () {
            // A signed batch is atomic: one bad price invalidates every round in it, the
            // same shape the on-chain parser records.
            let inserts = stubDb();
            let result  = await agg.receiveValidatedBatch('BTC', makeBatch(WIDE, GATE));

            expect(result.accepted).to.equal(false);
            expect(result.reason).to.equal('invalid pairs');
            expect(result.stored).to.equal(0);
            expect(inserts.length).to.equal(0);
        });

        it('AT the gate refuses the near-zero and leading-zero forms too', async function () {
            for (const price of [NEAR_ZERO, LEADING_ZEROS]) {
                stubDb();
                let result = await agg.receiveValidatedBatch('BTC', makeBatch(price, GATE));
                expect(result.accepted, price).to.equal(false);
                expect(result.reason, price).to.equal('invalid pairs');
            }
        });

        it('accepts an all-honest batch on BOTH sides of the gate', async function () {
            for (const blockTime of [GATE - 1, GATE]) {
                hub = createMockHub();
                agg = new PriceAggregator(hub);
                hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
                    capability: 'price', blockIndex: BLOCK_INDEX, count: V.length,
                    validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
                }) };
                stubDb();

                let result = await agg.receiveValidatedBatch('BTC', makeBatch(HONEST, blockTime));
                expect(result.accepted, 'block_time ' + blockTime).to.equal(true);
            }
        });
    });
});
