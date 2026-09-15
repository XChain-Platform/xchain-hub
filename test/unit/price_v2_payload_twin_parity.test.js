/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * priceV2PayloadTwinParity: the PRICE v0 canonical is written three times, and the
 * hub owns two of them. OracleConsensus._buildPriceBatchPayload SIGNS; anything
 * PriceAggregator._buildPriceBatchPayload or xchain-indexer ed25519.buildPriceBatchPayload
 * builds differently is a batch the federation cannot verify, so the price rail stops
 * and the native-fee / XCHAIN-USD path stops with it. This suite asserts byte equality
 * on a batch built to exercise every normalization the builders own (round order, pair
 * order, integer spelling, the coinPair/pair spelling split).
 *
 * The indexer twin is resolved by monorepo-relative path: a standalone hub checkout
 * skips that comparison (unless XCHAIN_REQUIRE_SIBLINGS=1) and still compares the hub's
 * own two copies against each other.
 *
 * TWO CANONICALS, TWO ERA RULES. The BATCH canonical carries no admission map, so the first
 * describe is era-free and stays so. The SINGLE-ROUND canonical does carry one, so the second
 * describe ARMS the admission activation itself and drives both eras; see its own header.
 ********************************************************************/

'use strict';

const assert          = require('assert');
const OracleConsensus = require('../../src/oracle/consensus.js');
const PriceAggregator = require('../../src/oracle/price_aggregator.js');
const eq              = require('../../src/equivocation_header.js');

const ANCHOR = 912345;   // equals the last round's own anchor, per the wire format
const FIRST  = 1039;
const LAST   = 1042;

// Deliberately hostile input: rounds out of order, pairs out of order, integer fields
// spelled as both strings and numbers, and pairs keyed both `coinPair` (the producer's
// in-memory spelling) and `pair` (the wire-parsed spelling).
function batch() {
    return [
        { round: 1041,   timestamp: 1756200600,   btcBlockHeight: '912344', pairs: [
            { coinPair: 'XCP/USD',  price: 0.4237 },
            { pair:     'BTC/USD',  price: '61234.5' } ] },
        { round: '1039', timestamp: '1756199400', btcBlockHeight: 912342,   pairs: [
            { pair:     'LTC/USD',  price: '71.02' },
            { coinPair: 'BTC/USD',  price: 61111 },
            { pair:     'DOGE/USD', price: '0.1234' } ] },
        { round: 1042,   timestamp: 1756201200,   btcBlockHeight: 912345,   pairs: [
            { coinPair: 'DOGE/USD', price: '0.1240' },
            { coinPair: 'BTC/USD',  price: '61300' } ] },
        { round: '1040', timestamp: 1756200000,   btcBlockHeight: '912343', pairs: [
            { pair:     'BTC/USD',  price: 61222 } ] },
    ];
}

// Same batch, every list handed over in the opposite order. A builder that trusted its
// caller's ordering instead of sorting would emit different bytes for this.
function shuffledBatch() {
    return batch().reverse().map(r => Object.assign({}, r, { pairs: [...r.pairs].reverse() }));
}

const PREFIX = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|' + ANCHOR + '|' + FIRST + '|' + LAST + '|0||';

// Real instances, not prototype stand-ins: both constructors only need a hub with
// db/network/getPeerManager, so the methods are reached the way production reaches them.
//
// Pinned to MAINNET, which is inert at every height in this train, so this describe stays
// the LEGACY-bytes describe whatever the process was launched with: the batch canonical
// refuses an era round with no map, and these fixtures carry none on purpose. The armed
// describe at the bottom of the file drives the admission era through a re-required tree.
function hubTwins() {
    const stubHub = { db: null, network: 'mainnet', getPeerManager: () => ({}) };
    return {
        producer: new OracleConsensus(stubHub, {}),
        ingest:   new PriceAggregator(stubHub)
    };
}

function loadIndexerTwin(ctx) {
    try { return require('../../../xchain-indexer/src/consensus/ed25519.js'); }
    catch (e) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('PRICE v0 canonical parity cannot run: xchain-indexer sibling missing (' + e.message + ')');
        ctx.skip();
        return null;
    }
}

