'use strict';

const {
    fs,
    os,
    path,
    crypto,
    sinon,
    expect,
    OraclePublisher,
    waitUntil,
    PRICE_BATCH_COMPRESSION_MARKER,
    inflatePriceBatchBody,
    DB_METHODS,
    PRICE_WIRE_MAX_BYTES,
    ME,
    PEER1,
    PEER2,
    hex,
    makeIdentity,
    sigsOf,
    pairsOf,
    roundFixture,
    bufferedFixture,
    makeSigner,
    makeSnapshot,
    makeDb,
    makePublisher,
    bodyOf,
    readJsonl,
    cleanupPublisherBatch
} = require('./oracle_publisher_batch.test.js');

let logs;

// ───────────────────────────────────── the two claims section 7 asserts about other code

const testCase1 = async function () {
            let h = makePublisher();
            await h.p.start();
            h.p.broadcastFn   = null;                       // exercise the DEFAULT pipeline
            h.p.dogeAddress   = 'DEXAMPLEaddress0000000000000000000';
            h.p.dogePubkeyHex = hex(66, 'doge-pubkey');
            h.p.walletSignFn  = sinon.stub().resolves('deadbeef');
            h.p.encoder = {
                getUtxos:  sinon.stub().resolves([{ value: 100000000 }]),
                // Phase 1 of a two-transaction encoding, which is what an oversized
                // payload gets back from the encoder.
                createTx:  sinon.stub().resolves({ psbt: 'aabb', encoding: 'P2SH',
                                                   carrierScripts: ['5121aa'] }),
                broadcastTx: sinon.stub().resolves({ txid: 'must-not-happen' })
            };

            let threw = null;
            try { await h.p.defaultBroadcast('PRICE|0|0|5|800005|1|...'); } catch (e) { threw = e; }

            expect(threw, 'the guard must throw').to.not.equal(null);
            expect(threw.message).to.match(/phase 1 of a two-transaction/);
            expect(h.p.walletSignFn.called, 'nothing may be signed').to.equal(false);
            expect(h.p.encoder.broadcastTx.called, 'no fee may be spent').to.equal(false);
        };

const testCase2 = function () {
            let h = makePublisher();
            // PriceAggregator.js: canClearMarkers = typeof publisher.clearPublishedMarkers === 'function'
            expect(typeof h.p.clearPublishedMarkers).to.equal('function');
            expect(h.p.clearPublishedMarkers.length).to.equal(1);
        };

function registerSuite1() {
    it('refuses a two-phase P2SH encoding BEFORE the wallet hook, so an oversized batch costs no fee', testCase1);
    it('satisfies the exact predicate PriceAggregator gates its retraction clear on', testCase2);
}

function registerOuterSuite12() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('claims section 7 makes about the surrounding code', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite12);
