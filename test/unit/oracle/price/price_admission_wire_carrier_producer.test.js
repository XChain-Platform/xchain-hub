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

function registerTheAdmissionMapOnThe1Hooks() {

    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
    afterEach(function () { sinon.restore(); });
}

function registerTheBatchProducerCarriesEach2Hooks() {

        before(function () {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'row26-pub-'));
            const hub = {
                p2pConfig: { PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                network: NETWORK, db: { ...DB_METHODS, doQuery: sinon.stub().resolves([]) },
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
}

function registerTheBatchProducerCarriesEach2Tests1() {

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
            expect(pub.flagDayKey(LEGACY_AT)).to.not.equal(pub.flagDayKey(ADMIT_AT));
            const segments = pub.splitByFlagDay(rounds(LEGACY_AT, [undefined, MAP6]));
            expect(segments.map(seg => seg.map(r => r.round))).to.deep.equal([[5], [6]]);
            expect(signer.straddlesArmedOracleFlagDay(LEGACY_AT, ADMIT_AT)).to.equal(true);
            expect(signer.straddlesArmedOracleFlagDay(ADMIT_AT, ADMIT_AT + 5)).to.equal(false);
        });

        it('the signer rebuilds each round\'s map from its stored columns, and refuses a round whose pairs disagree', async function () {
            const row = (round, pair, admit) => Object.assign({ round_number: round, coin_pair: pair, price: '1',
                reference_block: ADMIT_AT, block_timestamp: 1700000000, proof_head: '[' }, admit);
            signer.db = { ...DB_METHODS, doQuery: sinon.stub().resolves([
                row(5, 'BTC/USD', { admit_block_btc: MAP5.BTC, admit_block_ltc: null, admit_block_doge: MAP5.DOGE }),
                row(5, 'LTC/USD', { admit_block_btc: MAP5.BTC, admit_block_ltc: null, admit_block_doge: MAP5.DOGE }),
                row(6, 'BTC/USD', { admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null })
            ]) };
            const derived = await signer.deriveWindow(5, 6);
            expect(derived.map(r => r.admitBlocks)).to.deep.equal([{ BTC: MAP5.BTC, DOGE: MAP5.DOGE }, undefined]);
            expect(signer.db.doQuery.firstCall.args[0]).to.match(/admit_block_btc, admit_block_ltc, admit_block_doge/);

            signer.db = { ...DB_METHODS, doQuery: sinon.stub().resolves([
                row(5, 'BTC/USD', { admit_block_btc: MAP5.BTC, admit_block_ltc: null, admit_block_doge: MAP5.DOGE }),
                row(5, 'LTC/USD', { admit_block_btc: MAP5.BTC + 1, admit_block_ltc: null, admit_block_doge: MAP5.DOGE })
            ]) };
            let err = null;
            try { await signer.deriveWindow(5, 5); } catch (e) { err = e; }
            expect(err && err.message).to.match(/inconsistent anchor\/timestamp\/admission map across round 5/);
        });

        it('the buffer entry carries the finalized round\'s map, and only when the event has one', function () {
            const base = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: ADMIT_AT, prices: [{ coinPair: 'BTC/USD', price: '1' }] };
            expect(pub.bufferEntryFromEvent(Object.assign({ admitBlocks: MAP5 }, base)).admitBlocks).to.deep.equal(MAP5);
            expect(pub.bufferEntryFromEvent(Object.assign({ admitBlocks: null }, base))).to.not.have.property('admitBlocks');
            expect(pub.bufferEntryFromEvent(base)).to.not.have.property('admitBlocks');
        });

}

describe('the admission map on the price wire (rows 17 and 14)', function () {
    registerTheAdmissionMapOnThe1Hooks();



    // -----------------------------------------------------------------------
    // 2b. the producer side of the batch wire (row 26): the on-chain slot, the split at
    //     the activation, and the signer rebuilding each round's map from its columns
    // -----------------------------------------------------------------------
    describe('the batch producer carries each round\'s map onto the on-chain wire', function () {
        registerTheBatchProducerCarriesEach2Hooks();
        registerTheBatchProducerCarriesEach2Tests1();
    });
});
