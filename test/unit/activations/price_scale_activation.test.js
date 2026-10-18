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
// test/unit/activations/price_scale_activation.test.js
//
// PRICE v0 canonical price-value validation, hub side.
//
// The hub and the chain must agree on which price VALUES are well-formed. The
// hub decides twice per round, once at single-round ingest and once at batch
// ingest, and the indexer decides again when the action lands on chain. If the
// hub's rule is tighter than the chain's it withholds a round the federation
// finalized; if looser, it stores one the chain refused. The vendored copy is
// pinned against the indexer's byte for byte.
//
// Every ingest case drives the REAL aggregator with real Ed25519 quorum
// signatures over the real canonical builders.
const crypto            = require('crypto');
const fs                = require('fs');
const path              = require('path');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../helpers/mockHub');
const priceScale        = require('../../../src/consensus/gates/price_scale_gate.js');
const { PRICE_MAX }     = require('../../../src/constants.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
// Sibling checkout, same resolution convention as price_pair_activation.test.js.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'consensus', 'gates', 'price_scale_gate.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', '..', 'src', 'consensus', 'gates', 'price_scale_gate.js');
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
// Mirror of the canonical PRICE v0 payload (xchain-indexer/src/consensus/ed25519.js
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
{
    let registerbyteIdentityWithTheXchainIndexer2;
    {
        function isByteIdenticalToTheIndexerTest4() {
            // Byte-identity rather than value-identity: the scale bound, both patterns,
            // and the retained caller interface all have to match.
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; the hub would withhold a ' +
                    'round the chain finalized, or store one the chain refused');
        }
        function byteIdentityWithTheXchainIndexerSuite3() {
            before(function () {
                skipOrFail(this, siblingCheckout(__dirname, TWIN_PATH), 'the indexer twin guard');
            });
            it('is byte-identical to the indexer copy of price_scale_gate.js', isByteIdenticalToTheIndexerTest4);
        }
        registerbyteIdentityWithTheXchainIndexer2 = function registerSuite() {
            describe('byte-identity with the xchain-indexer twin', byteIdentityWithTheXchainIndexerSuite3);
        };
    }
    let registertheRuleThisHubShips5;
    {
        function appliesTheCanonicalRuleForAllRetainedArgumentsTest7() {
            for (const blockTime of [null, undefined, '', false, NaN, 'abc', 0]) {
                expect(priceScale.isValidPriceValue(WIDE, blockTime, 'nosuchnet'),
                    String(blockTime)).to.equal(false);
                expect(priceScale.isValidPriceValue(NEAR_ZERO, blockTime, 'regtest'),
                    String(blockTime)).to.equal(false);
                expect(priceScale.isValidPriceValue(HONEST, blockTime, 'mainnet'),
                    String(blockTime)).to.equal(true);
            }
        }
        function refusesTheLeadingZeroFormATest10() {
            // The half the scale rule cannot carry on its own: 60 leading zeros is
            // 8-dp-legal and 63 characters long, so it truncates exactly as WIDE does.
            expect(/^[0-9]+(\.[0-9]{1,8})?$/.test(LEADING_ZEROS)).to.equal(true);
            expect(priceScale.PRICE_VALUE_RE_CANONICAL.test(LEADING_ZEROS)).to.equal(false);
        }
        function boundsEveryAcceptedPriceTo19Test11() {
            // The property the storage seam rests on: with no leading zeros and at most 8
            // decimals, the exclusive PRICE_MAX ceiling caps the integer side at 10 digits.
            let widest = String(PRICE_MAX - 1) + '.' + '1'.repeat(priceScale.PRICE_SCALE_MAX_DECIMALS);
            expect(priceScale.PRICE_VALUE_RE_CANONICAL.test(widest)).to.equal(true);
            expect(widest.length).to.equal(19);
            expect(widest.length).to.be.below(40);
        }
        function theRuleThisHubShipsSuite6() {
            it('applies the canonical rule for all retained caller arguments', appliesTheCanonicalRuleForAllRetainedArgumentsTest7);
            it('refuses the leading-zero form a scale cap alone would admit', refusesTheLeadingZeroFormATest10);
            it('bounds every accepted price to 19 characters, inside price_snapshots.price', boundsEveryAcceptedPriceTo19Test11);
        }
        registertheRuleThisHubShips5 = function registerSuite() {
            describe('the rule this hub ships', theRuleThisHubShipsSuite6);
        };
    }
    // The canonical rule is driven through the real ingest paths.
    let registerreceivevalidatedroundCanonicalRule12;
    {
        const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
        const BTC_HEIGHT = 799000;
        const TIMESTAMP  = 1700000000;
        let hub, agg;
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
        async function refusesTheOverWidePriceTest15() {
            stubDb();
            let result = await agg.receiveValidatedRound('BTC', makeRound(WIDE, TIMESTAMP));
            expect(result).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
            expect(hub.db.doQuery.called).to.equal(false);
        }
        async function refusesTheOtherNoncanonicalFormsTest16() {
            for (const price of [NEAR_ZERO, LEADING_ZEROS]) {
                stubDb();
                let result = await agg.receiveValidatedRound('BTC', makeRound(price, TIMESTAMP));
                expect(result, price).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
            }
        }
        async function acceptsTheHonestProducerPriceOnTest18() {
            for (const timestamp of [TIMESTAMP, TIMESTAMP + 1]) {
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
        }
        function receivevalidatedroundCanonicalRuleSuite13() {
            beforeEach(function () {
                hub = createMockHub();
                agg = new PriceAggregator(hub);
                hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
                    capability: 'price',
                    blockIndex: 800000,
                    count:      V.length,
                    validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
                }) };
            });
            afterEach(function () {
                sinon.restore();
            });
            it('refuses the over-wide price before any database work', refusesTheOverWidePriceTest15);
            it('refuses the near-zero and leading-zero forms too', refusesTheOtherNoncanonicalFormsTest16);
            it('accepts the honest producer price across valid timestamps', acceptsTheHonestProducerPriceOnTest18);
        }
        registerreceivevalidatedroundCanonicalRule12 = function registerSuite() {
            describe('receiveValidatedRound(): canonical rule', receivevalidatedroundCanonicalRuleSuite13);
        };
    }
    let registerreceivevalidatedbatchCanonicalRule19;
    {
        const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
        const FIRST_ROUND  = 100;
        const LAST_ROUND   = 105;
        const BATCH_ANCHOR = 799005;
        const BLOCK_INDEX  = 800000;
        const BLOCK_TIME   = 1700004000;
        let hub, agg;
        // Six rounds carry the price under test at round index 3, so checking only
        // the first round cannot make a case pass.
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
            let payload = agg.buildPriceBatchPayload(
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
        async function refusesTheWholeBatchTest22() {
            // A signed batch is atomic: one bad price invalidates every round in it, the
            // same shape the on-chain parser records.
            let inserts = stubDb();
            let result  = await agg.receiveValidatedBatch('BTC', makeBatch(WIDE, BLOCK_TIME));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.equal('invalid pairs');
            expect(result.stored).to.equal(0);
            expect(inserts.length).to.equal(0);
        }
        async function refusesTheOtherNoncanonicalFormsTest23() {
            for (const price of [NEAR_ZERO, LEADING_ZEROS]) {
                stubDb();
                let result = await agg.receiveValidatedBatch('BTC', makeBatch(price, BLOCK_TIME));
                expect(result.accepted, price).to.equal(false);
                expect(result.reason, price).to.equal('invalid pairs');
            }
        }
        async function acceptsAnAllHonestBatchOnTest24() {
            for (const blockTime of [BLOCK_TIME, BLOCK_TIME + 1]) {
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
        }
        function receivevalidatedbatchCanonicalRuleSuite20() {
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
            });
            afterEach(function () {
                sinon.restore();
            });
            it('refuses the WHOLE batch for an over-wide price, storing nothing partial', refusesTheWholeBatchTest22);
            it('refuses the near-zero and leading-zero forms too', refusesTheOtherNoncanonicalFormsTest23);
            it('accepts an all-honest batch across valid block times', acceptsAnAllHonestBatchOnTest24);
        }
        registerreceivevalidatedbatchCanonicalRule19 = function registerSuite() {
            describe('receiveValidatedBatch(): canonical rule', receivevalidatedbatchCanonicalRuleSuite20);
        };
    }
    function priceV0CanonicalPriceValueValidationSuite1() {
        registerbyteIdentityWithTheXchainIndexer2();
        registertheRuleThisHubShips5();
        registerreceivevalidatedroundCanonicalRule12();
        registerreceivevalidatedbatchCanonicalRule19();
    }
    describe('PRICE v0 canonical price-value validation: hub copy @regression', priceV0CanonicalPriceValueValidationSuite1);
}
