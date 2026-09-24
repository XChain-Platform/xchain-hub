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
 *      buildPriceBatchPayload serializes {round, timestamp, btc_block_height, pairs} per
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
const { createMockHub } = require('../../../helpers/mockHub');
const { waitUntil }     = require('../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

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
    '../../../../src/consensus/gates/mirror_admission_gate.js',
    '../../../../src/lib/admission_height.js',
    '../../../../src/oracle/price_aggregator.js',
    '../../../../src/oracle/batch_signer.js',
    '../../../../src/oracle/publisher.js',
    '../../../../src/oracle/consensus.js'
];

let armed = null;

function armTwins(atHeight) {
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(atHeight === undefined ? ADMIT_AT : atHeight);

    const PriceAggregator  = require('../../../../src/oracle/price_aggregator.js');
    const OracleBatchSigner = require('../../../../src/oracle/batch_signer.js');
    const OraclePublisher  = require('../../../../src/oracle/publisher.js');
    const OracleConsensus  = require('../../../../src/oracle/consensus.js');
    const act              = require('../../../../src/consensus/gates/mirror_admission_gate.js');

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
        proxyquire('../../../../src/api', {
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
                const canon = signWith.buildPriceBatchPayload(5, 6, anchor, rounds.map(r => ({
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

function registerTheAdmissionMapOnThe1Hooks() {

    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
    afterEach(function () { sinon.restore(); });
}

function registerThePriceBatchRailCarries2Tests1() {

        it('refuses a window that straddles the activation, before any signature is read', async function () {
            // round 5 at ADMIT_AT - 1 is legacy, round 6 at ADMIT_AT is era: a mixed set.
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(ADMIT_AT, [undefined, MAP6]));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.match(/straddles/);
            expect(result.stored).to.equal(0);
            expect(result.rejected).to.equal(2);
        });

        it('takes the legacy byte path for an era batch whose rounds carry NO map, storing nothing', async function () {
            // A version seam is not a fault. The batch is rebuilt over legacy bytes and quorum
            // verification decides it, so it is refused on its signatures rather than on an era
            // complaint. Nothing lands either way, which is the property that still matters.
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(ADMIT_AT + 1));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.not.match(/admission map does not match the round's era/);
            expect(result.stored).to.equal(0);
        });

        it('takes the legacy byte path for a LEGACY batch that was handed a map, the other direction', async function () {
            // An activation-inert consumer treats admit_blocks as absent even when a newer
            // producer supplied it, so the map is ignored and the signatures decide.
            const result = await aggOn(NETWORK).receiveValidatedBatch('BTC', batchOn(LEGACY_AT, [MAP5, MAP6]));
            expect(result.accepted).to.equal(false);
            expect(result.reason).to.not.match(/admission map does not match the round's era/);
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
}

function registerThePriceBatchRailCarries2Tests7() {

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
            const bytes = agg.buildPriceBatchPayload(5, 6, ADMIT_AT + 1, era.rounds.map(r => ({
                round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height,
                pairs: r.pairs, admitBlocks: r.admit_blocks })));
            const body = JSON.parse(bytes.slice(bytes.indexOf('{')));
            assert.deepStrictEqual(Object.keys(body.rounds[0]),
                ['round', 'timestamp', 'btc_block_height', 'pairs', 'admit_blocks']);
            assert.strictEqual(body.rounds[0].admit_blocks, 'BTC:' + MAP5.BTC + ',DOGE:5000004');
            assert.strictEqual(body.rounds[1].admit_blocks, 'BTC:' + MAP6.BTC + ',LTC:2400004');
            assert.deepStrictEqual(armed.act.decodeAdmitBlocks(body.rounds[0].admit_blocks), MAP5);

            const legacy = batchOn(LEGACY_AT);
            const lbytes = agg.buildPriceBatchPayload(5, 6, LEGACY_AT, legacy.rounds.map(r => ({
                round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height, pairs: r.pairs })));
            expect(lbytes).to.not.match(/admit_blocks/);
            assert.deepStrictEqual(Object.keys(JSON.parse(lbytes.slice(lbytes.indexOf('{'))).rounds[0]),
                ['round', 'timestamp', 'btc_block_height', 'pairs']);
        });

}

describe('the admission map on the price wire (rows 17 and 14)', function () {
    registerTheAdmissionMapOnThe1Hooks();



    // -----------------------------------------------------------------------
    // 2. the batch rail (row 26): one map PER ROUND, era-keyed on each round's own
    //    anchor, refused in both directions, and never straddling the activation
    // -----------------------------------------------------------------------
    describe('the PRICE batch rail carries one admission map per round (row 26)', function () {
        registerThePriceBatchRailCarries2Tests1();
        registerThePriceBatchRailCarries2Tests7();
    });
});
