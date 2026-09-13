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
 * priceV0CanonicalAdmission: the PRICE v0 canonical carries the round's ADMISSION MAP,
 * and it is written THREE times: OracleConsensus._buildPriceV0Payload signs it,
 * PriceAggregator._buildPriceV0Payload re-checks every pushed round against it, and
 * xchain-indexer ed25519.buildPriceV0Payload rebuilds it from the on-chain action. One of
 * the three spelling the map differently is not a stall, it is a fork: the hub collects a
 * quorum over bytes no indexer can reproduce, every round is then unverifiable, and the
 * native-fee / XCHAIN-USD path stops with the price rail.
 *
 * So the load-bearing assertion in this file is byte EQUALITY across the three builders,
 * driven on the same inputs, in BOTH eras: below the activation there is no field at all
 * (the legacy bytes are untouched) and at or above it the field is present and identical.
 *
 * THE SUITE ARMS ITSELF. The admission activation is read from the environment at module
 * load, so the suite purges the activation twin, the hub's admission seam and the two hub
 * classes from the require cache, sets the regtest height, re-requires them, and restores
 * every cache entry and the variable afterwards. A suite that only drove whichever arming
 * the process happened to launch with would report the admission-era cases as PENDING, and
 * a pending case on a consensus byte layout is the failure mode this file exists to close.
 ********************************************************************/

'use strict';

const assert            = require('assert');
const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const { createMockHub } = require('../helpers/mockHub');
const eq                = require('../../src/equivocation_header.js');

// The regtest producer activation this suite arms, keyed on the ROUND's own BTC anchor. One
// armed process therefore drives both eras: a round below this height is a legacy round and
// a round at or above it is an admission-era round. 799000 is the anchor the price ingest
// path is already exercised at, so no other flag day on this rail moves underneath.
const ADMIT_AT  = 799000;
const LEGACY_AT = ADMIT_AT - 1;

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

const ROUND   = 5;
const TIME    = 1756199400;
const NETWORK = 'regtest';

// Pairs handed over unsorted and keyed both ways, so a builder that trusted its caller
// would emit different bytes than its twins for the identical round.
function pairsCoinKeyed() {
    return [
        { coinPair: 'XCP/USD', price: 0.4237 },
        { pair:     'BTC/USD', price: '61234.5' },
        { coinPair: 'AAA/USD', price: 1 }
    ];
}
function pairsPairKeyed() {
    return pairsCoinKeyed().map(p => ({ pair: p.coinPair || p.pair, price: p.price }));
}

// Insertion order deliberately NOT ASCII order: the encoding sorts, so these bytes are
// fixed whatever order the map was assembled in.
function admitMap() { return { DOGE: 5000004, BTC: 799004, LTC: 2400004 }; }
const ADMIT_FIELD = 'BTC:799004,DOGE:5000004,LTC:2400004';

let armed = null;

function armTwins() {
    const hubPaths = HUB_MODULES.map(m => require.resolve(m));
    let indexerPaths = null;
    try { indexerPaths = INDEXER_MODULES.map(m => require.resolve(m)); }
    catch (e) {
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('PRICE v0 admission parity cannot run: xchain-indexer sibling missing (' + e.message + ')');
    }

    const paths    = hubPaths.concat(indexerPaths || []);
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(ADMIT_AT);

    const OracleConsensus = require('../../src/OracleConsensus.js');
    const PriceAggregator = require('../../src/PriceAggregator.js');
    const act             = require('../../src/mirror_admission_activation.js');
    const indexer         = indexerPaths ? require('../../../xchain-indexer/src/ed25519.js') : null;

    // Put the process back exactly as it was found. The instances built below keep the
    // armed modules they closed over, so the rest of the run still sees the inert tree it
    // was written against: arming is scoped to this file and not to the process.
    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }

    function hubOn(network) { return { db: null, network: network, getPeerManager: () => ({}) }; }

    return {
        act:      act,
        indexer:  indexer,
        producer: new OracleConsensus(hubOn(NETWORK), {}),
        ingest:   new PriceAggregator(hubOn(NETWORK)),
        // Second pair on an INERT network, to drive the era key: a mainnet round is a legacy
        // round at every height, including heights far above the armed regtest threshold.
        inertProducer: new OracleConsensus(hubOn('mainnet'), {}),
        inertIngest:   new PriceAggregator(hubOn('mainnet')),
        OracleConsensus: OracleConsensus,
        PriceAggregator: PriceAggregator,
        restore:  restore
    };
}

// The three builders on one round. `network` picks which pair of hub instances answers,
// because the hub twins read the era network off their own hub while the indexer takes it
// as an argument, and the three must still agree.
function three(height, map, network) {
    const net = network || NETWORK;
    const p = (net === NETWORK) ? armed.producer : armed.inertProducer;
    const i = (net === NETWORK) ? armed.ingest   : armed.inertIngest;
    return {
        producer: () => p._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), height, map),
        ingest:   () => i._buildPriceV0Payload(ROUND, TIME, pairsCoinKeyed(), height, map),
        indexer:  () => armed.indexer
            ? armed.indexer.buildPriceV0Payload(ROUND, TIME, pairsPairKeyed(), net, height, map)
            : null
    };
}

