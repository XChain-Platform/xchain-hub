'use strict';

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
 * THE ADMISSION MAP'S WIRE CARRIER on the price rail (frontier rows 17 and 14).
 *
 * The canonical carries the map and every builder spells it identically, but bytes only
 * matter if the map ARRIVES. Three things are driven here, all of them on the transport
 * rather than on the encoding:
 *
 *   1. pushpriceround forwards `admit_blocks` into receiveValidatedRound. The handler
 *      destructures an explicit key list, so a key it does not name is dropped in silence:
 *      every pushed round arrived with the map absent and therefore read as a LEGACY round
 *      however it had been signed. The proof is a ROUND TRIP through the real aggregator:
 *      a round signed over the admission-era canonical is accepted when the RPC carries the
 *      map and REFUSED when the identical call omits it.
 *
 *   2. The BATCH rail has no carrier at all, and now fails CLOSED instead of open.
 *      _buildPriceBatchPayload serializes {round, timestamp, btc_block_height, pairs} per
 *      round and nothing else, so an admission map cannot ride a batch and could not be
 *      verified against a signature if it did. Before this row an admission-era batch
 *      VERIFIED and stored its rounds as legacy rows, silently, above the very activation
 *      meant to bind them by height.
 *
 *   3. oracle_prices.admit_block is populated from the hub's own ingest (row 14), and its
 *      failure value is NULL and never 0.
 *
 * THE SUITE ARMS ITSELF, on the pattern priceV0CanonicalAdmission.test.js established: the
 * activation resolver freezes at require time, so setting the variable afterwards arms
 * nothing and every admission case would report PENDING. Both eras are driven here.
 ********************************************************************/

const assert        = require('assert');
const crypto        = require('crypto');
const sinon         = require('sinon');
const { expect }    = require('chai');
const proxyquire    = require('proxyquire').noPreserveCache();
const { createMockHub } = require('../helpers/mockHub');
const { waitUntil }     = require('../helpers/waitUntil');

// The regtest activation this suite arms. Keyed on the ROUND's own BTC anchor for the
// signed rails, and on the PUBLISHING chain's own tip for the unsigned oracle rail, so one
// armed process drives both eras of both.
const ADMIT_AT  = 799000;
const LEGACY_AT = ADMIT_AT - 1;
const NETWORK   = 'regtest';

// Every module that closes over the activation. PriceAggregator reads it twice (through the
// hub's admission seam and directly, for the coin-keyed producer predicate), so all three
// have to be purged together or the class keeps an inert copy.
const ARMED_MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/lib/admission_height.js',
    '../../src/PriceAggregator.js',
    '../../src/OracleBatchSigner.js',
    '../../src/OraclePublisher.js',
    '../../src/OracleConsensus.js'
];

let armed = null;

function armTwins(atHeight) {
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(atHeight === undefined ? ADMIT_AT : atHeight);

    const PriceAggregator  = require('../../src/PriceAggregator.js');
    const OracleBatchSigner = require('../../src/OracleBatchSigner.js');
    const OraclePublisher  = require('../../src/OraclePublisher.js');
    const OracleConsensus  = require('../../src/OracleConsensus.js');
    const act              = require('../../src/mirror_admission_activation.js');

    // Put the process back exactly as it was found; the classes captured above keep the
    // armed modules they closed over, so arming is scoped to this file.
    function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
    return { act, PriceAggregator, OracleBatchSigner, OraclePublisher, OracleConsensus, restore };
}

// ---------------------------------------------------------------------------
// api.js under proxyquire, so the RPC handler itself is driven rather than a
// re-implementation of it. Pattern lifted verbatim from pushPriceBatch.test.js.
// ---------------------------------------------------------------------------
async function bootApi(hubOverrides) {
    const mockApp = {
        use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub()
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json  = sinon.stub().returns(function expressJson() {});

    const mockHub = new Proxy(Object.assign({}, hubOverrides), {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    let capturedController = null;
    const mockJsonRouter = sinon.stub().callsFake((opts) => {
        capturedController = opts.methods;
        return function routerMw() {};
    });

    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                     'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
                     'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_ALLOW_UNAUTHENTICATED: 'true',
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999'
    });
    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': mockJsonRouter,
            'http': { createServer: sinon.stub().returns(mockServer) },
            'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; }
        });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });
    expect(capturedController, 'jsonRpcController not captured').to.not.equal(null);
    return capturedController;
}

// Four ed25519 validators, and a price-capability snapshot that answers in both the count
// and the weight shape: regtest runs stake-weighted, so a suite stubbing only one of them
// never reaches the canonical at all.
function validators(n) {
    return [...Array(n)].map(() => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        return {
            pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
            sign:   (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
        };
    });
}

function snapshotFor(V) {
    return {
        getSnapshot: sinon.stub().resolves({
            capability: 'price', blockIndex: 800000, count: V.length,
            validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
        }),
        getWeightSnapshot: sinon.stub().resolves({
            capability: 'price', blockIndex: 800000, count: V.length, sourceCount: V.length,
            validators: V.map((v, i) => ({ pubkey: v.pubkey, source: 'src-' + i, weight: '50' }))
        })
    };
}

