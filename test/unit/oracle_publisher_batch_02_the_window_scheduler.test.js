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

// ───────────────────────────────────── the window scheduler

const testCase1 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
            await waitUntil(() => h.broadcasts.length > 0,
                { label: 'the grace timer to close window 0 and its wire to broadcast' });
            await h.p._windowChain;

            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 5, count: 6 });
            expect(h.broadcasts).to.have.length(1);
            expect(h.broadcasts[0].split('|').slice(0, 2)).to.deep.equal(['PRICE', '0']);
        };

const testCase2 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r of [0, 1, 2, 3, 4]) await h.p.onRoundFinalized(roundFixture(r));  // 5 skipped
            expect(h.signer.calls).to.have.length(0);

            await h.p.onRoundFinalized(roundFixture(6));   // window 1 opens, window 0 is closed
            await waitUntil(() => h.signer.calls.length > 0,
                { label: 'window 0 to close on the higher window\'s arrival and be proposed' });
            await h.p._windowChain;

            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 4, count: 5 });
        };

const testCase3 = async function () {
            // ME sorts first of the three ('aa..' < 'bb..' < 'cc..'), so rank 0 leads
            // windows 0, 3, 6... and defers 1 and 2.
            let h = makePublisher({ publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p._assembleWindow(1);
            expect(h.signer.calls).to.have.length(0);
            expect(h.p.getStats().isLeader).to.equal(false);

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(1);
            expect(h.p.getStats().isLeader).to.equal(true);
        };

// Rank-staggered takeover. Before this existed, a window whose leader never
// broadcast stayed unpublished forever, however healthy the other hubs were.

// ME is rank 0 of three, so window 1 belongs to PEER1 and ME is one step
// behind it. `landed` seeds the proof that this hub sees batches land.
// start() hydrates the buffer from disk, so the rounds are seeded AFTER it.
async function followerOf(opts) {
                opts = opts || {};
                let snapshots = [];
                if (opts.landed) snapshots.push({ round_number: opts.landed, batch: true, status: 'finalized' });
                for (let r = 0; r < 12; r++) snapshots.push({ round_number: r, status: 'finalized' });
                let h = makePublisher({
                    publishers: [ME, PEER1, PEER2],
                    db:  makeDb({ snapshots: snapshots }),
                    cfg: Object.assign({ ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '2' }, opts.cfg || {})
                });
                await h.p.start();
                for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
                return h;
            }

const testCase4 = async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(1);
                expect(h.broadcasts).to.have.length(0);
                expect(h.p._takeoverTimers.has(1)).to.equal(true);
                expect(h.p.getStats().takeoverPending).to.equal(1);
            };

const testCase5 = async function () {
                let h = await followerOf({ landed: 99, cfg: { ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '0' } });
                await h.p._assembleWindow(1);
                expect(h.p._takeoverTimers.size).to.equal(0);
                expect(h.p.getStats().takeoverArmed).to.equal(false);
            };

const testCase6 = async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(1);

                let took = await h.p.attemptTakeover(1);
                expect(took).to.equal(true);
                expect(h.broadcasts).to.have.length(1);
                expect(h.p.getStats().takeoverPublished).to.equal(1);
                // The wire is a batch over window 1's rounds, exactly what the leader
                // would have sent: same rounds, same canonical shape.
                let entry = readJsonl(h.queuePath).concat(h.broadcasts);
                expect(String(h.broadcasts[0].wire || h.broadcasts[0])).to.match(/^PRICE\|0\|/);
                expect(entry.length).to.be.greaterThan(0);
            };

const testCase7 = async function () {
                // Window 1 covers rounds 6..11; seeing one of them land is proof.
                let h = await followerOf({ landed: 7 });
                let took = await h.p.attemptTakeover(1);
                expect(took).to.equal(false);
                expect(h.broadcasts).to.have.length(0);
            };

