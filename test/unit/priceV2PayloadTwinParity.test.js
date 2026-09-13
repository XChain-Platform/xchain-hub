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
const OracleConsensus = require('../../src/OracleConsensus.js');
const PriceAggregator = require('../../src/PriceAggregator.js');
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
    try { return require('../../../xchain-indexer/src/ed25519.js'); }
    catch (e) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('PRICE v0 canonical parity cannot run: xchain-indexer sibling missing (' + e.message + ')');
        ctx.skip();
        return null;
    }
}

describe('PRICE v0 canonical: three-way twin parity', function () {

    let hub;
    before(function () { hub = hubTwins(); });

    it('the producer emits the pinned key order, ascending rounds and sorted pairs', function () {
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
    });

    it('the hub twins agree with each other, byte for byte', function () {
        assert.strictEqual(
            hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()),
            hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()),
            'PriceAggregator diverged from the OracleConsensus producer: hub ingest would reject every batch this hub signs');
    });

    it('the hub twins are caller-order independent', function () {
        for (const [name, twin] of [['producer', hub.producer], ['ingest', hub.ingest]]) {
            assert.strictEqual(
                twin._buildPriceBatchPayload(FIRST, LAST, ANCHOR, shuffledBatch()),
                twin._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()),
                'hub ' + name + ' is sensitive to caller ordering');
        }
    });

    // D36: v2 has no pre-flag-day history to stay bit-identical with, and the bare JSON
    // form is the shape that breaks SLASH's "an ORACLE-tagged canonical always carries
    // `round`" invariant. v0 at this height would be headerless.
    it('the hub twins wrap in the EQUIV header unconditionally, with no activation gate', function () {
        let rounds = [{ round: 1, timestamp: 1, btcBlockHeight: 1, pairs: [{ pair: 'BTC/USD', price: '1' }] }];
        let want   = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|1|1|1|0||';
        for (const [name, twin] of [['producer', hub.producer], ['ingest', hub.ingest]]) {
            let canonical = twin._buildPriceBatchPayload(1, 1, 1, rounds);
            assert.ok(canonical.startsWith(want), 'hub ' + name + ' did not wrap below the v0 flag-day: ' + canonical.slice(0, 60));
        }
        assert.strictEqual(eq.isEquivHeaderActive(1, 'mainnet'), false, 'the gate v0 would have failed here');
    });

    describe('against the indexer verifier twin', function () {

        it('all three twins emit the identical canonical for one batch', function () {
            let ed25519 = loadIndexerTwin(this);
            if (!ed25519) return;

            let fromIndexer  = ed25519.buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch());
            assert.strictEqual(hub.producer._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()), fromIndexer,
                'OracleConsensus (PRODUCER) diverged from the indexer verifier: the hub would sign bytes no indexer checks');
            assert.strictEqual(hub.ingest._buildPriceBatchPayload(FIRST, LAST, ANCHOR, batch()), fromIndexer,
                'PriceAggregator (hub ingest verifier) diverged from the indexer verifier');
        });

        it('all three normalize caller ordering to the same bytes', function () {
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
        });

        it('all three spell coinPair and pair to the same bytes', function () {
            let ed25519 = loadIndexerTwin(this);
            if (!ed25519) return;

            let rounds = [{ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ coinPair: 'BTC/USD', price: '1' }] }];
            let twin   = [{ round: 7, timestamp: 100, btcBlockHeight: 5, pairs: [{ pair:     'BTC/USD', price: 1   }] }];
            let expected = ed25519.buildPriceBatchPayload(7, 7, 5, rounds);
            assert.strictEqual(ed25519.buildPriceBatchPayload(7, 7, 5, twin), expected, 'indexer verifier');
            assert.strictEqual(hub.producer._buildPriceBatchPayload(7, 7, 5, twin), expected, 'hub producer');
            assert.strictEqual(hub.ingest._buildPriceBatchPayload(7, 7, 5, rounds), expected, 'hub ingest');
        });
    });
});