{

    let hub;

    function theProducerEmitsThePinnedKeyTest2() {
        let canonical = hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
        assert.ok(canonical.startsWith(PREFIX), 'EQUIV prefix: ' + canonical.slice(0, 60));

        let body = JSON.parse(canonical.slice(PREFIX.length));
        assert.deepStrictEqual(Object.keys(body), ['first_round', 'last_round', 'btc_block_height', 'rounds']);
        assert.deepStrictEqual([body.first_round, body.last_round, body.btc_block_height], [FIRST, LAST, ANCHOR]);
        assert.deepStrictEqual(body.rounds.map(r => r.round), [1039, 1040, 1041, 1042], 'rounds ascending');

        for (const r of body.rounds) {
            assert.deepStrictEqual(Object.keys(r), ['round', 'timestamp', 'btc_block_height', 'pairs']);
            assert.deepStrictEqual(r.pairs.map(p => p.pair), [...r.pairs.map(p => p.pair)].sort(), 'pairs sorted in round ' + r.round);
            for (const p of r.pairs) {
                assert.deepStrictEqual(Object.keys(p), ['pair', 'price']);
                assert.strictEqual(typeof p.price, 'string', 'prices are stringified');
            }
        }
        assert.deepStrictEqual(body.rounds[0], {
            round: 1039, timestamp: 1756199400, btc_block_height: 912342,
            pairs: [ { pair: 'BTC/USD', price: '61111' }, { pair: 'DOGE/USD', price: '0.1234' }, { pair: 'LTC/USD', price: '71.02' } ]
        });
    }

    function theHubTwinsAgreeWithEachTest3() {
        assert.strictEqual(
            hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()),
            hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()),
            'PriceAggregator diverged from the OracleConsensus producer: hub ingest would reject every batch this hub signs');
    }

    function theHubTwinsAreCallerOrderTest4() {
        for (const [name, twin] of [['producer', hub.producer], ['ingest', hub.ingest]]) {
            assert.strictEqual(
                twin._buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch()),
                twin._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()),
                'hub ' + name + ' is sensitive to caller ordering');
        }
    }

    function theHubTwinsWrapInTheTest5() {
        let rounds = [{ round: 1, timestamp: 1, btcBlockHeight: 1, pairs: [{ pair: 'BTC/USD', price: '1' }] }];
        let want   = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|1|1|1|0||';
        for (const [name, twin] of [['producer', hub.producer], ['ingest', hub.ingest]]) {
            let canonical = twin._buildPriceBatchPayload(1, 1, 1, rounds);
            assert.ok(canonical.startsWith(want), 'hub ' + name + ' did not wrap below the v0 flag-day: ' + canonical.slice(0, 60));
        }
        assert.strictEqual(eq.isEquivHeaderActive(1, 'mainnet'), false, 'the gate v0 would have failed here');
    }

    let registeragainstTheIndexerVerifierTwin6;

    {

        function allThreeTwinsEmitTheIdenticalTest8() {
            let ed25519 = loadIndexerTwin(this);
            if (!ed25519) return;

            let fromIndexer  = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            assert.strictEqual(hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()), fromIndexer,
                'OracleConsensus (PRODUCER) diverged from the indexer verifier: the hub would sign bytes no indexer checks');
            assert.strictEqual(hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()), fromIndexer,
                'PriceAggregator (hub ingest verifier) diverged from the indexer verifier');
        }

        function allThreeNormalizeCallerOrderingToTest9() {
            let ed25519 = loadIndexerTwin(this);
            if (!ed25519) return;

            let expected = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            for (const [name, canonical] of [
                ['indexer verifier', ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
                ['hub producer',     hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
                ['hub ingest',       hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch())],
            ]) {
                assert.strictEqual(canonical, expected, name + ' is sensitive to caller ordering');
            }
        }

        function allThreeSpellCoinpairAndPairTest10() {
            let ed25519 = loadIndexerTwin(this);
            if (!ed25519) return;

            let rounds = [{ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ coinPair: 'BTC/USD', price: '1' }] }];
            let twin   = [{ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ pair:     'BTC/USD', price: 1   }] }];
            let expected = ed25519.buildPriceBatchPayload(7, 7, 5, rounds);
            assert.strictEqual(ed25519.buildPriceBatchPayload(7, 7, 5, twin), expected, 'indexer verifier');
            assert.strictEqual(hub.producer._buildPriceBatchPayload(7, 7, 5, twin), expected, 'hub producer');
            assert.strictEqual(hub.ingest._buildPriceBatchPayload(7, 7, 5, rounds), expected, 'hub ingest');
        }

        function againstTheIndexerVerifierTwinSuite7() {
            it('all three twins emit the identical canonical for one batch', allThreeTwinsEmitTheIdenticalTest8);
            it('all three normalize caller ordering to the same bytes', allThreeNormalizeCallerOrderingToTest9);
            it('all three spell coinPair and pair to the same bytes', allThreeSpellCoinpairAndPairTest10);
        }

        registeragainstTheIndexerVerifierTwin6 = function registerSuite() {
            describe('against the indexer verifier twin', againstTheIndexerVerifierTwinSuite7);
        };

    }

    function priceV0CanonicalThreeWayTwinSuite1() {
        before(function () { hub = hubTwins(); });
        it('the producer emits the pinned key order, ascending rounds and sorted pairs', theProducerEmitsThePinnedKeyTest2);
        it('the hub twins agree with each other, byte for byte', theHubTwinsAgreeWithEachTest3);
        it('the hub twins are caller-order independent', theHubTwinsAreCallerOrderTest4);
        it('the hub twins wrap in the EQUIV header unconditionally, with no activation gate', theHubTwinsWrapInTheTest5);
        registeragainstTheIndexerVerifierTwin6();
    }

    describe('PRICE v0 canonical: three-way twin parity', priceV0CanonicalThreeWayTwinSuite1);

}
