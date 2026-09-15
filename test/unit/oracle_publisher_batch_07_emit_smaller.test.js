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

// ───────────────────────────────────── emit-smaller (section 4a)

const testCase1 = function () {
            let h = makePublisher();
            let rounds = [];
            for (let r = 0; r < 6; r++) {
                rounds.push(bufferedFixture(r, { pairs: pairsOf(37, 'real') }));   // 37 real pairs
            }
            let emitted = h.p._emitWire(0, 5, 800005, rounds, sigsOf(3));
            expect(emitted.compressed).to.equal(true);
            let fields = emitted.wire.split('|');
            expect(fields.slice(0, 3)).to.deep.equal(['PRICE', '0', PRICE_BATCH_COMPRESSION_MARKER]);

            let inflated = inflatePriceBatchBody(fields[3]);
            expect(inflated.ok).to.equal(true);
            expect(inflated.body).to.equal(h.p.buildPriceBatchBody(0, 5, 800005, rounds, sigsOf(3)));
        };

const testCase2 = function () {
            let h = makePublisher();
            // Measured while writing this: any signature-bearing body deflates smaller,
            // because ed25519 hex halves under deflate. The uncompressed branch is for
            // the pathological short, high-entropy body the spec names, so that is what
            // is driven here: one round, one incompressible pair name, no signature set.
            let rounds = [bufferedFixture(0, { pairs: [{ coinPair: 'Q7fKp2ZmXn4Vb8Rt/Ld3Ws9Yj', price: '1' }] })];
            let emitted = h.p._emitWire(0, 0, 800000, rounds, []);
            expect(emitted.compressed).to.equal(false);
            expect(emitted.wire.split('|')[2]).to.not.equal(PRICE_BATCH_COMPRESSION_MARKER);
            expect(emitted.wire).to.equal('PRICE|0|' + h.p.buildPriceBatchBody(0, 0, 800000, rounds, []));
        };

const testCase3 = function () {
            let h = makePublisher();
            for (let pairCount of [1, 2, 5, 37, 200]) {
                for (let sigCount of [0, 1, 3, 9]) {
                    let rounds = [bufferedFixture(0, { pairs: pairsOf(pairCount, 'inv' + pairCount) })];
                    let plain  = 'PRICE|0|' + h.p.buildPriceBatchBody(0, 0, 800000, rounds, sigsOf(sigCount));
                    let out    = h.p._emitWire(0, 0, 800000, rounds, sigsOf(sigCount));
                    expect(out.bytes, pairCount + ' pairs / ' + sigCount + ' sigs')
                        .to.be.at.most(Buffer.byteLength(plain, 'utf8'));
                }
            }
        };

const testCase4 = function () {
            let h = makePublisher();
            let rounds = [
                bufferedFixture(2, { pairs: [{ coinPair: 'ZZZ/USD', price: '3' }, { coinPair: 'AAA/USD', price: '1' }] }),
                bufferedFixture(1, { pairs: [{ coinPair: 'AAA/USD', price: '2' }] })
            ];
            let body = h.p.buildPriceBatchBody(1, 2, 800002, rounds, sigsOf(1));
            let f = body.split('|');
            expect(f.slice(0, 4)).to.deep.equal(['1', '2', '800002', '2']);
            expect(f[4]).to.equal('1');                    // round 1 first
            expect(f.slice(8, 10)).to.deep.equal(['AAA/USD', '2']);
            expect(f.indexOf('AAA/USD', 10)).to.be.lessThan(f.indexOf('ZZZ/USD'));
        };

function registerSuite1() {
    it('rides compressed when deflate wins, and the wire inflates back to the same body', testCase1);
    it('rides UNCOMPRESSED when deflate makes the body larger', testCase2);
    it('never emits a wire larger than the uncompressed form, whatever the content', testCase3);
    it('emits rounds ascending and pairs sorted regardless of caller ordering', testCase4);
}

function registerOuterSuite7() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('emit-smaller', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite7);