// The single-round PRICE v0 canonical is a separate write from the batch above (its own
// builders: OracleConsensus._buildPriceV0Payload, PriceAggregator._buildPriceV0Payload,
// xchain-indexer ed25519.buildPriceV0Payload) and, unlike the batch, it carries the round's
// ADMISSION MAP. That makes it ERA-KEYED on the round's own BTC anchor: below the producer
// activation the bytes are legacy and carry no field, at or above it the field is present,
// and a builder handed the wrong shape for its era REFUSES rather than signing bytes its
// twins cannot rebuild. So this describe drives BOTH eras, and its subject, the coinPair /
// pair spelling split, is asserted in each of them.
//
// THE DESCRIBE ARMS ITSELF, the same way priceV0CanonicalAdmission.test.js does. The
// activation resolves from the environment at MODULE LOAD, so setting process.env after the
// first require arms nothing: the only seam that works is purging the activation twin, the
// hub's admission seam and everything that closed over them from the require cache,
// re-requiring under the variable, and putting every cache entry and the variable back
// byte-exact. Without the arming this describe was green only because every activation map
// in the tree is inert, and it would have gone red the first time one was armed.
describe('PRICE v0 single-round canonical: three-way twin parity', function () {

    // Keyed on the ROUND's own BTC anchor, so ONE armed describe drives both eras: 798999 is
    // a legacy round and 799000 an admission-era one. 799000 is the anchor the price ingest
    // path is already exercised at, so no other flag day on this rail moves underneath.
    const ADMIT_AT  = 799000;
    const LEGACY_AT = ADMIT_AT - 1;

    const ROUND   = 5;
    const TIME    = 1756199400;
    const NETWORK = 'regtest';   // matches the stub hub these twins are built on

    // Insertion order deliberately NOT ASCII order: the encoder sorts, so the field's bytes
    // are fixed whatever order the caller assembled the map in.
    function admitMap() { return { DOGE: 5000004, BTC: 799004, LTC: 2400004 }; }
    const ADMIT_TAIL = '|BTC:799004,DOGE:5000004,LTC:2400004';

    // Every module that closed over the activation, in dependency order: the twin itself,
    // the hub's admission seam that re-exports its encoder, and the two builders that call
    // through the seam. Purging only the twin would leave the builders holding the inert one.
    const HUB_MODULES = [
        '../../src/mirror_admission_activation.js',
        '../../src/lib/admission_height.js',
        '../../src/OracleConsensus.js',
        '../../src/PriceAggregator.js'
    ];
    const INDEXER_MODULES = [
        '../../../xchain-indexer/src/mirror_admission_activation.js',
        '../../../xchain-indexer/src/ed25519.js'
    ];

    function armTwins() {
        const hubPaths = HUB_MODULES.map(m => require.resolve(m));
        let indexerPaths = null;
        try { indexerPaths = INDEXER_MODULES.map(m => require.resolve(m)); }
        catch (e) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('PRICE v0 single-round parity cannot run: xchain-indexer sibling missing (' + e.message + ')');
        }

        const paths    = hubPaths.concat(indexerPaths || []);
        const saved    = paths.map(p => [p, require.cache[p]]);
        const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        for (const p of paths) delete require.cache[p];
        process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);

        const ArmedOracleConsensus = require('../../src/OracleConsensus.js');
        const ArmedPriceAggregator = require('../../src/PriceAggregator.js');
        const act                  = require('../../src/mirror_admission_activation.js');
        const indexer              = indexerPaths ? require('../../../xchain-indexer/src/ed25519.js') : null;

        // Put the process back exactly as it was found. The instances built below keep the
        // armed modules they closed over, so the batch describe above and every other file in
        // the run still see the inert tree they were written against: the arming is scoped to
        // this describe and never to the process.
        function restore() {
            for (const [p, mod] of saved) {
                if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
            }
            if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
            else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
        }

        const stubHub = { db: null, network: NETWORK, getPeerManager: () => ({}) };
        return {
            act:      act,
            indexer:  indexer,
            producer: new ArmedOracleConsensus(stubHub, {}),
            ingest:   new ArmedPriceAggregator(stubHub),
            restore:  restore
        };
    }

    let armed = null;
    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });

    function pairsCoinKeyed() {
        return [
            { coinPair: 'XCP/USD',  price: 0.4237 },
            { pair:     'BTC/USD',  price: '61234.5' },
            { coinPair: 'AAA/USD',  price: 1 },
        ];
    }

    function pairsPairKeyed() {
        return pairsCoinKeyed().map(p => ({ pair: p.coinPair || p.pair, price: p.price }));
    }

    it('is ARMED, so neither era block below is the other one in disguise', function () {
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), true,
            'the admission-era cases would be vacuous: the activation did not arm');
        assert.strictEqual(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, LEGACY_AT), false,
            'the legacy cases would be vacuous: ' + LEGACY_AT + ' is not below the armed height');
    });

    // The same subject in both eras. `map()` is the round's admission map: absent below the
    // activation, where the legacy bytes must stay untouched, and present at or above it.
    for (const era of [
        { name: 'below the activation, where the round is legacy',            height: LEGACY_AT, map: () => undefined, tail: null },
        { name: 'at the activation, where the round carries an admission map', height: ADMIT_AT,  map: admitMap,       tail: ADMIT_TAIL },
    ]) {
        describe(era.name, function () {

            // The era is DRIVEN, not merely named. Without this case both blocks could be
            // running the legacy path and the whole two-era structure would prove nothing.
            it('puts the admission field on the signed bytes exactly in its own era', function () {
                let canonical = armed.producer._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), era.height, era.map());
                if (era.tail === null) {
                    assert.ok(canonical.endsWith('}'), 'a legacy round ends at its JSON body: ' + canonical.slice(-40));
                    assert.ok(!/BTC:799004/.test(canonical), 'a legacy round carries no admission field: ' + canonical.slice(-60));
                } else {
                    assert.ok(canonical.endsWith(era.tail), 'the admission field is missing from the signed bytes: ' + canonical.slice(-60));
                }
            });

            it('the hub twins agree with each other on a coinPair-keyed round', function () {
                assert.strictEqual(
                    armed.ingest._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), era.height, era.map()),
                    armed.producer._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), era.height, era.map()),
                    'PriceAggregator diverged from the OracleConsensus producer on a coinPair-keyed round');
            });

            it('a coinPair-keyed round matches the pair-keyed form on both hub twins', function () {
                for (const [name, twin] of [['producer', armed.producer], ['ingest', armed.ingest]]) {
                    assert.strictEqual(
                        twin._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), era.height, era.map()),
                        twin._buildPriceV0Payload(ROUND, TIME, pairsPairKeyed(), era.height, era.map()),
                        'hub ' + name + ' spells coinPair and pair to different bytes');
                }
            });

            describe('against the indexer verifier twin', function () {

                it('all three twins emit identical bytes for a coinPair-keyed round', function () {
                    if (!armed.indexer) { this.skip(); return; }

                    let expected = armed.indexer.buildPriceV0Payload(ROUND, TIME, pairsPairKeyed(), NETWORK, era.height, era.map());
                    assert.strictEqual(
                        armed.indexer.buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), NETWORK, era.height, era.map()), expected,
                        'indexer verifier: coinPair input must match pair input');
                    assert.strictEqual(
                        armed.producer._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), era.height, era.map()), expected,
                        'OracleConsensus (PRODUCER) diverged from the indexer verifier on a coinPair-keyed round');
                    assert.strictEqual(
                        armed.ingest._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), era.height, era.map()), expected,
                        'PriceAggregator (hub ingest verifier) diverged from the indexer verifier on a coinPair-keyed round');
                });
            });
        });
    }

    // The BATCH canonical in the same armed process (row 26): one map PER ROUND, era-keyed on
    // each round's own anchor, the map the LAST key of its round and spelled by the one
    // encoder. Drives both eras and both refusal directions across the hub twins, and the
    // indexer verifier where the sibling resolves. This describe is what makes a hub producer
    // that drops the key RED inside the hub's own suite rather than only in the indexer's.
    describe('the BATCH canonical carries one admission map per round', function () {
        const FIRST = 100, LAST = 101;
        const MAPS  = [{ DOGE: 5000004, BTC: 799004 }, { LTC: 2400004, BTC: 799005 }];
        const TAILS = ['BTC:799004,DOGE:5000004', 'BTC:799005,LTC:2400004'];

        // Two rounds at [base, base + 1]; maps[i] on round i when given.
        function rounds(base, maps) {
            return [0, 1].map(i => {
                let r = { round: FIRST + i, timestamp: TIME + i * 600, btcBlockHeight: base + i,
                          pairs: [{ coinPair: 'XCP/USD', price: 0.4237 }, { pair: 'BTC/USD', price: '61234.5' }] };
                if (maps && maps[i] !== undefined) r.admitBlocks = maps[i];
                return r;
            });
        }
        const body = bytes => JSON.parse(bytes.slice(bytes.indexOf('{')));

        it('the hub twins agree, and the indexer verifier with them, in the admission era', function () {
            let era = rounds(ADMIT_AT, MAPS);
            let fromProducer = armed.producer._buildPriceBatchPayload(FIRST, LAST, ADMIT_AT + 1, era);
            let fromIngest   = armed.ingest._buildPriceBatchPayload(FIRST, LAST, ADMIT_AT + 1, era);
            assert.strictEqual(fromIngest, fromProducer, 'PriceAggregator diverged from OracleConsensus on an era batch');
            let b = body(fromProducer);
            assert.deepStrictEqual(b.rounds.map(r => Object.keys(r)),
                [['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks'],
                 ['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks']]);
            assert.deepStrictEqual(b.rounds.map(r => r.admit_blocks), TAILS);
            assert.deepStrictEqual(b.rounds.map(r => armed.act.decodeAdmitBlocks(r.admit_blocks)),
                [{ BTC: 799004, DOGE: 5000004 }, { BTC: 799005, LTC: 2400004 }]);
            if (armed.indexer)
                assert.strictEqual(armed.indexer.buildPriceBatchPayload(FIRST, LAST, ADMIT_AT + 1, era, NETWORK), fromProducer,
                    'the indexer verifier diverged from the hub producer on an era batch');
        });

        it('below the activation the bytes are the pre-admission form exactly, on all twins', function () {
            let legacy = rounds(LEGACY_AT - 1);
            let fromProducer = armed.producer._buildPriceBatchPayload(FIRST, LAST, LEGACY_AT, legacy);
            assert.strictEqual(armed.ingest._buildPriceBatchPayload(FIRST, LAST, LEGACY_AT, legacy), fromProducer);
            assert.strictEqual(/admit/.test(fromProducer), false);
            assert.deepStrictEqual(Object.keys(body(fromProducer).rounds[0]), ['round', 'timestamp', 'btc_block_height', 'pairs']);
            if (armed.indexer)
                assert.strictEqual(armed.indexer.buildPriceBatchPayload(FIRST, LAST, LEGACY_AT, legacy, NETWORK), fromProducer);
        });

        it('every twin refuses in both directions: an era round with no map, a legacy round with one', function () {
            let twins = [['producer', (r, a) => armed.producer._buildPriceBatchPayload(FIRST, LAST, a, r)],
                         ['ingest',   (r, a) => armed.ingest._buildPriceBatchPayload(FIRST, LAST, a, r)]];
            if (armed.indexer) twins.push(['indexer', (r, a) => armed.indexer.buildPriceBatchPayload(FIRST, LAST, a, r, NETWORK)]);
            for (const [name, build] of twins) {
                assert.throws(() => build(rounds(ADMIT_AT), ADMIT_AT + 1), /has no admit_blocks; refusing to build a legacy canonical/,
                    name + ' built legacy bytes for an era round');
                assert.throws(() => build(rounds(LEGACY_AT - 1, MAPS), LEGACY_AT), /was handed admit_blocks .*; refusing to build an admission-era canonical/,
                    name + ' built era bytes for a legacy round');
            }
        });

        it('the map is keyed on EACH round\'s own anchor: a straddling window carries it on the era round only', function () {
            // The canonical itself does not refuse a straddle (the ingest and the parser do, per
            // the ruling); it spells exactly what each round's own era says.
            let mixed = rounds(LEGACY_AT, [undefined, MAPS[1]]);
            let b = body(armed.producer._buildPriceBatchPayload(FIRST, LAST, ADMIT_AT, mixed));
            assert.strictEqual(b.rounds[0].admit_blocks, undefined);
            assert.strictEqual(b.rounds[1].admit_blocks, TAILS[1]);
        });
    });
});
