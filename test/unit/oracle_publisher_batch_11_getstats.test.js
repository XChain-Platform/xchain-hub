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

// ───────────────────────────────────── stats (section 7)

const testCase1 = async function () {
            let h = makePublisher({ db: makeDb(), signerOpts: { timeouts: 4 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            await h.p._assembleWindow(0);

            let s = h.p.getStats();
            expect(s.batchWindowsPublished).to.equal(1);
            expect(s.lastPublishedWindow).to.equal(0);
            expect(s.batchSplitCount).to.equal(0);
            expect(s.batchUnpublishableCount).to.equal(0);
            expect(s.batchSignTimeouts).to.equal(4);
            // The dashboard's publisher-stall rule reads this field as "the newest round
            // on chain"; FIRST_ROUND would make a healthy rail look an hour behind.
            expect(s.lastPublishedRound).to.equal(5);
        };

const testCase2 = async function () {
            let h = makePublisher({ db: makeDb() });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'stats' + r) }));
            }
            await h.p._assembleWindow(0);
            let s = h.p.getStats();
            expect(s.batchSplitCount).to.be.greaterThan(0);
            expect(s.batchWindowsPublished).to.equal(1);
        };

const testCase3 = function () {
            let h = makePublisher({ signer: null });
            expect(h.p.getStats().batchSignTimeouts).to.equal(0);
            expect(h.p._ownedBatchSigner).to.equal(null);
        };

function registerSuite1() {
    it('carries the five batch fields and keeps lastPublishedRound on the LAST round of the wire', testCase1);
    it('counts a split window ONCE in batchWindowsPublished', testCase2);
    it('reports zero sign timeouts without constructing a signer', testCase3);
}

function registerOuterSuite11() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('getStats', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite11);
