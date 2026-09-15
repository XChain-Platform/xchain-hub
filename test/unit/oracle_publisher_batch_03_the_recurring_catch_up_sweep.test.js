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

// ───────────────────────────────────── re-proposing a timed-out window

// "Re-proposable" has to be more than a property of the memo. A one-shot
// catch-up sweep leaves a window that misses quorum unpublished until an
// operator restarts the hub. On public testnet, window [102,107] was refused
// by three peers at boot, was not attempted again, and left 744 rounds back
// to round 21 in the leader's buffer. This makes the memo state inert instead
// of an actual retry mechanism inside the same running process.

// A signer that misses quorum for its first N attempts and then succeeds,
// which is what a peer coming back up (or a reconciled buffer) looks like.
function flakySigner(failFirst) {
            let signer = { calls: [], getStats: () => ({ batchSignTimeouts: 0 }), start() {}, stop() {} };
            signer.collectBatchSignatures = sinon.stub().callsFake(async (f, l, a, rounds) => {
                signer.calls.push({ first: f, last: l, anchor: a, rounds: rounds.map(r => r.round) });
                if (signer.calls.length <= failFirst)
                    return { met: false, sigs: sigsOf(1), firstRound: f, lastRound: l };
                return { met: true, sigs: sigsOf(3), firstRound: f, lastRound: l,
                         btcBlockHeight: a, canonical: 'canonical-' + f + '-' + l };
            });
            return signer;
        }

const testCase1 = async function () {
            let signer = flakySigner(1);
            let h = makePublisher({ signer: signer, cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 25 } });
            await h.p.start();
            // Window 0 is closed by construction: window 1 holds a higher round.
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            await h.p._assembleWindow(0);
            expect(h.broadcasts, 'the first attempt misses quorum').to.have.length(0);

            await waitUntil(() => h.broadcasts.length === 1, 3000);
            expect(signer.calls).to.have.length(2);
            // The re-proposal is the SAME window over the SAME rounds: a retry that
            // proposed different content would be a second honest batch, not a retry.
            expect(signer.calls[1].first).to.equal(signer.calls[0].first);
            expect(signer.calls[1].last).to.equal(signer.calls[0].last);
            expect(signer.calls[1].rounds).to.deep.equal(signer.calls[0].rounds);
            expect(h.p._assembledWindows.has(0), 'memoized once it publishes').to.equal(true);
        };

const testCase2 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 25 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);
            let after = h.signer.calls.length;

            for (let i = 0; i < 6; i++) h.p.sweepBufferCatchup();
            await h.p._windowChain;
            expect(h.signer.calls).to.have.length(after);
            expect(h.broadcasts).to.have.length(1);
        };

const testCase3 = async function () {
            let h = makePublisher();
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            expect(h.p.pendingCatchupWindows()).to.deep.equal([0]);
        };

const testCase4 = async function () {
            let h = makePublisher({ signerOpts: { met: false } });
            await h.p.start();
            // Ten closed windows plus one still open (window 10 is missing round 65).
            for (let r = 0; r < 65; r++) h.p._buffer.set(r, bufferedFixture(r));

            expect(h.p.pendingCatchupWindows()).to.have.length(10);
            expect(h.p.sweepBufferCatchup()).to.equal(4);
            await h.p._windowChain;

            let asked = h.signer.calls.map(c => c.first);
            expect(asked, 'oldest four windows, in order').to.deep.equal([0, 6, 12, 18]);
            expect(logs.warn.join('\n')).to.match(
                /10 closed window\(s\) are still buffered and unpublished; re-proposing 4 of them this sweep \(from window 0, resuming at 4 next sweep\)/);
        };

const testCase5 = async function () {
            let h = makePublisher({ signerOpts: { met: false } });
            await h.p.start();
            for (let r = 0; r < 65; r++) h.p._buffer.set(r, bufferedFixture(r));
            // Windows 0..5 were followed or published earlier in this process. Counting
            // them against the per-sweep cap would spend every slot on windows that need
            // nothing and never reach the one that timed out.
            for (let w = 0; w <= 5; w++) h.p.noteAssembled(w);

            expect(h.p.pendingCatchupWindows()).to.deep.equal([6, 7, 8, 9]);
            h.p.sweepBufferCatchup();
            await h.p._windowChain;
            expect(h.signer.calls.map(c => c.first)).to.deep.equal([36, 42, 48, 54]);
        };

const testCase6 = async function () {
            let signer = flakySigner(1);
            let h = makePublisher({ signer: signer });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            await h.p._assembleWindow(0);
            expect(h.p.getStats().batchWindowsAwaitingRetry).to.equal(1);
            expect(h.p.getStats().batchCatchupSweeps).to.equal(0);

            h.p.sweepBufferCatchup();
            await h.p._windowChain;
            expect(h.p.getStats().batchWindowsAwaitingRetry).to.equal(0);
            expect(h.p.getStats().batchCatchupSweeps).to.equal(1);
        };

