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
    '../../../../src/mirror_admission_activation.js',
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
    const act              = require('../../../../src/mirror_admission_activation.js');

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



        const MAP = { BTC: 799004, DOGE: 5000004, LTC: 2400004 };



            const V     = validators(4);

            const PAIRS = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];

            let agg, hub;


            function signedRound(map) {
                const payload = agg._buildPriceV0Payload(5, 1700000000, PAIRS, ADMIT_AT, map);
                return {
                    source_chain: 'BTC', round: 5, timestamp: 1700000000,
                    btc_block_height: ADMIT_AT, block_index: 800000, action_index: 42,
                    pairs: PAIRS, admit_blocks: map,
                    sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
                };
            }

function registerTheAdmissionMapOnThe1Hooks() {

    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
    afterEach(function () { sinon.restore(); });
}

function registerEndToEndThroughThe3Hooks() {

            beforeEach(function () {
                hub = createMockHub({ network: NETWORK });
                hub.capabilitySnapshot = snapshotFor(V);
                hub.db.doQuery.callsFake(async () => []);
                agg = new armed.PriceAggregator(hub);
            });
}

function registerTheAdmissionMapOnThe1Tests1() {

    it('is ARMED for this suite, so neither era case is vacuous', function () {
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT)).to.equal(true);
        expect(armed.act.isMirrorAdmissionProducerActive('BTC', NETWORK, LEGACY_AT)).to.equal(false);
        expect(armed.act.isMirrorAdmissionProducerActive('LTC', NETWORK, ADMIT_AT)).to.equal(true);
        expect(armed.act.isMirrorAdmissionProducerActive('LTC', 'mainnet', ADMIT_AT)).to.equal(false);
    });
}

function registerPushpriceroundCarriesAdmitBlocksTo2Tests2() {

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
}

function registerEndToEndThroughThe3Tests4() {

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

}

describe('the admission map on the price wire (rows 17 and 14)', function () {
    registerTheAdmissionMapOnThe1Hooks();
    registerTheAdmissionMapOnThe1Tests1();



    // -----------------------------------------------------------------------
    // 1. pushpriceround: the round rail's carrier
    // -----------------------------------------------------------------------
    describe('pushpriceround carries admit_blocks to the verifier', function () {
        registerPushpriceroundCarriesAdmitBlocksTo2Tests2();



        // THE LOAD-BEARING CASE. The real armed aggregator behind the real RPC handler: the
        // producer's map is encoded into the signed canonical, travels as a push field,
        // and the verifier rebuilds the identical bytes from it. Strip the field from the
        // identical call and the same signatures no longer describe any round the verifier
        // will build, which is precisely what was happening to every round before this row.
        describe('end to end through the RPC surface, with the real aggregator', function () {
            registerEndToEndThroughThe3Hooks();
            registerEndToEndThroughThe3Tests4();
        });
    });
});
