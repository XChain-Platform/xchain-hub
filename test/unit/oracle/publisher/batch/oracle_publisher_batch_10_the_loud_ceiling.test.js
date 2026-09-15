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

// ───────────────────────────────────── the loud ceiling (D19, section 8)

const testCase1 = async function () {
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0, { pairs: pairsOf(1200, 'huge') }));
            // The premise, measured rather than assumed: it fits neither bound.
            expect(h.p._wireFits(h.p._emitWire(0, 0, 800000, h.p.bufferedRange(0, 0), sigsOf(3))))
                .to.equal(false);

            await h.p._assembleWindow(0);

            expect(h.p.getStats().batchUnpublishableCount).to.equal(1);
            expect(logs.error.join('\n')).to.match(/OraclePublisher: CRITICAL - PRICE v0 round 0 alone does not fit/);
            expect(logs.error.join('\n')).to.match(/inflated-body cap|encoder payload limit/);
            let dead = readJsonl(h.deadPath);
            expect(dead).to.have.length(1);
            expect(dead[0].round).to.equal(0);
            expect(dead[0].reason).to.match(/exceeds encoder limit/);
            expect(h.broadcasts, 'nothing may publish for an unpublishable round').to.have.length(0);
        };

const testCase2 = async function () {
            let h = makePublisher();
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0, { pairs: pairsOf(1200, 'huge') }));
            h.p._buffer.set(1, bufferedFixture(1));
            h.p._buffer.set(2, bufferedFixture(2));

            await h.p._assembleWindow(0);

            expect(h.p.getStats().batchUnpublishableCount).to.equal(1);
            expect(h.broadcasts).to.have.length(1);
            let entry = readJsonl(h.queuePath);
            expect(entry).to.have.length(0);   // published and dequeued
            expect(h.signer.calls[h.signer.calls.length - 1]).to.include({ first: 1, last: 2 });
        };

function registerSuite1() {
    it('logs CRITICAL, counts, and dead-letters a single round that cannot fit any wire', testCase1);
    it('still publishes the rest of the window around one unpublishable round', testCase2);
}

function registerOuterSuite10() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('the loud ceiling', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite10);