const testCase7 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 25 } });
            await h.p.start();
            expect(h.p._catchupSweepTimer).to.not.equal(null);
            h.p.stop();
            expect(h.p._catchupSweepTimer).to.equal(null);
        };

// ─────────────────────────── the backlog has to actually drain
//
// Fleet evidence showed every validator logging "697 closed window(s) are
// still buffered and unpublished; re-proposing 4 of them this sweep (oldest
// first, from window 10)" once an hour, for ever. Three separate properties
// made that undrainable and each one is asserted below: the sweep always spent
// its slots on the SAME oldest four, it idled a full hour between sweeps
// whatever the depth of the backlog, and a window the federation would not
// co-sign ([32,32], [46,47]) kept its slot for the life of the process.
// These observations cover the cursor, pacing, and retirement conditions below.
const testCase8 = async function () {
                let h = makePublisher({ signerOpts: { met: false } });
                await h.p.start();
                for (let r = 0; r < 65; r++) h.p._buffer.set(r, bufferedFixture(r));
                expect(h.p.pendingCatchupWindows()).to.have.length(10);

                let sweeps = [];
                for (let i = 0; i < 3; i++) {
                    let before = h.signer.calls.length;
                    h.p.sweepBufferCatchup();
                    await h.p._windowChain;
                    sweeps.push(h.signer.calls.slice(before).map(c => c.first));
                }
                // Nothing lands (met:false), so all ten windows stay pending: the only
                // thing that can move the proposals along is the cursor.
                expect(sweeps[0]).to.deep.equal([0, 6, 12, 18]);
                expect(sweeps[1], 'the second sweep proposes windows the first never reached')
                    .to.deep.equal([24, 30, 36, 42]);
                expect(sweeps[2], 'and wraps once every pending window has had a turn')
                    .to.deep.equal([48, 54, 0, 6]);
            };

const testCase9 = async function () {
                let h = makePublisher({ signerOpts: { met: false },
                    cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 2, ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: 0 } });
                await h.p.start();
                // One closed window (0) plus an open one, so the cursor cannot hide a
                // window that is simply never reached behind one that is retired.
                for (let r = 0; r < 7; r++) h.p._buffer.set(r, bufferedFixture(r));

                for (let i = 0; i < 3; i++) { h.p.sweepBufferCatchup(); await h.p._windowChain; }

                expect(h.signer.calls.map(c => c.first), 'proposed twice, then retired')
                    .to.deep.equal([0, 0]);
                expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(1);
                expect(h.p.pendingCatchupWindows(), 'no longer holds a slot').to.deep.equal([]);
                expect(logs.warn.join('\n')).to.match(
                    /window \[0,5\] has failed 2 batch-signing round\(s\).*retired from the catch-up sweep/);
                // Retiring is a memo entry, never a deletion: the rounds are still here.
                expect(h.p._buffer.size).to.equal(7);
            };

const testCase10 = async function () {
                let h = makePublisher({ signerOpts: { met: false },
                    cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 2,
                           ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: 3600000 } });
                await h.p.start();
                for (let r = 0; r < 7; r++) h.p._buffer.set(r, bufferedFixture(r));

                for (let i = 0; i < 5; i++) { h.p.sweepBufferCatchup(); await h.p._windowChain; }

                expect(h.signer.calls.map(c => c.first)).to.deep.equal([0, 0, 0, 0, 0]);
                expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(0);
                expect(h.p.pendingCatchupWindows()).to.deep.equal([0]);
            };

const testCase11 = async function () {
                let h = makePublisher({ signerOpts: { met: false },
                    cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 0, ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: 0 } });
                await h.p.start();
                for (let r = 0; r < 7; r++) h.p._buffer.set(r, bufferedFixture(r));

                for (let i = 0; i < 5; i++) { h.p.sweepBufferCatchup(); await h.p._windowChain; }

                expect(h.signer.calls).to.have.length(5);
                expect(h.p.getStats().batchCatchupRetiredWindows).to.equal(0);
            };