// The safety property: a hub that has never seen a batch land cannot tell
// a dark leader from its own deaf feed, and must never pay DOGE on that
// ambiguity.
const testCase8 = async function () {
                let h = await followerOf();   // no landed row at all
                await h.p.start();
                await h.p._assembleWindow(1);
                let took = await h.p.attemptTakeover(1);
                expect(took).to.equal(false);
                expect(h.broadcasts).to.have.length(0);
                expect(h.p.getStats().takeoverArmed).to.equal(false);
            };

const testCase9 = async function () {
                let h = await followerOf({ landed: 99 });
                await h.p.observationFeedProven();          // prove the feed first
                h.hub.db.doQuery = sinon.stub().rejects(new Error('hub db down'));
                let took = await h.p.attemptTakeover(1);
                expect(took).to.equal(false);
                expect(h.broadcasts).to.have.length(0);
            };

const testCase10 = async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(0);                // ME leads window 0
                expect(h.p._takeoverTimers.has(0)).to.equal(false);
            };

// price_snapshots is a MINED view, so "not on chain" cannot
// separate a leader that never broadcast from one whose tx is sitting
// unmined in the DOGE mempool. Stepping in over the second pays the fee
// twice for a window already in flight, so the follower holds off until the
// ambiguity cooldown proves that tx never landed.

// ORACLE_PUBLISH_BLOCK_MS is unset in these fixtures, so the default
// cooldown is failoverWindowBlocks (2) x APPROX_BTC_BLOCK_MS.
const COOLDOWN_MS = 2 * 600000;

const testCase11 = async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    h.p._takeoverTimers.forEach(t => clearTimeout(t));
                    h.p._takeoverTimers.clear();
                    // The leader asked us to co-sign window 1 moments ago, which is the
                    // last thing it needed before broadcasting.
                    h.signer.coSignedAt = sinon.stub().returns(Date.now() - 1000);

                    let took = await h.p.attemptTakeover(1);

                    expect(took).to.equal(false);
                    expect(h.broadcasts).to.have.length(0);
                    expect(h.p.getStats().takeoverDeferred).to.equal(1);
                    expect(h.p.getStats().takeoverAmbiguousCooldownMs).to.equal(COOLDOWN_MS);
                    expect(logs.warn.join('\n')).to.match(/deferring takeover of window 1/);
                    // The signer is asked about the window's ROUND RANGE, not its index.
                    expect(h.signer.coSignedAt.firstCall.args).to.deep.equal([6, 11]);
                };

const testCase12 = async function () {
                    let h = await followerOf({ landed: 99 });
                    h.signer.coSignedAt = () => Date.now() - 1000;

                    expect(await h.p.attemptTakeover(1)).to.equal(false);
                    // Without the re-arm this window would be dropped by this hub
                    // forever: the timer that fired is already gone.
                    expect(h.p._takeoverTimers.has(1)).to.equal(true);
                    expect(h.p.getStats().takeoverPending).to.equal(1);
                };

const testCase13 = async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    // Co-signed a full cooldown ago and still nothing mined: whatever
                    // the leader sent is provably gone.
                    h.signer.coSignedAt = () => Date.now() - COOLDOWN_MS - 1;

                    let took = await h.p.attemptTakeover(1);

                    expect(took).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                    expect(h.p.getStats().takeoverDeferred).to.equal(0);
                };

const testCase14 = async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    // A leader that never asked for a signature never assembled a batch,
                    // so it cannot have one in flight: that is genuine silence.
                    h.signer.coSignedAt = () => null;

                    expect(await h.p.attemptTakeover(1)).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                };

const testCase15 = async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    h.p.noteAmbiguousWindow(1);

                    expect(await h.p.attemptTakeover(1)).to.equal(false);
                    expect(h.broadcasts).to.have.length(0);
                    expect(h.p.getStats().takeoverDeferred).to.equal(1);
                };