function builtBy(height, map, network) {
    const b = three(height, map, network);
    return { producer: b.producer(), ingest: b.ingest(), indexer: b.indexer() };
}

describe('PRICE v0 canonical: the admission field across all three byte-twins', function () {

    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });

    it('is ARMED for this suite, so neither era case is vacuous', function () {
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT)).to.equal(true);
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, LEGACY_AT)).to.equal(false);
        // And the inert side of the era key, which the mainnet cases below rely on.
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', 'mainnet', ADMIT_AT)).to.equal(false);
        expect(armed.indexer, 'the indexer verifier twin must be resolvable in a monorepo run').to.not.equal(null);
    });

    describe('below the activation: the legacy bytes are untouched', function () {

        it('all three emit the identical canonical, with no admission field', function () {
            const b = builtBy(LEGACY_AT, undefined);
            assert.strictEqual(b.ingest, b.producer,
                'PriceAggregator diverged from the OracleConsensus producer on a legacy round');
            assert.strictEqual(b.indexer, b.producer,
                'the indexer verifier diverged from the producer on a legacy round');
            // The body is the last thing in the canonical, so a legacy round ends at the JSON.
            expect(b.producer.endsWith('}')).to.equal(true, b.producer.slice(-40));
            expect(b.producer).to.not.match(/BTC:799004/);
        });

        it('a mainnet round is legacy at a height far above the armed regtest one', function () {
            const b = builtBy(ADMIT_AT + 1000000, undefined, 'mainnet');
            assert.strictEqual(b.ingest, b.producer);
            assert.strictEqual(b.indexer, b.producer);
            expect(b.producer.endsWith('}')).to.equal(true);
        });

        it('all three REFUSE a map on a legacy round rather than signing bytes no era reads', function () {
            const b = three(LEGACY_AT, admitMap());
            for (const [name, build] of [['producer', b.producer], ['ingest', b.ingest], ['indexer', b.indexer]])
                expect(build, name).to.throw(/refusing to build an admission-era canonical/);
        });
    });

    describe('at and above the activation: the field is present and identical', function () {

        it('all three emit the identical canonical for one round and map', function () {
            const b = builtBy(ADMIT_AT, admitMap());
            assert.strictEqual(b.ingest, b.producer,
                'PriceAggregator diverged from the OracleConsensus producer: this hub would reject every round it signs');
            assert.strictEqual(b.indexer, b.producer,
                'the indexer verifier diverged from the producer: the hub would sign bytes no indexer checks');
            expect(b.producer.endsWith('|' + ADMIT_FIELD)).to.equal(true, b.producer.slice(-60));
        });

        // The exact byte layout, stated as an assertion rather than as a comment: the EQUIV
        // header, then the round body, then a single '|' and the ASCII-ordered map. The field
        // is INSIDE the wrapped body, which is where every other rail puts it, so the wrapper
        // stays a pure function of the bytes it wraps.
        it('appends the field after the JSON body and inside the EQUIV wrapper', function () {
            const canonical = builtBy(ADMIT_AT, admitMap()).producer;
            const prefix    = 'EQUIV|' + eq.ENGINE_TAGS.ORACLE + '|' + ADMIT_AT + '|0||';
            expect(canonical.startsWith(prefix)).to.equal(true, canonical.slice(0, 60));

            const wrapped = canonical.slice(prefix.length);
            const cut     = wrapped.lastIndexOf('|');
            const body    = wrapped.slice(0, cut);
            const field   = wrapped.slice(cut + 1);
            assert.deepStrictEqual(Object.keys(JSON.parse(body)),
                ['round', 'timestamp', 'btc_block_height', 'pairs'],
                'the round body must be unchanged: the admission field is APPENDED, never interleaved');
            assert.strictEqual(field, ADMIT_FIELD);
            // And a consumer reads back exactly the map the producer signed, through the twin's
            // own decoder: the field is not merely present, it is the canonical encoding.
            assert.deepStrictEqual(armed.act.decodeAdmitBlocks(field),
                { BTC: 799004, DOGE: 5000004, LTC: 2400004 });
        });

        it('the map insertion order never reaches the bytes, on any of the three', function () {
            const other = { LTC: 2400004, BTC: 799004, DOGE: 5000004 };
            const a = builtBy(ADMIT_AT, admitMap());
            const b = builtBy(ADMIT_AT, other);
            for (const k of ['producer', 'ingest', 'indexer'])
                assert.strictEqual(b[k], a[k], k + ' is sensitive to the map\'s insertion order');
        });

        it('one changed height changes the signed bytes on all three, and they still agree', function () {
            const moved = { DOGE: 5000004, BTC: 799005, LTC: 2400004 };
            const a = builtBy(ADMIT_AT, admitMap());
            const b = builtBy(ADMIT_AT, moved);
            for (const k of ['producer', 'ingest', 'indexer'])
                assert.notStrictEqual(b[k], a[k], k + ' signs the same bytes for two different admission maps');
            assert.strictEqual(b.ingest, b.producer);
            assert.strictEqual(b.indexer, b.producer);
        });

        it('all three REFUSE a round with no map, rather than signing legacy bytes above the era', function () {
            for (const missing of [null, undefined]) {
                const b = three(ADMIT_AT, missing);
                for (const [name, build] of [['producer', b.producer], ['ingest', b.ingest], ['indexer', b.indexer]])
                    expect(build, name + ' with ' + String(missing)).to.throw(/refusing to build a legacy canonical/);
            }
        });

        it('all three refuse a map the encoding cannot spell injectively', function () {
            for (const bad of [{ BTC: '0799004' }, { btc: 799004 }, { BTC: -1 }, {}]) {
                const b = three(ADMIT_AT + 1, bad);
                for (const [name, build] of [['producer', b.producer], ['ingest', b.ingest], ['indexer', b.indexer]])
                    expect(build, name + ' with ' + JSON.stringify(bad))
                        .to.throw(/canonically spelled|closed vocabulary|EMPTY admission map/);
            }
        });
    });

    // The hub's own ingest path, driven rather than reasoned about: a round signed over the
    // admission-era canonical must verify through receiveValidatedRound, and a round whose
    // map the encoder refuses must come back REJECTED rather than throwing out of the push
    // handler. The map rides the pushed round because the producer signed THAT map; one
    // re-resolved from this hub's tips would rebuild bytes no signature covers.
    describe('through the hub ingest verifier, end to end', function () {

        const V = [0, 1, 2, 3].map(() => {
            const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
            return {
                pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
                sign:   (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
            };
        });
        const PAIRS = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];

        let hub, agg;

        beforeEach(function () {
            hub = createMockHub({ network: NETWORK });
            agg = new armed.PriceAggregator(hub);
            // BOTH snapshot shapes: regtest runs with stake-weighted quorum armed, so the
            // verifier resolves the WEIGHT snapshot, and a suite stubbing only the count
            // snapshot would report every round as 'validator snapshot unavailable' and
            // never reach the canonical at all.
            hub.capabilitySnapshot = {
                getSnapshot: sinon.stub().resolves({
                    capability: 'price',
                    blockIndex: 800000,
                    count:      V.length,
                    validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
                }),
                getWeightSnapshot: sinon.stub().resolves({
                    capability:  'price',
                    blockIndex:  800000,
                    count:       V.length,
                    sourceCount: V.length,
                    validators:  V.map((v, i) => ({ pubkey: v.pubkey, source: 'src-' + i, weight: '50' }))
                })
            };
            hub.db.doQuery.callsFake(async (sql) => {
                if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
                return [];
            });
        });

        afterEach(function () { sinon.restore(); });

        function round(overrides) {
            const map     = (overrides && 'admit_blocks' in overrides) ? overrides.admit_blocks : admitMap();
            const payload = agg._buildPriceV0Payload(5, 1700000000, PAIRS, ADMIT_AT, map);
            return Object.assign({
                round: 5,
                timestamp: 1700000000,
                btc_block_height: ADMIT_AT,
                block_index: 800000,
                action_index: 42,
                pairs: PAIRS,
                admit_blocks: map,
                sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
            }, overrides || {});
        }

        it('accepts a round whose signatures cover the admission-era canonical', async function () {
            const result = await agg.receiveValidatedRound('BTC', round());
            expect(result.accepted).to.equal(true, 'reason: ' + result.reason);
        });

        it('rejects, and does not throw, when the pushed map is unspellable', async function () {
            const r      = round();
            r.admit_blocks = { BTC: '0799004' };         // a leading zero no verifier could re-derive
            const result = await agg.receiveValidatedRound('BTC', r);
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.match(/admission map unusable/);
        });

        it('rejects an admission-era round that carries no map at all', async function () {
            const r = round();
            delete r.admit_blocks;
            const result = await agg.receiveValidatedRound('BTC', r);
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.match(/refusing to build a legacy canonical/);
        });

        it('refuses the signatures when the pushed map is not the one that was signed', async function () {
            // The bite: a relay that edits one height in flight must not be able to get the
            // round stored, even though every signature in it is a real signature.
            const r = round();
            r.admit_blocks = { DOGE: 5000004, BTC: 799005, LTC: 2400004 };
            const result = await agg.receiveValidatedRound('BTC', r);
            expect(result.accepted).to.equal(false, 'an edited admission map verified');
        });
    });
});
