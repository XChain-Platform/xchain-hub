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

// Fleet evidence showed every validator hub boot onto a buffer holding its whole
// finalized history, about 1400 rounds and 704 closed windows, because the
// observation prune keys on rows a validator never gets. The hourly sweep then
// re-published windows the chain already carried, four an hour, at a DOGE fee
// apiece. Two seams close it: the aggregator hands every landed batch to
// noteBatchLanded, since every hub hears every push, and the sweep asks the
// landing chain's indexer about the backlog first.

// A hub whose landing-chain indexer answers getpricebatches with `batches`.
function hubWithIndexer(h, batches, opts) {
            opts = opts || {};
            h.hub.resolveIndexerUrl = sinon.stub().resolves(opts.url === undefined ? 'http://doge-indexer:3114' : opts.url);
            let rpc = sinon.stub(h.p, 'indexerRpc');
            if (opts.reject) rpc.rejects(new Error(opts.reject));
            else rpc.resolves({ block_index: 67875698, batches: batches, truncated: !!opts.truncated });
            return rpc;
        }

let savedEnv;

const hook1 = function () {
            savedEnv = { url: process.env.DOGE_INDEXER_API_URL, url2: process.env.DOGE_INDEXER_URL,
                         key: process.env.DOGE_INDEXER_API_KEY };
            delete process.env.DOGE_INDEXER_API_URL;
            delete process.env.DOGE_INDEXER_URL;
            delete process.env.DOGE_INDEXER_API_KEY;
        };

const hook2 = function () {
            if (savedEnv.url  !== undefined) process.env.DOGE_INDEXER_API_URL = savedEnv.url;
            if (savedEnv.url2 !== undefined) process.env.DOGE_INDEXER_URL     = savedEnv.url2;
            if (savedEnv.key  !== undefined) process.env.DOGE_INDEXER_API_KEY = savedEnv.key;
        };

const testCase3 = async function () {
                let h = makePublisher();
                await h.p.start();
                for (let r = 0; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));
                h.p.rewriteBufferFile(h.p.bufferedRange(-Infinity, Infinity));
                expect(h.p.pendingCatchupWindows()).to.deep.equal([0, 1]);

                expect(h.p.noteBatchLanded(0, 5, { sourceChain: 'DOGE', actionIndex: 270 })).to.equal(6);

                expect(h.p._buffer.has(0)).to.equal(false);
                expect(h.p._buffer.has(5)).to.equal(false);
                expect(h.p._buffer.has(6)).to.equal(true);
                expect(readJsonl(h.bufferPath).map(e => e.round), 'the durable copy is shed too, or a restart brings the window back')
                    .to.deep.equal([6, 7, 8, 9, 10, 11, 12]);
                expect(h.p._assembledWindows.has(0)).to.equal(true);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([1]);
                expect(h.p.getStats().landedBatchPrunedRounds).to.equal(6);

                // A hub that has not buffered the range sheds nothing and stays quiet.
                expect(h.p.noteBatchLanded(100, 105)).to.equal(0);
                expect(h.p.noteBatchLanded('x', 5)).to.equal(0);
            };

const testCase4 = async function () {
                let h = makePublisher();
                await h.p.start();
                for (let r = 6; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));

                // The fleet case: [49,49] landed alone because 46-48 had already been shed.
                expect(h.p.noteBatchLanded(6, 8)).to.equal(3);

                expect(h.p._assembledWindows.has(1), 'not memoized: rounds 9..11 still need a wire').to.equal(false);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([1]);
                await h.p._assembleWindow(1);
                expect(h.signer.calls).to.have.length(1);
                expect(h.signer.calls[0].rounds).to.deep.equal([9, 10, 11]);
            };

const testCase5 = async function () {
                let h = makePublisher();
                await h.p.start();
                for (let r = 0; r < 7; r++) h.p._buffer.set(r, bufferedFixture(r));
                let takeover = setTimeout(() => {}, 60000);
                h.p._takeoverTimers.set(0, takeover);
                h.p._windows.set(0, { timer: setTimeout(() => {}, 60000) });

                h.p.noteBatchLanded(0, 5);

                expect(h.p._takeoverTimers.has(0), 'nothing left to take over').to.equal(false);
                expect(h.p._windows.has(0)).to.equal(false);
                clearTimeout(takeover);
            };

function registerSuite2() {
    it('sheds the covered rounds from memory AND the buffer file and memoizes the window', testCase3);
    it('keeps a PARTLY covered window re-proposable over its remaining rounds only', testCase4);
    it('disarms a takeover and a grace timer for a window that has fully landed', testCase5);
}