const testCase12 = async function () {
                let signer = flakySigner(1);
                let h = makePublisher({ signer: signer,
                    cfg: { ORACLE_BATCH_CATCHUP_MAX_ATTEMPTS: 2, ORACLE_BATCH_CATCHUP_RETIRE_AFTER_MS: 0 } });
                await h.p.start();
                for (let r = 0; r < 7; r++) h.p._buffer.set(r, bufferedFixture(r));

                h.p.sweepBufferCatchup();          // attempt 1: misses quorum
                await h.p._windowChain;
                h.p.sweepBufferCatchup();          // attempt 2: lands
                await h.p._windowChain;

                expect(h.broadcasts).to.have.length(1);
                expect(h.p.getStats().batchCatchupRetiredWindows,
                    'a window that published is not a window that was given up on').to.equal(0);
                expect(h.p._catchupAttempts.has(0)).to.equal(false);
            };

const testCase13 = async function () {
                this.timeout(10000);
                // The hourly idle IS the structural stall: at four windows an hour these
                // twenty windows need five hours, and the fleet's 697 need seven months.
                let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000,
                                               ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 5 } });
                await h.p.start();
                for (let r = 0; r < 125; r++) h.p._buffer.set(r, bufferedFixture(r));
                expect(h.p.pendingCatchupWindows()).to.have.length(20);

                await h.p.runCatchupSweepTick();
                // Four per sweep is unchanged; what changed is that the next sweep is
                // seconds away while a backlog remains, not an hour.
                expect(h.broadcasts.length, 'one sweep still publishes at most four').to.equal(4);
                await waitUntil(() => h.p.pendingCatchupWindows().length <= 4, 3000);
                expect(h.broadcasts.length).to.be.at.least(16);
            };

const testCase14 = async function () {
                this.timeout(10000);
                let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000,
                                               ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 1 } });
                await h.p.start();
                for (let r = 0; r < 125; r++) h.p._buffer.set(r, bufferedFixture(r));

                // Count how many assemblies are in flight at once across the whole drain.
                let inFlight = 0, peak = 0;
                let real = h.p._assembleWindow.bind(h.p);
                sinon.stub(h.p, '_assembleWindow').callsFake(async (w, o) => {
                    inFlight++; peak = Math.max(peak, inFlight);
                    try { return await real(w, o); } finally { inFlight--; }
                });

                await h.p.runCatchupSweepTick();
                await waitUntil(() => h.p.pendingCatchupWindows().length <= 4, 3000);
                expect(peak, 'assemblies are serialized; the cadence does not change that').to.equal(1);
            };

const testCase15 = async function () {
                let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000,
                                               ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 5 } });
                await h.p.start();
                for (let r = 0; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));   // 2 closed windows

                let armed = [];
                sinon.stub(h.p, 'armCatchupSweep').callsFake((ms) => armed.push(ms));
                await h.p.runCatchupSweepTick();

                expect(h.broadcasts).to.have.length(2);
                expect(armed, 'nothing left to catch up on: wait the full interval')
                    .to.deep.equal([3600000]);
            };

const testCase16 = async function () {
                let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000,
                                               ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 5 } });
                await h.p.start();
                for (let r = 0; r < 125; r++) h.p._buffer.set(r, bufferedFixture(r));

                let tick = h.p.runCatchupSweepTick();
                h.p.stop();
                await tick;
                expect(h.p._catchupSweepTimer).to.equal(null);
            };

const testCase17 = function () {
                let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 1000,
                                               ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 60000 } });
                expect(h.p.batchCatchupBacklogIntervalMs).to.equal(1000);
            };

function registerSuite2() {
    it('spends each sweep on the NEXT windows, so a stuck head cannot own every slot', testCase8);
    it('retires a window that has failed long enough, and stops spending slots on it', testCase9);
    it('will not retire on attempt count alone: a fast burst of failures is a peer reboot', testCase10);
    it('never retires when retirement is switched off', testCase11);
    it('forgets the failure record as soon as a window assembles', testCase12);
    it('comes back at the backlog cadence instead of idling an hour, and walks the whole backlog', testCase13);
    it('holds the per-sweep bound even at the backlog cadence, so the live window is never queued behind more than four', testCase14);
    it('drops back to the idle cadence once the backlog is gone', testCase15);
    it('never re-arms after stop(), even when the tick was already running', testCase16);
    it('never lets a backlog cadence be SLOWER than the idle one', testCase17);
}

function registerSuite1() {
    it('re-proposes a window that missed quorum, with byte-identical content, until it lands', testCase1);
    it('stops asking once the window is assembled, so a healthy rail never re-signs', testCase2);
    it('leaves the newest window alone: it may still be open', testCase3);
    it('re-proposes at most four windows per sweep, oldest first, and says how many are waiting', testCase4);
    it('spends its four slots on windows that still need one, not on windows already assembled', testCase5);
    it('reports the stuck backlog through getStats, and it falls as windows land', testCase6);
    it('stop() releases the sweep timer', testCase7);
    describe('draining a backlog', registerSuite2);
}

function registerOuterSuite3() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('the recurring catch-up sweep', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite3);
