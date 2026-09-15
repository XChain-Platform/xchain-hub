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
    instances,
    cleanupPublisherBatch
} = require('./oracle_publisher_batch.test.js');

let logs;

// ───────────────────────────────────── per-round markers (D10)

const testCase1 = async function () {
            let db = makeDb();
            let h  = makePublisher({ db: db, cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p.assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);
            expect(Object.keys(db.markers).map(Number).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3, 4, 5]);
            for (let r = 0; r < 6; r++) expect(db.markers[r].sent_at).to.not.equal(null);
        };

const testCase2 = async function () {
            let h = makePublisher();
            await h.p.start();
            for (let r = 6; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
            sinon.stub(h.p, 'processQueue').resolves();   // keep the entry on disk to read
            await h.p.assembleWindow(1);

            let queued = readJsonl(h.queuePath);
            expect(queued).to.have.length(1);
            expect(queued[0].round).to.equal(6);
            expect(queued[0].batch.rounds).to.deep.equal([6, 7, 8, 9, 10, 11]);
        };

const testCase3 = async function () {
            let db = makeDb();
            let h  = makePublisher({ db: db });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            await h.p.assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);

            // A second leader (or this hub after a restart) re-proposes the SAME rounds
            // under a different split: [0,2] and [3,5]. Neither wire's FIRST_ROUND is 1,
            // 2, 4 or 5, so a marker keyed on FIRST_ROUND alone would find nothing for
            // four of the six rounds and pay a second DOGE fee for them.
            let second = new OraclePublisher(h.hub);
            instances.push(second);
            await second.start();
            let seen = [];
            second.setBroadcastHook(async (p) => { seen.push(p); return { txid: 'dup' }; });
            for (let split of [[0, 2], [3, 5]]) {
                let rounds = [];
                for (let r = split[0]; r <= split[1]; r++) rounds.push(bufferedFixture(r));
                await second._enqueue({
                    round: split[0],
                    batch: { windowIndex: 0, firstRound: split[0], lastRound: split[1],
                             anchor: 800000 + split[1], rounds: rounds.map(r => r.round),
                             sigCount: 3, compressed: false, wireIndex: 0, wireCount: 2 },
                    wire: second.emitWire(split[0], split[1], 800000 + split[1], rounds, sigsOf(3)).wire
                });
            }
            await second.processQueue();

            expect(seen, 'a re-split re-publish must not reach the wire').to.have.length(0);
            // Suppressed on the strength of a marker for a round that is NOT either
            // wire's FIRST_ROUND. Startup hydration loads the durable rows into the
            // in-process guard, so the guard that fires is whichever reads first; both
            // are keyed per contained round.
            expect(logs.warn.join('\n')).to.match(/already broadcast this process lifetime|durable sent marker/);
            expect(readJsonl(h.queuePath), 'both stale wires must be dropped').to.have.length(0);
        };

function registerSuite1() {
    it('writes a durable marker for EVERY round on the wire, not just FIRST_ROUND', testCase1);
    it('keeps the queue entry identity on FIRST_ROUND so the existing Sets and the retention clamp still work', testCase2);
    it('SUPPRESSES a re-publish of the same rounds under a DIFFERENT split (the duplicate DOGE spend)', testCase3);
}

function registerOuterSuite8() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('at-most-once markers, one row per contained round', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite8);