describe('the admission map on the price wire (rows 17 and 14)', function () {

    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
    afterEach(function () { sinon.restore(); });

    it('is ARMED for this suite, so neither era case is vacuous', function () {
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT)).to.equal(true);
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, LEGACY_AT)).to.equal(false);
        expect(armed.act.isMirrorAdmissionProducerActive('LTC', NETWORK, ADMIT_AT)).to.equal(true);
        expect(armed.act.isMirrorAdmissionProducerActive('LTC', 'mainnet', ADMIT_AT)).to.equal(false);
    });

    // -----------------------------------------------------------------------
    // 1. pushpriceround: the round rail's carrier
    // -----------------------------------------------------------------------
    describe('pushpriceround carries admit_blocks to the verifier', function () {

        const MAP = { BTC: 799004, DOGE: 5000004, LTC: 2400004 };

        it('forwards the map verbatim, alongside every key it already forwarded', async function () {
            const receiveValidatedRound = sinon.stub().resolves({ accepted: true });
            const controller = await bootApi({ priceAggregator: { receiveValidatedRound } });

            const pairs = [{ pair: 'BTC/USD', price: '50000' }];
            await controller.pushpriceround({
                source_chain: 'BTC', round: 5, timestamp: 1700000000, btc_block_height: ADMIT_AT,
                pairs, sigs: [{ pubkey: 'ab', sig: 'cd' }], action_index: 42, block_index: 800000,
                push_generation: 3, admit_blocks: MAP
            });

            const [chainArg, payload] = receiveValidatedRound.firstCall.args;
            expect(chainArg).to.equal('BTC');
            // The whole key set, deep-equalled: the handler's parameter list IS the
            // interface, an unnamed key is dropped in silence, and a typo here is a
            // runtime refusal rather than a build error.
            expect(payload).to.deep.equal({
                round: 5, timestamp: 1700000000, btc_block_height: ADMIT_AT,
                pairs, sigs: [{ pubkey: 'ab', sig: 'cd' }], action_index: 42, block_index: 800000,
                push_generation: 3, admit_blocks: MAP
            });
        });

        it('leaves the map ABSENT when the pusher sent none, which is what a legacy round is', async function () {
            const receiveValidatedRound = sinon.stub().resolves({ accepted: true });
            const controller = await bootApi({ priceAggregator: { receiveValidatedRound } });
            await controller.pushpriceround({
                source_chain: 'BTC', round: 5, timestamp: 1700000000, btc_block_height: LEGACY_AT,
                pairs: [{ pair: 'BTC/USD', price: '50000' }], sigs: [], block_index: 1
            });
            const payload = receiveValidatedRound.firstCall.args[1];
            expect(payload.admit_blocks).to.equal(undefined);
            expect('admit_blocks' in payload).to.equal(true);   // named, and undefined, never omitted
        });

        // THE LOAD-BEARING CASE. The real armed aggregator behind the real RPC handler: the
        // producer's map is encoded into the signed canonical, travels as a push field,
        // and the verifier rebuilds the identical bytes from it. Strip the field from the
        // identical call and the same signatures no longer describe any round the verifier
        // will build, which is precisely what was happening to every round before this row.
        describe('end to end through the RPC surface, with the real aggregator', function () {

            const V     = validators(4);
            const PAIRS = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];
            let agg, hub;

            beforeEach(function () {
                hub = createMockHub({ network: NETWORK });
                hub.capabilitySnapshot = snapshotFor(V);
                hub.db.doQuery.callsFake(async () => []);
                agg = new armed.PriceAggregator(hub);
            });

            function signedRound(map) {
                const payload = agg._buildPriceV0Payload(5, 1700000000, PAIRS, ADMIT_AT, map);
                return {
                    source_chain: 'BTC', round: 5, timestamp: 1700000000,
                    btc_block_height: ADMIT_AT, block_index: 800000, action_index: 42,
                    pairs: PAIRS, admit_blocks: map,
                    sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
                };
            }

            it('accepts the round when the RPC carries the map the producer signed', async function () {
                const controller = await bootApi({ priceAggregator: agg });
                const result = await controller.pushpriceround(signedRound(MAP));
                expect(result.accepted).to.equal(true, 'reason: ' + result.reason);
            });

            it('REFUSES the identical round when the RPC drops the map', async function () {
                const controller = await bootApi({ priceAggregator: agg });
                const params = signedRound(MAP);
                delete params.admit_blocks;                  // the pre-row behaviour, exactly
                const result = await controller.pushpriceround(params);
                expect(result.accepted).to.equal(false);
                expect(result.reason).to.match(/refusing to build a legacy canonical/);
            });

            it('refuses a map edited in flight, so the carrier cannot be used to rewrite one', async function () {
                const controller = await bootApi({ priceAggregator: agg });
                const params = signedRound(MAP);
                params.admit_blocks = Object.assign({}, MAP, { BTC: MAP.BTC + 1 });
                const result = await controller.pushpriceround(params);
                expect(result.accepted).to.equal(false, 'an edited admission map verified');
            });

            it('round-trips the map: signed bytes -> wire field -> decode -> re-encode, identical', async function () {
                const canonical = agg._buildPriceV0Payload(5, 1700000000, PAIRS, ADMIT_AT, MAP);
                const field     = canonical.slice(canonical.lastIndexOf('|') + 1);
                const decoded   = armed.act.decodeAdmitBlocks(field);
                assert.deepStrictEqual(decoded, MAP, 'the wire field did not decode to the signed map');
                assert.strictEqual(armed.act.encodeAdmitBlocks(decoded), field,
                    're-encoding the decoded map did not reproduce the wire bytes');
                // And the legacy round below the activation is the pre-change bytes exactly:
                // the body is terminal, so there is no field and nothing to strip.
                const legacy = agg._buildPriceV0Payload(5, 1700000000, PAIRS, LEGACY_AT, undefined);
                expect(legacy.endsWith('}')).to.equal(true, legacy.slice(-40));
                expect(legacy).to.not.match(/BTC:/);
            });
        });
    });

    // -----------------------------------------------------------------------
    // 2. the batch rail (row 26): one map PER ROUND, era-keyed on each round's own
    //    anchor, refused in both directions, and never straddling the activation
    // -----------------------------------------------------------------------
    describe('the PRICE batch rail carries one admission map per round (row 26)', function () {

        const V     = validators(4);
        const MAP5  = { BTC: ADMIT_AT + 3, DOGE: 5000004 };
        const MAP6  = { BTC: ADMIT_AT + 4, LTC: 2400004 };

        // Two rounds at [anchor - 1, anchor]; maps[i] is the map on round i (undefined = none).
        function batchOn(anchor, maps, signWith) {
            let rounds = [
                { round: 5, timestamp: 1700000000, btc_block_height: anchor - 1,
                  pairs: [{ pair: 'BTC/USD', price: '50000' }] },
                { round: 6, timestamp: 1700000600, btc_block_height: anchor,
                  pairs: [{ pair: 'BTC/USD', price: '50001' }] }
            ];
            if (maps) rounds.forEach((r, i) => { if (maps[i] !== undefined) r.admit_blocks = maps[i]; });
            let b = {
                first_round: 5, last_round: 6, btc_block_height: anchor,
                block_index: 800000, block_time: 1700000000, action_index: 42,
                rounds: rounds,
                sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: 'ab'.repeat(64) }))
            };
            if (signWith) {
                const canon = signWith._buildPriceBatchPayload(5, 6, anchor, rounds.map(r => ({
                    round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height,
                    pairs: r.pairs, admitBlocks: r.admit_blocks })));
                b.sigs = V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(canon) }));
            }
            return b;
        }

        function aggOn(network, queries) {
            const hub = createMockHub({ network });
            hub.capabilitySnapshot = snapshotFor(V);
            hub.db.doQuery.callsFake(async (sql, params) => { if (queries) queries.push([sql, params]); return []; });
            return new armed.PriceAggregator(hub);
        }

        it('refuses a window that straddles the activation, before any signature is read', async function () {
            // round 5 at ADMIT_AT - 1 is legacy, round 6 at ADMIT_AT is era: a mixed set.
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(ADMIT_AT, [undefined, MAP6]));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.match(/straddles/);
            expect(result.stored).to.equal(0);
            expect(result.rejected).to.equal(2);
        });

        it('refuses an era batch whose rounds carry NO map, whole, storing nothing', async function () {
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(ADMIT_AT + 1));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.match(/admission map does not match the round's era/);
            expect(result.stored).to.equal(0);
            expect(result.rejected).to.equal(2);
        });

        it('refuses a LEGACY batch that was handed a map, the other direction', async function () {
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(LEGACY_AT, [MAP5, MAP6]));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.match(/admission map does not match the round's era/);
        });

        it('refuses a map the encoder cannot spell rather than throwing on it', async function () {
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC',
                batchOn(ADMIT_AT + 1, [{ BTC: '007' }, MAP6]));
            expect(result.reason).to.equal('invalid admit_blocks');
        });

        it('leaves a batch BELOW the activation on exactly its old road', async function () {
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(LEGACY_AT));
            // It still fails, on its garbage signatures, and that is the point: no
            // admission rule fired and the batch reached the verifier as before.
            expect(result.reason).to.not.match(/admission|straddles/);
        });

        it('is inert on a network with no activation, at a height far above the armed one', async function () {
            const result = await aggOn('mainnet').receiveValidatedBatch('BTC', batchOn(ADMIT_AT + 1000000));
            expect(result.reason).to.not.match(/admission|straddles/);
        });

        it('ACCEPTS an era batch whose rounds carry the maps the quorum signed, and stores each map in its round\'s columns', async function () {
            const queries = [];
            const agg     = aggOn(NETWORK, queries);
            const result  = await agg.receiveValidatedBatch('BTC', batchOn(ADMIT_AT + 1, [MAP5, MAP6], agg));
            expect(result.accepted).to.equal(true, 'reason: ' + result.reason);
            expect(result.stored).to.equal(2);
            const inserts = queries.filter(([sql]) => /INSERT INTO price_snapshots/.test(sql));
            expect(inserts.length).to.equal(2);
            for (const [sql, params] of inserts) {
                expect(sql).to.match(/admit_block_btc, admit_block_ltc, admit_block_doge\)/);
                expect(sql).to.match(/admit_block_doge = VALUES\(admit_block_doge\)/);
                // 16 params per pair row: the three admission columns ride LAST, after created_at.
                expect(params.length).to.equal(16);
            }
            // round 5: {BTC, DOGE}; round 6: {BTC, LTC}. NULL, never 0, for the absent chain.
            assert.deepStrictEqual(inserts[0][1].slice(13), [MAP5.BTC, null, MAP5.DOGE]);
            assert.deepStrictEqual(inserts[1][1].slice(13), [MAP6.BTC, MAP6.LTC, null]);
        });

        it('REFUSES the same batch when one round\'s map is edited in flight', async function () {
            const agg = aggOn(NETWORK);
            const b   = batchOn(ADMIT_AT + 1, [MAP5, MAP6], agg);
            b.rounds[1].admit_blocks = Object.assign({}, MAP6, { BTC: MAP6.BTC + 1 });
            const result = await agg.receiveValidatedBatch('BTC', b);
            expect(result.accepted).to.equal(false, 'an edited admission map verified');
        });

        it('carries the map as the LAST key of each round, and none below the activation', function () {
            const agg = aggOn(NETWORK);
            const era = batchOn(ADMIT_AT + 1, [MAP5, MAP6]);
            const bytes = agg._buildPriceBatchPayload(5, 6, ADMIT_AT + 1, era.rounds.map(r => ({
                round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height,
                pairs: r.pairs, admitBlocks: r.admit_blocks })));
            const body = JSON.parse(bytes.slice(bytes.indexOf('{')));
            assert.deepStrictEqual(Object.keys(body.rounds[0]),
                ['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks']);
            assert.strictEqual(body.rounds[0].admit_blocks, 'BTC:' + MAP5.BTC + ',DOGE:5000004');
            assert.strictEqual(body.rounds[1].admit_blocks, 'BTC:' + MAP6.BTC + ',LTC:2400004');
            assert.deepStrictEqual(armed.act.decodeAdmitBlocks(body.rounds[0].admit_blocks), MAP5);

            const legacy = batchOn(LEGACY_AT);
            const lbytes = agg._buildPriceBatchPayload(5, 6, LEGACY_AT, legacy.rounds.map(r => ({
                round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height, pairs: r.pairs })));
            expect(lbytes).to.not.match(/admit_blocks/);
            assert.deepStrictEqual(Object.keys(JSON.parse(lbytes.slice(lbytes.indexOf('{'))).rounds[0]),
                ['round', 'timestamp', 'btc_block_height', 'pairs']);
        });
    });

    // -----------------------------------------------------------------------
    // 2b. the producer side of the batch wire (row 26): the on-chain slot, the split at
    //     the activation, and the signer rebuilding each round's map from its columns
    // -----------------------------------------------------------------------
    describe('the batch producer carries each round\'s map onto the on-chain wire', function () {
        const os   = require('os');
        const path = require('path');
        const fs   = require('fs');
        const MAP5 = { DOGE: 5000004, BTC: ADMIT_AT + 3 };
        const MAP6 = { LTC: 2400004, BTC: ADMIT_AT + 4 };
        let dir, pub, signer;

        function rounds(base, maps) {
            return [0, 1].map(i => {
                let r = { round: 5 + i, timestamp: 1700000000 + i * 600, btcBlockHeight: base + i,
                          pairs: [{ coinPair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }] };
                if (maps && maps[i] !== undefined) r.admitBlocks = maps[i];
                return r;
            });
        }
        const SIGS = [{ pubkey: 'ab'.repeat(32), sig: 'cd'.repeat(64) }];

        before(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'row26-pub-'));
            const hub = {
                p2pConfig: { PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                network: NETWORK, db: { doQuery: sinon.stub().resolves([]) },
                getIdentity: () => null, getPeerManager: () => ({}), capabilitySnapshot: null,
                oracleConsensus: null, oracleBatchSigner: null
            };
            pub    = new armed.OraclePublisher(hub);
            signer = new armed.OracleBatchSigner(hub);
        });
        after(function () {
            try { if (pub && typeof pub.stop === 'function') pub.stop(); } catch (e) { /* teardown only */ }
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* teardown only */ }
        });

        it('emits ADMIT_BLOCKS after each era round\'s pairs, spelled by the one encoder, and nothing below the activation', function () {
            const body = pub.buildPriceBatchBody(5, 6, ADMIT_AT + 1, rounds(ADMIT_AT, [MAP5, MAP6]), SIGS).split('|');
            // FIRST|LAST|ANCHOR|COUNT, then per round ROUND|TS|ANCHOR|PAIR_COUNT|pair|price x2|ADMIT_BLOCKS
            expect(body.slice(0, 4)).to.deep.equal(['5', '6', String(ADMIT_AT + 1), '2']);
            expect(body[4 + 8]).to.equal(armed.act.encodeAdmitBlocks(MAP5));
            expect(body[4 + 9 + 8]).to.equal(armed.act.encodeAdmitBlocks(MAP6));
            expect(body[4 + 18]).to.equal('1');                       // SIG_COUNT sits right after the second slot
            const legacy = pub.buildPriceBatchBody(5, 6, LEGACY_AT, rounds(LEGACY_AT - 1), SIGS).split('|');
            expect(legacy[4 + 8]).to.equal('6');                      // the next ROUND, no slot in between
            expect(legacy.join('|')).to.not.match(/BTC:/);
        });

        it('refuses to emit a wire for an era round with no map, so nothing its verifiers would refuse is ever spent on', function () {
            expect(() => pub.buildPriceBatchBody(5, 6, ADMIT_AT + 1, rounds(ADMIT_AT), SIGS))
                .to.throw(/has no admit_blocks; refusing to build a legacy canonical/);
        });

        it('splits a window at the activation, so no batch straddles it', function () {
            expect(pub._flagDayKey(LEGACY_AT)).to.not.equal(pub._flagDayKey(ADMIT_AT));
            const segments = pub._splitByFlagDay(rounds(LEGACY_AT, [undefined, MAP6]));
            expect(segments.map(seg => seg.map(r => r.round))).to.deep.equal([[5], [6]]);
            expect(signer._straddlesArmedOracleFlagDay(LEGACY_AT, ADMIT_AT)).to.equal(true);
            expect(signer._straddlesArmedOracleFlagDay(ADMIT_AT, ADMIT_AT + 5)).to.equal(false);
        });

        it('the signer rebuilds each round\'s map from its stored columns, and refuses a round whose pairs disagree', async function () {
            const row = (round, pair, admit) => Object.assign({ round_number: round, coin_pair: pair, price: '1',
                reference_block: ADMIT_AT, block_timestamp: 1700000000, proof_head: '[' }, admit);
            signer.db = { doQuery: sinon.stub().resolves([
                row(5, 'BTC/USD', { admit_block_btc: MAP5.BTC, admit_block_ltc: null, admit_block_doge: MAP5.DOGE }),
                row(5, 'LTC/USD', { admit_block_btc: MAP5.BTC, admit_block_ltc: null, admit_block_doge: MAP5.DOGE }),
                row(6, 'BTC/USD', { admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null })
            ]) };
            const derived = await signer._deriveWindow(5, 6);
            expect(derived.map(r => r.admitBlocks)).to.deep.equal([{ BTC: MAP5.BTC, DOGE: MAP5.DOGE }, undefined]);
            expect(signer.db.doQuery.firstCall.args[0]).to.match(/admit_block_btc, admit_block_ltc, admit_block_doge/);

            signer.db = { doQuery: sinon.stub().resolves([
                row(5, 'BTC/USD', { admit_block_btc: MAP5.BTC, admit_block_ltc: null, admit_block_doge: MAP5.DOGE }),
                row(5, 'LTC/USD', { admit_block_btc: MAP5.BTC + 1, admit_block_ltc: null, admit_block_doge: MAP5.DOGE })
            ]) };
            let err = null;
            try { await signer._deriveWindow(5, 5); } catch (e) { err = e; }
            expect(err && err.message).to.match(/inconsistent anchor\/timestamp\/admission map across round 5/);
        });

        it('the buffer entry carries the finalized round\'s map, and only when the event has one', function () {
            const base = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: ADMIT_AT, prices: [{ coinPair: 'BTC/USD', price: '1' }] };
            expect(pub._bufferEntryFromEvent(Object.assign({ admitBlocks: MAP5 }, base)).admitBlocks).to.deep.equal(MAP5);
            expect(pub._bufferEntryFromEvent(Object.assign({ admitBlocks: null }, base))).to.not.have.property('admitBlocks');
            expect(pub._bufferEntryFromEvent(base)).to.not.have.property('admitBlocks');
        });
    });

    // -----------------------------------------------------------------------
    // 2c. row 18: the producer pins the round's map, the PROPOSE carries it, the follower
    //     bounds it against its OWN tips and co-signs the LEADER's map or nothing
    // -----------------------------------------------------------------------
    describe('the oracle round pins and carries its admission map (row 18)', function () {
        const { VALIDATORS_3, buildSubmissions, makeCapabilitySnapshotStub } = require('../helpers/fixtures');
        const ROUND = 7;
        // The leader's map: tip + the price margin (1) on every federation chain.
        const TIPS  = { BTC: ADMIT_AT, LTC: 2400000, DOGE: 5000000 };
        const MAP   = { BTC: ADMIT_AT + 1, LTC: 2400001, DOGE: 5000001 };
        let hub, pm, oc, oracleRound, leader, queries;

        function build(network, tips) {
            queries = [];
            hub = createMockHub({ network });
            pm  = hub._peerManager;
            pm.validatorPubkeys = new Set();
            hub.db.doQuery.callsFake(async (sql, params) => { queries.push([sql, params]); return []; });
            hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
            // The follower's pre-existing BTC-tip deviation gate reads the committed tip; pin it
            // at the anchor so only the admission bound under test decides the verdict.
            hub._resolveBtcLatestBlock = sinon.stub().resolves(ADMIT_AT);
            // The hub's admission seam, as XChainHub exposes it: this hub's own tips, and
            // the stamp built from them (tip + margin on every chain in the read set).
            hub._resolveAdmissionTips = sinon.stub().callsFake(async (chains) => {
                let out = {}; for (let c of chains) out[c] = (tips && tips[c] != null) ? tips[c] : null; return out;
            });
            hub.resolveAdmitBlocks = sinon.stub().callsFake(async (table, readSet) => {
                if (!tips) return null;
                let out = {}; for (let c of readSet) { if (tips[c] == null) return null; out[c] = tips[c] + 1; } return out;
            });
            oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
            oc = new armed.OracleConsensus(hub, oracleRound);
            oc.setValidatorSet(VALIDATORS_3);
            oc.allowUnverifiedPairs = true;
            leader = oc._getLeader(ROUND);
        }
        function asLeader() { pm.validatorAddr = leader.addr; }
        function asFollower() { pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr; }
        const PRICES = [{ coinPair: 'BTC/USD', price: '100000' }];
        function submissionsFrom(addr) { return buildSubmissions([{ sender: addr, prices: PRICES }]); }
        function envelope(anchor, admitBlocks) {
            let prices = PRICES;
            let data = { round: ROUND, prices, digest: oc._digest(ROUND, prices), btcBlockHeight: anchor, btcBlockTime: 1700000000 };
            if (admitBlocks !== undefined) data.admitBlocks = admitBlocks;
            return { sender: leader.addr, sig_pubkey: leader.pubkey, data };
        }
        const proposeCalls = () => pm.broadcast.getCalls().filter(c => /PROPOSE/i.test(String(c.args[0]))).map(c => c.args[1]);

        afterEach(function () { if (oc) oc.stop && oc.stop(); sinon.restore(); });

        it('the LEADER pins the map from its own tips in the era, signs over it and carries it in the PROPOSE', async function () {
            build(NETWORK, TIPS); asLeader();
            await oc._proposeRound(ROUND, submissionsFrom(leader.addr), false, ADMIT_AT, 1700000000, null, 1, false, null);
            const pending = oc.pendingRounds.get(ROUND);
            expect(pending, 'no pending round').to.exist;
            expect(pending.admitBlocks).to.deep.equal(MAP);
            const sent = proposeCalls();
            expect(sent.length).to.equal(1);
            expect(sent[0].admitBlocks).to.deep.equal(MAP);
            // The leader's own signature is over the canonical WITH the map.
            const canon = oc._buildPriceV0Payload(ROUND, 1700000000, PRICES, ADMIT_AT, MAP);
            expect(canon).to.match(/\|BTC:799001,DOGE:5000001,LTC:2400001/);
            expect(hub.resolveAdmitBlocks.firstCall.args[0]).to.equal('price_snapshots');
            expect(hub.resolveAdmitBlocks.firstCall.args[1]).to.deep.equal(['BTC', 'LTC', 'DOGE']);
        });

        it('the LEADER proposes nothing when a tip is missing, never a guessed height', async function () {
            build(NETWORK, { BTC: ADMIT_AT, LTC: 2400000, DOGE: null }); asLeader();
            await oc._proposeRound(ROUND, submissionsFrom(leader.addr), false, ADMIT_AT, 1700000000, null, 1, false, null);
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            expect(proposeCalls().length).to.equal(0);
        });

        it('below the activation the PROPOSE carries no map and nothing awaits: byte-identical behaviour', async function () {
            build(NETWORK, TIPS); asLeader();
            const p = oc._proposeRound(ROUND, submissionsFrom(leader.addr), false, LEGACY_AT, 1700000000, null, 1, false, null);
            // Synchronous to completion below the activation: the round is pending before the await.
            expect(oc.pendingRounds.has(ROUND)).to.equal(true);
            await p;
            expect(proposeCalls()[0]).to.not.have.property('admitBlocks');
            expect(oc.pendingRounds.get(ROUND).admitBlocks).to.equal(null);
            expect(hub.resolveAdmitBlocks.called).to.equal(false);
        });

        it('the FOLLOWER co-signs the LEADER\'s map, pins it, and never one of its own', async function () {
            // Follower tips differ from the leader's; the leader's map is still inside the window.
            build(NETWORK, { BTC: ADMIT_AT - 2, LTC: 2399990, DOGE: 4999980 }); asFollower();
            oracleRound.getSubmissions.returns(submissionsFrom(pm.validatorAddr));
            await oc._handlePropose(envelope(ADMIT_AT, MAP));
            const pending = oc.pendingRounds.get(ROUND);
            expect(pending, 'follower did not open the round').to.exist;
            expect(pending.admitBlocks).to.deep.equal(MAP);
            const prepare = pm.broadcast.getCalls().find(c => /PREPARE/i.test(String(c.args[0])));
            expect(prepare, 'no PREPARE').to.exist;
            // The follower's signature verifies over the LEADER's map, not its own tips.
            const canon = oc._buildPriceV0Payload(ROUND, 1700000000, PRICES, ADMIT_AT, MAP);
            const signed = hub.getIdentity().sign.getCalls().map(c => c.args[0]);
            expect(signed).to.include(canon, 'the follower did not sign the canonical carrying the leader\'s map');
            expect(signed.every(b => /\|BTC:799001,DOGE:5000001,LTC:2400001/.test(b))).to.equal(true, 'a signature over bytes without the leader\'s map');
            expect(hub.resolveAdmitBlocks.called).to.equal(false, 'the follower must not stamp its own map');
        });

        it('the FOLLOWER refuses an era PROPOSE with no map, a legacy PROPOSE with one, and a map outside its window', async function () {
            build(NETWORK, TIPS); asFollower();
            oracleRound.getSubmissions.returns(submissionsFrom(pm.validatorAddr));
            await oc._handlePropose(envelope(ADMIT_AT));                       // era, no map
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            await oc._handlePropose(envelope(LEGACY_AT, MAP));                 // legacy, a map
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            await oc._handlePropose(envelope(ADMIT_AT, Object.assign({}, MAP, { BTC: ADMIT_AT + 40 })));  // BTC window is 6
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            await oc._handlePropose(envelope(ADMIT_AT, { BTC: ADMIT_AT + 1 }));   // omits LTC and DOGE, which read the row
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            await oc._handlePropose(envelope(ADMIT_AT, { BTC: '0799001', LTC: 2400001, DOGE: 5000001 }));   // unspellable
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            expect(pm.broadcast.called).to.equal(false);
        });

        it('the FOLLOWER refuses to co-sign when it cannot resolve its own tips (fail-closed, never adopts the leader\'s)', async function () {
            build(NETWORK, TIPS); asFollower();
            delete hub._resolveAdmissionTips;
            oracleRound.getSubmissions.returns(submissionsFrom(pm.validatorAddr));
            await oc._handlePropose(envelope(ADMIT_AT, MAP));
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
        });

        it('a second PROPOSE for a pending round with a DIFFERENT map is refused', async function () {
            build(NETWORK, { BTC: ADMIT_AT - 2, LTC: 2399990, DOGE: 4999980 }); asFollower();
            oracleRound.getSubmissions.returns(submissionsFrom(pm.validatorAddr));
            await oc._handlePropose(envelope(ADMIT_AT, MAP));
            expect(oc.pendingRounds.get(ROUND).prepares.size).to.be.greaterThan(0);
            const before = pm.broadcast.callCount;
            await oc._handlePropose(envelope(ADMIT_AT, Object.assign({}, MAP, { BTC: ADMIT_AT + 2 })));
            expect(pm.broadcast.callCount).to.equal(before);
            expect(oc.pendingRounds.get(ROUND).admitBlocks).to.deep.equal(MAP);
        });

        it('_storeSnapshot writes the map into the admission columns, NULL for a legacy round', async function () {
            build(NETWORK, TIPS);
            oc._persistCapabilitySnapshot = sinon.stub().resolves();
            await oc._storeSnapshot(ROUND, PRICES, 3, '[]', ADMIT_AT, 1700000000, { DOGE: 5000001, BTC: ADMIT_AT + 1 });
            let [sql, params] = queries.find(([q]) => /INSERT INTO price_snapshots/.test(q));
            expect(sql).to.match(/admit_block_btc, admit_block_ltc, admit_block_doge\)/);
            expect(params.slice(-3)).to.deep.equal([ADMIT_AT + 1, null, 5000001]);
            queries.length = 0;
            await oc._storeSnapshot(ROUND, PRICES, 3, '[]', LEGACY_AT, 1700000000, null);
            [sql, params] = queries.find(([q]) => /INSERT INTO price_snapshots/.test(q));
            expect(params.slice(-3)).to.deep.equal([null, null, null]);
        });
    });

    // -----------------------------------------------------------------------
    // 3. row 14: oracle_prices.admit_block from the hub's own ingest
    // -----------------------------------------------------------------------
    describe('oracle_prices.admit_block, stamped from the hub\'s own ingest (row 14)', function () {

        // INSERT column order: source_address, source_chain, coin, tick, fiat, value, fee,
        // memo, block_time, effective_at, action_index, push_generation, admit_block.
        const ADMIT_BLOCK = 12;

        const V1 = {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
            value: '1.23', block_time: 1700000000, action_index: 7
        };

        function aggWithTip(network, tip) {
            const hub = createMockHub({ network });
            if (tip !== 'no-resolver')
                hub._resolveAdmissionTip = sinon.stub().resolves(tip);
            const agg = new armed.PriceAggregator(hub);
            let insertArgs = null;
            hub.db.doQuery.callsFake(async (sql, params) => {
                if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
                return [];
            });
            return { agg, hub, insert: () => insertArgs };
        }

        it('stamps tip + the oracle margin of 1 block, on the PUBLISHING chain', async function () {
            const t = aggWithTip(NETWORK, 799010);
            const events = [];
            t.agg.on('row:inserted', e => events.push(e));

            const result = await t.agg.receiveOraclePrice('LTC', V1);
            expect(result).to.deep.equal({ accepted: true });
            // The tip was read for LTC, the row's own source_chain, not for BTC.
            expect(t.hub._resolveAdmissionTip.calledOnceWithExactly('LTC')).to.equal(true);
            expect(t.insert()[ADMIT_BLOCK]).to.equal(799011);
            expect(events[0].row.admit_block).to.equal(799011,
                'the broadcast row must carry the same height the INSERT stored');
        });

        // A TIP OF ZERO IS NOT A MISSING TIP, and this is the one case that separates them,
        // so it needs the gate armed at height 0 rather than at 799000. The trap the whole
        // rail is written against: Number(null) and Number('') are both 0, so a coercing
        // guard reads an ABSENT tip as height 0 and stamps 0 + margin, a row admissible at a
        // block every live chain passed years ago. Driven both ways under one arming.
        describe('armed at height 0, where a tip of 0 is inside the era', function () {

            let zeroArmed = null;
            before(function () { zeroArmed = armTwins(0); });
            after(function () { if (zeroArmed) zeroArmed.restore(); zeroArmed = null; });

            function aggAt(tip) {
                const hub = createMockHub({ network: NETWORK });
                hub._resolveAdmissionTip = sinon.stub().resolves(tip);
                const agg = new zeroArmed.PriceAggregator(hub);
                let insertArgs = null;
                hub.db.doQuery.callsFake(async (sql, params) => {
                    if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
                    return [];
                });
                return { agg, insert: () => insertArgs };
            }

            it('stamps a tip of 0 as height 1', async function () {
                const t = aggAt(0);
                await t.agg.receiveOraclePrice('LTC', V1);
                expect(t.insert()[ADMIT_BLOCK]).to.equal(1);
            });

            it('stamps NOTHING for an absent tip at the same arming', async function () {
                const t = aggAt(null);
                await t.agg.receiveOraclePrice('LTC', V1);
                expect(t.insert()[ADMIT_BLOCK]).to.equal(null,
                    'an absent tip was coerced to height 0 and stamped');
            });
        });

        it('leaves NULL, never 0, when the hub has no fresh tip for the chain', async function () {
            const t = aggWithTip(NETWORK, null);
            const result = await t.agg.receiveOraclePrice('LTC', V1);
            expect(result).to.deep.equal({ accepted: true });   // the row still lands
            expect(t.insert()[ADMIT_BLOCK]).to.equal(null);
        });

        it('leaves NULL when the tip read throws', async function () {
            const t = aggWithTip(NETWORK, null);
            t.hub._resolveAdmissionTip = sinon.stub().rejects(new Error('indexer down'));
            await t.agg.receiveOraclePrice('LTC', V1);
            expect(t.insert()[ADMIT_BLOCK]).to.equal(null);
        });

        it('leaves NULL when the hub carries no admission resolver at all', async function () {
            const t = aggWithTip(NETWORK, 'no-resolver');
            await t.agg.receiveOraclePrice('LTC', V1);
            expect(t.insert()[ADMIT_BLOCK]).to.equal(null);
        });

        it('leaves NULL BELOW the activation even with a perfectly fresh tip', async function () {
            const t = aggWithTip(NETWORK, LEGACY_AT);
            await t.agg.receiveOraclePrice('LTC', V1);
            expect(t.insert()[ADMIT_BLOCK]).to.equal(null,
                'a row below the activation must be byte-identical to today\'s row');
        });

        it('leaves NULL on a network whose activation is inert, at any height', async function () {
            const t = aggWithTip('mainnet', ADMIT_AT + 1000000);
            await t.agg.receiveOraclePrice('LTC', V1);
            expect(t.insert()[ADMIT_BLOCK]).to.equal(null);
        });

        it('leaves NULL when the row names no source chain to verify a height against', async function () {
            const t = aggWithTip(NETWORK, 799010);
            await t.agg.receiveOraclePrice('', V1);
            expect(t.insert()[ADMIT_BLOCK]).to.equal(null);
            expect(t.hub._resolveAdmissionTip.called).to.equal(false);
        });

        it('guards the stamp with the same generation rule as every other column', async function () {
            const t = aggWithTip(NETWORK, 799010);
            await t.agg.receiveOraclePrice('LTC', V1);
            const sql = t.hub.db.doQuery.getCalls()
                .find(c => /^INSERT INTO oracle_prices/.test(c.args[0])).args[0];
            expect(sql).to.match(
                /admit_block\s+= IF\(VALUES\(push_generation\) > push_generation, VALUES\(admit_block\), admit_block\)/);
            // Assigned BEFORE push_generation, or its own IF would read the NEW generation
            // and every stale replay would win.
            expect(sql.indexOf('admit_block    = IF'))
                .to.be.below(sql.indexOf('push_generation = GREATEST'));
        });
    });
});
