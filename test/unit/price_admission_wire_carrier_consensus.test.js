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
const { DB_METHODS } = require('../helpers/mockHub.js');

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
    '../../src/oracle/price_aggregator.js',
    '../../src/oracle/batch_signer.js',
    '../../src/oracle/publisher.js',
    '../../src/oracle/consensus.js'
];

let armed = null;

function armTwins(atHeight) {
    const paths    = ARMED_MODULES.map(m => require.resolve(m));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(atHeight === undefined ? ADMIT_AT : atHeight);

    const PriceAggregator  = require('../../src/oracle/price_aggregator.js');
    const OracleBatchSigner = require('../../src/oracle/batch_signer.js');
    const OraclePublisher  = require('../../src/oracle/publisher.js');
    const OracleConsensus  = require('../../src/oracle/consensus.js');
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
            hub.resolveAdmissionTips = sinon.stub().callsFake(async (chains) => {
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

function registerTheAdmissionMapOnThe1Hooks() {

    before(function () { armed = armTwins(); });
    after(function () { if (armed) armed.restore(); armed = null; });
    afterEach(function () { sinon.restore(); });
}

function registerTheOracleRoundPinsAnd2Hooks() {

        afterEach(function () { if (oc) oc.stop && oc.stop(); sinon.restore(); });
}

function registerTheOracleRoundPinsAnd2Tests1() {

        it('the LEADER pins the map from its own tips in the era, signs over it and carries it in the PROPOSE', async function () {
            build(NETWORK, TIPS); asLeader();
            await oc.proposeRound(ROUND, submissionsFrom(leader.addr), false, ADMIT_AT, 1700000000, null, 1, false, null);
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
            await oc.proposeRound(ROUND, submissionsFrom(leader.addr), false, ADMIT_AT, 1700000000, null, 1, false, null);
            expect(oc.pendingRounds.has(ROUND)).to.equal(false);
            expect(proposeCalls().length).to.equal(0);
        });

        it('below the activation the PROPOSE carries no map and nothing awaits: byte-identical behaviour', async function () {
            build(NETWORK, TIPS); asLeader();
            const p = oc.proposeRound(ROUND, submissionsFrom(leader.addr), false, LEGACY_AT, 1700000000, null, 1, false, null);
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
}

function registerTheOracleRoundPinsAnd2Tests5() {

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
            delete hub.resolveAdmissionTips;
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

}

describe('the admission map on the price wire (rows 17 and 14)', function () {
    registerTheAdmissionMapOnThe1Hooks();



    // -----------------------------------------------------------------------
    // 2c. row 18: the producer pins the round's map, the PROPOSE carries it, the follower
    //     bounds it against its OWN tips and co-signs the LEADER's map or nothing
    // -----------------------------------------------------------------------
    describe('the oracle round pins and carries its admission map (row 18)', function () {
        registerTheOracleRoundPinsAnd2Hooks();
        registerTheOracleRoundPinsAnd2Tests1();
        registerTheOracleRoundPinsAnd2Tests5();
    });
});