const testCase16 = async function () {
                    let h = await followerOf({ landed: 99, cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
                    h.p.setBroadcastHook(async () => {
                        let e = new Error('socket hang up');
                        e.code = 'ECONNRESET';
                        throw e;
                    });
                    h.signer.coSignedAt = () => null;

                    // ME leads window 0, so this is a plain leader publish that fails
                    // ambiguously; the takeover armed against the SAME window must then
                    // not re-broadcast over it.
                    await h.p._assembleWindow(0);
                    expect(readJsonl(h.deadPath)).to.have.length(1);
                    expect(h.p._ambiguousWindows.has(0)).to.equal(true);

                    expect(await h.p.attemptTakeover(0)).to.equal(false);
                    expect(h.p.getStats().takeoverDeferred).to.equal(1);
                };

const testCase17 = async function () {
                    let h = await followerOf({ landed: 99,
                        cfg: { ORACLE_TAKEOVER_AMBIGUOUS_COOLDOWN_MS: '0' } });
                    await h.p._assembleWindow(1);
                    h.signer.coSignedAt = () => Date.now();

                    expect(h.p.getStats().takeoverAmbiguousCooldownMs).to.equal(0);
                    expect(await h.p.attemptTakeover(1)).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                };

const testCase18 = async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    delete h.signer.coSignedAt;

                    expect(await h.p.attemptTakeover(1)).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                };

const testCase19 = async function () {
                    let h = await followerOf({ landed: 99 });
                    h.hub.oracleBatchSigner = null;
                    expect(h.p.takeoverAmbiguityAt(1, 6, 11)).to.equal(null);
                    expect(h.p._ownedBatchSigner).to.equal(null);
                };

function registerSuite3() {
    it('defers takeover while a batch this hub co-signed may still be in flight', testCase11);
    it('re-arms the deferred takeover rather than cancelling it', testCase12);
    it('takes over once the cooldown has elapsed with the window STILL off chain', testCase13);
    it('steps in at once when this hub never co-signed the window', testCase14);
    it('defers on an ambiguous send of this hub\'s OWN for the same window', testCase15);
    it('records the window when a batch wire dead-letters on an ambiguous send', testCase16);
    it('is switched off by a zero cooldown, restoring the prior behaviour', testCase17);
    it('survives a signer with no co-signature memo at all', testCase18);
    it('never CONSTRUCTS a signer just to answer the ambiguity question', testCase19);
}

const testCase20 = async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(1);
                expect(h.p._takeoverTimers.size).to.equal(1);
                h.p.stop();
                expect(h.p._takeoverTimers.size).to.equal(0);
            };

function registerSuite2() {
    it('arms a timer for a window this hub does not lead, staggered by distance from the leader', testCase4);
    it('arms NOTHING when no failover window is configured (the default)', testCase5);
    it('publishes the identical window when the leader stayed silent', testCase6);
    it('declines when the leader already published, and prunes instead', testCase7);
    it('declines every takeover when no batch has EVER been observed on this hub', testCase8);
    it('declines when the hub DB cannot answer whether the window is on chain', testCase9);
    it('never schedules a takeover of its OWN window', testCase10);
    describe('the ambiguous-send cooldown', registerSuite3);
    it('stop() clears pending takeover timers', testCase20);
}

const testCase21 = async function () {
            let h = makePublisher({ signerOpts: { met: false, timeouts: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(0);
            expect(readJsonl(h.queuePath)).to.have.length(0);
            // Not memoized, so a later attempt on this hub can re-run the round.
            expect(h.p._assembledWindows.has(0)).to.equal(false);
            expect(h.p.getStats().batchSignTimeouts).to.equal(1);
        };

function registerSuite1() {
    it('assembles and publishes ONE wire a grace after the window\'s last round closes it', testCase1);
    it('closes a window whose LAST slot was skipped, when a higher window\'s round arrives', testCase2);
    it('elects the window leader as windowIndex % publisherCount and defers otherwise', testCase3);
    describe('takeover of a silent leader', registerSuite2);
    it('publishes NOTHING when the signing round misses quorum, and leaves the window re-proposable', testCase21);
}

function registerOuterSuite2() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('the window scheduler', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite2);