const testCase6 = async function () {
                let h = makePublisher({ cfg: { DOGE_INDEXER_API_KEY: 'fed-key' } });
                await h.p.start();
                // Windows 0..3 closed, window 4 open (round 24 only).
                for (let r = 0; r < 25; r++) h.p._buffer.set(r, bufferedFixture(r));
                expect(h.p.pendingCatchupWindows()).to.deep.equal([0, 1, 2, 3]);
                let rpc = hubWithIndexer(h, [{ first_round: 0, last_round: 5, action_index: 10 },
                                             { first_round: 12, last_round: 17, action_index: 11 }]);

                expect(await h.p.reconcileBacklogAgainstChain()).to.equal(12);

                expect(rpc.calledOnce).to.equal(true);
                expect(rpc.firstCall.args[0]).to.equal('http://doge-indexer:3114');
                expect(rpc.firstCall.args[1]).to.equal('fed-key');
                expect(rpc.firstCall.args[2]).to.equal('getpricebatches');
                expect(rpc.firstCall.args[3]).to.deep.equal({ first_round: 0, last_round: 23, limit: 500 });
                expect(h.p.pendingCatchupWindows(), 'only the windows the chain lacks remain').to.deep.equal([1, 3]);
                let stats = h.p.getStats();
                expect(stats.chainReconcileRuns).to.equal(1);
                expect(stats.chainReconcilePrunedRounds).to.equal(12);
                expect(stats.chainReconcileFailures).to.equal(0);
                expect(stats.bufferedWindowsPending).to.equal(2);
            };

const testCase7 = async function () {
                let h = makePublisher({ signerOpts: { met: false } });
                await h.p.start();
                for (let r = 0; r < 25; r++) h.p._buffer.set(r, bufferedFixture(r));
                hubWithIndexer(h, [{ first_round: 0, last_round: 5 }, { first_round: 12, last_round: 17 }]);

                expect(await h.p.reconcileThenSweep()).to.equal(2);
                await h.p._windowChain;

                expect(h.signer.calls.map(c => c.first), 'windows 1 and 3, never 0 or 2').to.deep.equal([6, 18]);
                expect(h.broadcasts).to.have.length(0);
            };

const testCase8 = async function () {
                // The fleet re-windowed from 6 rounds to 2, so on-chain batches do not
                // align with the hub's windows. Coverage is judged per ROUND, never per window.
                let h = makePublisher();
                await h.p.start();
                for (let r = 0; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));
                hubWithIndexer(h, [{ first_round: 2, last_round: 3 }, { first_round: 4, last_round: 9 }]);

                await h.p.reconcileBacklogAgainstChain();

                expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([0, 1, 10, 11, 12]);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([0, 1]);
            };

const testCase9 = async function () {
                let h = makePublisher({ signerOpts: { met: false } });
                await h.p.start();
                for (let r = 0; r < 25; r++) h.p._buffer.set(r, bufferedFixture(r));
                hubWithIndexer(h, [], { url: null });

                expect(await h.p.reconcileBacklogAgainstChain()).to.equal(0);
                expect(h.p.getStats().chainReconcileFailures).to.equal(1);
                expect(h.p.getStats().chainReconcileRuns).to.equal(0);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([0, 1, 2, 3]);

                expect(await h.p.reconcileThenSweep()).to.equal(4);
                await h.p._windowChain;
                expect(h.signer.calls.map(c => c.first)).to.deep.equal([0, 6, 12, 18]);
            };

const testCase10 = async function () {
                let h = makePublisher();
                await h.p.start();
                for (let r = 0; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));
                let rpc = hubWithIndexer(h, [], { reject: 'indexer RPC error: {"code":-32601,"message":"Method not found"}' });

                expect(await h.p.reconcileBacklogAgainstChain()).to.equal(0);
                expect(await h.p.reconcileBacklogAgainstChain()).to.equal(0);

                let mine = logs.warn.filter(l => /cannot check the buffered backlog/.test(l));
                expect(mine, 'one line per distinct reason, not one per sweep').to.have.length(1);
                expect(mine[0]).to.match(/Method not found/);
                expect(rpc.calledTwice).to.equal(true);
                expect(h.p.getStats().chainReconcileFailures).to.equal(2);
                expect(h.p._buffer.size, 'nothing shed on a failed read').to.equal(13);

                // An answer without a batch list (an indexer that returns an error object) is a miss too.
                rpc.resolves({ error: 'indexer database not ready' });
                expect(await h.p.reconcileBacklogAgainstChain()).to.equal(0);
                expect(h.p.getStats().chainReconcileFailures).to.equal(3);
            };

