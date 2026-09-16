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

// ───────────────────────────────────── clearPublishedMarkers (D28)

// The realistic retraction shape: a batch published, then the hub restarted (or
// simply kept running long enough to re-hydrate), so the durable rows are loaded
// back into the in-process guard. That is the state in which clearing only ONE
// of the two halves is observably wrong.
async function publishThenRehydrate() {
            let db = makeDb();
            let h  = makePublisher({ db: db });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            await h.p.assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);
            expect(Object.keys(db.markers)).to.have.length(6);

            let live = new OraclePublisher(h.hub);
            instances.push(live);
            let seen = [];
            live.setBroadcastHook(async (p) => { seen.push(p); return { txid: 'recovery' }; });
            await live.start();   // hydration arms the in-process guard from the durable rows
            for (let r = 0; r < 6; r++) live._buffer.set(r, bufferedFixture(r));
            return { db, live, seen };
        }

const testCase1 = async function () {
            let { db, live } = await publishThenRehydrate();
            for (let r = 0; r < 6; r++) {
                expect(live._publishedRounds.has(r), 'hydrated guard for ' + r).to.equal(true);
            }

            let deleted = await live.clearPublishedMarkers([0, 1, 2, 3, 4, 5]);
            expect(deleted).to.equal(6);
            expect(Object.keys(db.markers)).to.have.length(0);
            for (let r = 0; r < 6; r++) {
                expect(live._publishedRounds.has(r), 'in-process guard for ' + r).to.equal(false);
            }
            // The window memo is the third suppressor and must go too.
            expect(live._assembledWindows.has(0)).to.equal(false);
        };

const testCase2 = async function () {
            let { live, seen } = await publishThenRehydrate();
            await live.clearPublishedMarkers([0, 1, 2, 3, 4, 5]);
            await live.assembleWindow(0);
            expect(seen, 'the recovery re-publish must go out').to.have.length(1);
        };

const testCase3 = async function () {
            let { live, seen } = await publishThenRehydrate();
            live._assembledWindows.delete(0);
            await live.assembleWindow(0);
            expect(seen, 'nothing may re-publish while the markers stand').to.have.length(0);
        };

const testCase4 = async function () {
            let h = makePublisher({ db: makeDb() });
            await h.p.start();
            h.p._quarantinedRounds.add(7);
            await h.p.clearPublishedMarkers([7]);
            expect(h.p._quarantinedRounds.has(7)).to.equal(true);
        };

const testCase5 = async function () {
            let db = makeDb({ markers: { 5: { round: 5, txid: 't', sent_at: 'x' } } });
            let h  = makePublisher({ db: db });
            await h.p.start();
            expect(await h.p.clearPublishedMarkers([])).to.equal(0);
            expect(await h.p.clearPublishedMarkers(['nope', null])).to.equal(0);
            expect(Object.keys(db.markers)).to.have.length(1);
        };

function registerSuite1() {
    it('clears BOTH the durable rows and the in-process at-most-once set', testCase1);
    it('lets the recovery re-publish actually reach the wire after a retraction', testCase2);
    it('leaves the re-publish suppressed while the markers stand', testCase3);
    it('leaves the quarantine set alone: a retraction does not resolve an unknown on-chain state', testCase4);
    it('is a no-op on an empty or unparseable list', testCase5);
}

function registerOuterSuite9() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('clearPublishedMarkers', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite9);
