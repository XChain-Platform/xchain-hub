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

// ───────────────────────────────────── the self-check (D27, and the pinned status ambiguity)

const testCase1 = async function () {
            let db = makeDb({ snapshots: [
                { round_number: 0, block_timestamp: 1800000000, status: 'finalized' },
                { round_number: 3, block_timestamp: 1800001800, status: 'finalized' }   // never buffered
            ] });
            let h = makePublisher({ db: db });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(0);
            expect(logs.warn.join('\n')).to.match(/finalized round\(s\) 3 with no buffered copy/);
        };

const testCase2 = async function () {
            // The old rail exempted rounds below the activation stamp, because those went
            // out as v0 and were never buffered, so without the exemption the first
            // straddling window would have seen permanent gaps. No stamp, no straddle, no
            // exemption: every finalized round must be accounted for, whatever its time.
            let h = makePublisher({
                network: 'testnet',
                db: makeDb({ snapshots: [
                    { round_number: 0, block_timestamp: -1,         status: 'finalized' },
                    { round_number: 1, block_timestamp: 1800000600, status: 'finalized' }
                ] })
            });
            await h.p.start();
            h.p._buffer.set(1, bufferedFixture(1));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(0);
            expect(logs.warn.join('\n')).to.match(/finalized round\(s\) 0 with no buffered copy/);
        };

const testCase3 = async function () {
            // The signer refuses to sign disputed content, so treating a disputed round
            // as present-but-unbuffered would make the window unpublishable for good.
            let db = makeDb({ snapshots: [
                { round_number: 0, block_timestamp: 1800000000, status: 'finalized' },
                { round_number: 4, block_timestamp: 1800002400, status: 'disputed' },
                { round_number: 5, block_timestamp: 1800003000, status: 'skipped' }
            ] });
            let h = makePublisher({ db: db });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 0 });
        };

const testCase4 = async function () {
            let db = makeDb();
            db.doQuery = sinon.stub().callsFake(async (q) => {
                if (/price_snapshots/i.test(q)) throw new Error('table gone');
                return [];
            });
            let h = makePublisher({ db: db });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(0);
            expect(logs.warn.join('\n')).to.match(/withholding the batch \(fail closed\)/);
        };

function registerSuite1() {
    it('refuses a window whose post-stamp finalized round has no buffered copy', testCase1);
    it('has NO stamp exemption: a finalized round with no buffered copy withholds the batch', testCase2);
    it('keys on status = finalized ONLY, so a reorg-disputed round cannot stall the window forever', testCase3);
    it('fails closed when price_snapshots cannot be read', testCase4);
}

function registerOuterSuite5() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('the pre-publish self-check', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite5);
