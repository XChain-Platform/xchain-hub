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

// ───────────────────────────────────── publisher role and publish history

// Two hubs that are nothing alike produce byte-identical status without these
// fields: one whose publisher set will not resolve, which is a wedge, and one
// that is simply not in that set, where nothing is wrong at all. Both leave the
// rank state null, because it is written only after the membership test passes,
// so every counter downstream of it reads null for both. These two fields tell
// them apart and let a backlog rail speak for a stuck publisher without speaking
// for every node that was never going to publish.
const testCase1 = function () {
            let h = makePublisher();
            let s = h.p.getStats();
            expect(s.publisherRole).to.equal('unknown');
            expect(s.everPublished).to.equal(false);
        };

const testCase2 = async function () {
            // The signing round never meets quorum, so the window is assembled, elected
            // and then reaches no wire. This is the stuck publisher before its first
            // publication, which had no representation in the payload at all.
            let h = makePublisher({ publishers: [ME, PEER1], signerOpts: { met: false } });
            await h.p.start();
            for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p.assembleWindow(0);   // ME is rank 0, so window 0 is its own

            let s = h.p.getStats();
            expect(s.publisherRole).to.equal('in_set');
            expect(s.everPublished).to.equal(false);
            expect(h.broadcasts).to.have.length(0);
        };

const testCase3 = async function () {
            let h = makePublisher({ publishers: [PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p.assembleWindow(0);

            let s = h.p.getStats();
            expect(s.publisherRole).to.equal('not_in_set');
            expect(s.everPublished).to.equal(false);
            // The older reading, kept as a control. It is null here and
            // null for a wedged hub alike, which is exactly the ambiguity above resolves.
            expect(s.publisherCount).to.equal(null);
            expect(s.lastRankRound).to.equal(null);
            expect(h.signer.calls).to.have.length(0);
        };

const testCase4 = async function () {
            let h = makePublisher({ capabilitySnapshot: {
                getSnapshot: sinon.stub().resolves(null), getWeightSnapshot: sinon.stub().resolves(null) } });
            await h.p.start();
            for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p.assembleWindow(0);

            let s = h.p.getStats();
            expect(s.publisherRole).to.equal('set_unresolved');
            expect(s.everPublished).to.equal(false);
            expect(s.publisherCount).to.equal(null);
        };

const testCase5 = async function () {
            let dark = false;
            let resolve = async () => (dark ? null : { validators: [{ pubkey: ME }] });
            let h = makePublisher({
                signerOpts: { met: false },
                capabilitySnapshot: {
                    getSnapshot:       sinon.stub().callsFake(resolve),
                    getWeightSnapshot: sinon.stub().callsFake(resolve),
                }
            });
            await h.p.start();
            for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p.assembleWindow(0);
            expect(h.p.getStats().publisherRole).to.equal('in_set');

            dark = true;
            await h.p.assembleWindow(1);
            expect(h.p.getStats().publisherRole, 'the last successful election is history, not the answer')
                .to.equal('set_unresolved');
        };

const testCase6 = async function () {
            let members = [ME, PEER1];
            let resolve = async () => ({ validators: members.map(p => ({ pubkey: p })) });
            let h = makePublisher({
                signerOpts: { met: false },
                capabilitySnapshot: {
                    getSnapshot:       sinon.stub().callsFake(resolve),
                    getWeightSnapshot: sinon.stub().callsFake(resolve),
                }
            });
            await h.p.start();
            for (let r = 0; r < 24; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p.assembleWindow(0);
            expect(h.p.getStats().publisherRole).to.equal('in_set');

            members = [PEER1, PEER2];
            await h.p.assembleWindow(2);
            expect(h.p.getStats().publisherRole).to.equal('not_in_set');
        };

const testCase7 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
            await waitUntil(() => h.broadcasts.length > 0,
                { label: 'window 0 to close and its wire to broadcast' });
            await h.p._windowChain;

            let s = h.p.getStats();
            expect(s.everPublished).to.equal(true);
            expect(s.publisherRole).to.equal('in_set');
        };

const testCase8 = async function () {
            // The confirmed marker row is what survives a restart, and startup already
            // reads those rows for the at-most-once guard, so the honest answer costs no
            // second query. The monitor's batch-backlog rail gates on lastPublishedRound,
            // so a null there silences the rail for a publisher of months standing.
            let db = makeDb({ markers: { 41: { round: 41, txid: 'tx-41', sent_at: '2026-08-26 12:00:00' } } });
            let h = makePublisher({ db: db });
            await h.p.start();

            let s = h.p.getStats();
            expect(s.lastPublishedRound, 'the restarted hub reports what it put on chain').to.equal(41);
            expect(s.lastPublishedTxid).to.equal('tx-41');
            expect(s.everPublished, 'a publisher of months standing must not read as one that never published')
                .to.equal(true);
            // No election has run in the new process, so the role is unknown rather than
            // a stale claim carried across the restart.
            expect(s.publisherRole).to.equal('unknown');
        };

const testCase9 = async function () {
            // sent_at NULL is a round whose on-chain state is unknown after a crash. It
            // is quarantined and never auto-rebroadcast, and it is not evidence that
            // anything this hub built ever landed.
            let db = makeDb({ markers: { 41: { round: 41, txid: null, sent_at: null } } });
            let h = makePublisher({ db: db });
            await h.p.start();

            expect(h.p.getStats().everPublished).to.equal(false);
            expect(h.p.getStats().lastPublishedRound, 'an unverified round is not a publication')
                .to.equal(null);
        };

function registerSuite1() {
    it('is honestly unknown before any window election has run', testCase1);
    it('names in_set for a hub that elected into the set and has published nothing yet', testCase2);
    it('names not_in_set for a hub the set resolved without, where the counters are null', testCase3);
    it('names set_unresolved while the capability snapshot will not resolve', testCase4);
    it('lets a dark snapshot outrank a remembered role, because membership stops being knowable', testCase5);
    it('re-derives the role per window, so a hub dropped from the set stops claiming in_set', testCase6);
    it('reports everPublished once a window has actually reached a wire', testCase7);
    it('still reports the last published round and everPublished after a restart', testCase8);
    it('does not read an intent-only marker as a publication', testCase9);
}

function registerOuterSuite16() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('publisher role and publish history', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite16);