const testCase11 = async function () {
                let h = makePublisher();
                await h.p.start();
                let rpc = hubWithIndexer(h, []);
                expect(await h.p.reconcileBacklogAgainstChain()).to.equal(0);
                expect(rpc.called).to.equal(false);
            };

function registerSuite3() {
    it('asks the DOGE indexer for the whole pending span, with the federation key, and sheds what it names', testCase6);
    it('the sweep then re-proposes ONLY the unlanded windows, so nothing already on chain is paid for twice', testCase7);
    it('a batch the chain carries under a DIFFERENT window split still sheds every buffered round it covers', testCase8);
    it('fails OPEN when no indexer URL is configured: the sweep runs as before and the miss is counted', testCase9);
    it('fails OPEN when the indexer is unreachable or too old to answer, and logs the reason once', testCase10);
    it('does not ask at all when nothing is pending', testCase11);
}

// Finalized v0 rows for the rounds, one per pair, the shape the restore reads.
function restoreDb(rounds) {
                let db = { queries: [], markers: {} };
                Object.setPrototypeOf(db, DB_METHODS);   // the named query methods, own members still win
                db.doQuery = sinon.stub().callsFake(async (q, args) => {
                    db.queries.push({ q, args });
                    if (/FROM\s+price_snapshots/i.test(q) && /round_number\s+IN/i.test(q)) {
                        let asked = args.slice(0, -1).map(Number);
                        let out = [];
                        for (let r of rounds) {
                            if (!asked.includes(r)) continue;
                            let e = bufferedFixture(r);
                            for (let p of e.pairs) {
                                out.push({ round_number: r, coin_pair: p.pair, price: p.price,
                                           reference_block: e.btcBlockHeight, block_timestamp: e.timestamp });
                            }
                        }
                        return out;
                    }
                    if (/^\s*DELETE/i.test(q)) return { affectedRows: args.length };
                    return [];
                });
                return db;
            }

const testCase12 = async function () {
                let h = makePublisher({ db: restoreDb([0, 1, 2, 3, 4, 5]) });
                await h.p.start();
                for (let r = 0; r < 7; r++) h.p._buffer.set(r, bufferedFixture(r));
                h.p.noteBatchLanded(0, 5);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([]);

                await h.p.clearPublishedMarkers([0, 1, 2, 3, 4, 5]);

                expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3, 4, 5, 6]);
                expect(h.p._buffer.get(3), 'byte-for-byte the content the co-signers derive').to.deep.equal(bufferedFixture(3));
                expect(readJsonl(h.bufferPath).map(e => e.round)).to.include.members([0, 1, 2, 3, 4, 5]);
                expect(h.p._assembledWindows.has(0)).to.equal(false);
                // Restoring re-arms the window's grace timer, so the re-publish comes on
                // the grace clock (minutes) rather than waiting for the hourly sweep; the
                // sweep leaves a window alone while its timer owns it.
                expect(h.p._windows.get(0) && !!h.p._windows.get(0).timer).to.equal(true);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([]);
                clearTimeout(h.p._windows.get(0).timer);
                h.p._windows.delete(0);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([0]);
                await h.p._assembleWindow(0);
                expect(h.signer.calls).to.have.length(1);
                expect(h.signer.calls[0].rounds).to.deep.equal([0, 1, 2, 3, 4, 5]);
            };

const testCase13 = async function () {
                let db = restoreDb([2, 3]);          // rows exist for 2 and 3 only
                let h = makePublisher({ db: db });
                await h.p.start();
                h.p._buffer.set(4, bufferedFixture(4));

                await h.p.clearPublishedMarkers([2, 3, 4, 5]);

                let restoreQuery = db.queries.find(x => /round_number\s+IN/i.test(x.q));
                expect(restoreQuery.args, 'round 4 is already buffered, so it is not asked for').to.deep.equal([2, 3, 5, 'finalized']);
                expect(restoreQuery.q).to.match(/consensus_proof NOT LIKE '\{"batch":%'/);
                expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([2, 3, 4]);
            };

function registerSuite4() {
    it('restores the shed window from price_snapshots when its markers are cleared, so it can be re-published', testCase12);
    it('restores only what the buffer lacks and only from v0-proofed finalized rows', testCase13);
}

function registerSuite1() {
    beforeEach(hook1);
    afterEach(hook2);
    describe('noteBatchLanded', registerSuite2);
    describe('reconciling the backlog against the landing chain before a sweep', registerSuite3);
    describe('a retracted batch gets its rounds back', registerSuite4);
}

function registerOuterSuite15() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('shedding windows the chain already carries', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite15);
