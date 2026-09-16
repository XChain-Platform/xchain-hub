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

// ───────────────────────────────────── splitting (D17) and the flag-day rule (D7)

const testCase1 = async function () {
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'split' + r) }));
            }
            // The premise: a six-round wire really does overflow at this size.
            let whole = h.p.emitWire(0, 5, 800005, h.p.bufferedRange(0, 5), sigsOf(3));
            expect(whole.bytes).to.be.greaterThan(PRICE_WIRE_MAX_BYTES);

            // Hold the publish pass so the enqueued wires stay readable on disk; a
            // successful pass dequeues them and the split would be invisible here.
            sinon.stub(h.p, 'processQueue').resolves();
            await h.p.assembleWindow(0);

            let entries = readJsonl(h.queuePath);
            expect(entries.length).to.be.greaterThan(1);
            expect(h.p.getStats().batchSplitCount).to.equal(entries.length - 1);
            // Every wire fits, every wire is a contiguous sub-range, and together they
            // cover the window exactly once.
            let covered = [];
            for (let e of entries) {
                expect(Buffer.byteLength(e.wire, 'utf8')).to.be.at.most(PRICE_WIRE_MAX_BYTES);
                covered = covered.concat(e.batch.rounds);
            }
            expect(covered).to.deep.equal([0, 1, 2, 3, 4, 5]);
        };

const testCase2 = async function () {
            // mainnet arms STAKE_WEIGHTED_QUORUM at 961000 and the sig tally at 963000.
            let h = makePublisher({ network: 'mainnet' });
            await h.p.start();
            for (let r = 0; r < 4; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { anchor: 960998 + r }));  // 960998..961001
            }

            await h.p.assembleWindow(0);

            expect(h.signer.calls.map(c => [c.first, c.last])).to.deep.equal([[0, 1], [2, 3]]);
            // Neither proposed range straddles: the signer's receiving-side twin would
            // silently refuse one that did, and nothing would ever publish.
            for (let c of h.signer.calls) {
                let range = h.p.bufferedRange(c.first, c.last);
                expect(h.p.flagDayKey(range[0].btcBlockHeight))
                    .to.equal(h.p.flagDayKey(range[range.length - 1].btcBlockHeight));
            }
        };

const testCase3 = async function () {
            // Both verifiers now reject a batch whose header BTC_BLOCK_HEIGHT is not the
            // last included round's own anchor. A split that kept the window's anchor
            // would put every wire but the last one on chain as invalid, fee and all.
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'anchor' + r) }));
            }
            sinon.stub(h.p, 'processQueue').resolves();
            await h.p.assembleWindow(0);

            let entries = readJsonl(h.queuePath);
            expect(entries.length).to.be.greaterThan(1);
            for (let e of entries) {
                let lastRoundAnchor = 800000 + e.batch.lastRound;
                expect(e.batch.anchor, 'wire [' + e.batch.firstRound + ',' + e.batch.lastRound + ']')
                    .to.equal(lastRoundAnchor);
                // And it is the value actually on the wire, whichever form it rode in.
                expect(bodyOf(e.wire).split('|')[2]).to.equal(String(lastRoundAnchor));
            }
            // The signing round was asked for the same anchor it will be verified under.
            for (let c of h.signer.calls) expect(c.anchor).to.equal(800000 + c.last);
        };

const testCase4 = async function () {
            // price_batch_compression.js caps the INFLATED body at PRICE_WIRE_MAX_BYTES
            // (outputCap = min(PRICE_WIRE_MAX_BYTES, ratioCap)), so a compressed wire can
            // sail under the encoder limit and still carry a body every indexer refuses
            // to finish inflating. Sizing on the emitted bytes alone spends a DOGE fee on
            // an action nobody accepts, so every wire is round-tripped through the real
            // reader here rather than merely measured.
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'reader' + r) }));
            }
            sinon.stub(h.p, 'processQueue').resolves();
            await h.p.assembleWindow(0);

            let entries = readJsonl(h.queuePath);
            expect(entries.length).to.be.greaterThan(1);
            for (let e of entries) {
                let body = bodyOf(e.wire);
                expect(body, 'the reader must accept wire [' + e.batch.firstRound + ',' +
                    e.batch.lastRound + ']').to.not.equal(null);
                expect(Buffer.byteLength(body, 'utf8')).to.be.at.most(PRICE_WIRE_MAX_BYTES);
                expect(body.split('|').slice(0, 2))
                    .to.deep.equal([String(e.batch.firstRound), String(e.batch.lastRound)]);
            }
        };

const testCase5 = function () {
            let h = makePublisher();
            let rounds = [bufferedFixture(0), bufferedFixture(1)];   // anchors 800000, 800001
            expect(() => h.p.buildPriceBatchBody(0, 1, 800001, rounds, sigsOf(1))).to.not.throw();
            expect(() => h.p.buildPriceBatchBody(0, 1, 800000, rounds, sigsOf(1)))
                .to.throw(/does not equal the last included round's anchor 800001/);
        };

const testCase6 = async function () {
            let h = makePublisher({ network: 'mainnet' });
            await h.p.start();
            for (let r = 0; r < 4; r++) h.p._buffer.set(r, bufferedFixture(r, { anchor: 970000 + r }));
            await h.p.assembleWindow(0);
            expect(h.signer.calls.map(c => [c.first, c.last])).to.deep.equal([[0, 3]]);
            expect(h.p.getStats().batchSplitCount).to.equal(0);
        };

function registerSuite1() {
    it('packs the largest range that fits and splits an overflowing window into several wires', testCase1);
    it('splits at an armed oracle flag-day boundary inside the window (D7)', testCase2);
    it('re-derives the header anchor for EVERY split, never the whole window\'s', testCase3);
    it('emits only wires the READER accepts: the inflated body is capped at the same 8189', testCase4);
    it('refuses to build a body whose header anchor is not the last round\'s anchor', testCase5);
    it('does not split a window that sits entirely on one side of every flag day', testCase6);
}

function registerOuterSuite6() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('splitting', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite6);
