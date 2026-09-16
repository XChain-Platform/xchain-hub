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

// ───────────────────────────────────── a window closed while the hub was down

// The grace timer lives only in memory, so a restart inside the grace drops it,
// and the boot catch-up skips the HIGHEST buffered window on the theory that it
// might still be open. A window that closes and then loses its timer to a restart
// is reachable by neither half. Window 4 was left unassembled on all five testnet
// validators after their hubs were recreated. That makes this a durable boot-time
// recovery concern as well as an in-memory timer concern.

// A second publisher over the SAME hub config, and therefore the same queue and
// buffer files: what a process restart looks like to this class. The first is
// stopped so its timers cannot fire into the second one's assertions.
function restart(h, cfg) {
            h.p.stop();
            Object.assign(h.hub.p2pConfig, cfg || {});
            let second = new OraclePublisher(h.hub);
            second.setBroadcastHook(async (payload) => {
                h.broadcasts.push(payload);
                return { txid: 'tx-' + h.broadcasts.length };
            });
            instances.push(second);
            h.p = second;
            return second;
        }

const testCase1 = async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(h.broadcasts, 'nothing publishes inside the grace').to.have.length(0);

            let second = restart(h, { ORACLE_BATCH_GRACE_MS: 1 });
            await second.start();
            await waitUntil(() => h.broadcasts.length > 0,
                { label: 'the restarted hub to catch up window 0 and broadcast it' });
            await second._windowChain;

            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 5, count: 6 });
        };

const testCase2 = async function () {
            let h = makePublisher();
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            expect(h.p.pendingCatchupWindows(), 'window 0 is complete').to.deep.equal([0]);

            h.p._buffer.set(6, bufferedFixture(6));
            expect(h.p.pendingCatchupWindows(), 'window 1 holds one round and may still fill')
                .to.deep.equal([0]);
        };

const testCase3 = async function () {
            // The grace is what lets a straggler round land in the wire; a sweep that
            // assembled the window early would publish without it.
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

            expect(h.p._windows.get(0).timer, 'the live timer owns window 0').to.not.equal(null);
            expect(h.p.pendingCatchupWindows()).to.deep.equal([]);
            expect(h.p.sweepBufferCatchup()).to.equal(0);
            expect(h.signer.calls).to.have.length(0);
        };

const testCase4 = async function () {
            // Window 0's last slot was skipped, so only a higher round can close it, and
            // that path walks the in-memory window map a restart had emptied.
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
            await h.p.start();
            for (let r of [0, 1, 2, 3, 4]) await h.p.onRoundFinalized(roundFixture(r));

            let second = restart(h, { ORACLE_BATCH_GRACE_MS: 1 });
            await second.start();
            expect(second._windows.has(0), 'the buffered window is tracked again').to.equal(true);
            expect(second._windows.get(0).timer, 'but not armed: it may still fill').to.equal(null);

            await second.onRoundFinalized(roundFixture(6));
            await waitUntil(() => h.signer.calls.length > 0,
                { label: 'window 1 arriving to close window 0 on the restarted hub' });
            await second._windowChain;

            expect(h.signer.calls[0]).to.include({ first: 0, last: 4, count: 5 });
        };

function registerSuite1() {
    it('publishes the highest buffered window when its own last round already closed it', testCase1);
    it('counts the highest buffered window as closed only once its last slot is buffered', testCase2);
    it('never pre-empts a grace timer that is still pending', testCase3);
    it('re-registers the buffered window a restart dropped, so a higher round still closes it', testCase4);
}

function registerOuterSuite4() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('a window closed while the hub was down', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite4);
