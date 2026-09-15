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

// ───────────────────────────────────── knobs (D24)

const testCase1 = function () {
            let a = makePublisher({ fleetCadence: true });
            // 1800s bound - 300s grace - 300s landing reserve = 1200s of budget, which
            // is two 600s rounds. NOT the prior 6: that published hourly against a
            // half-hourly staleness gate.
            expect(a.p.batchWindowRounds).to.equal(2);
            expect(a.p.batchWindowRoundsCeiling).to.equal(2);
            expect(a.p.batchGraceMs).to.equal(300000);
            expect(a.p.batchBufferMaxRounds).to.equal(4032);

            let b = makePublisher({ fleetCadence: true,
                                    cfg: { ORACLE_BATCH_GRACE_MS: 1000,
                                           ORACLE_BATCH_BUFFER_MAX_ROUNDS: 50 } });
            expect(b.p.batchGraceMs).to.equal(1000);
            expect(b.p.batchBufferMaxRounds).to.equal(50);
        };

const testCase2 = function () {
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_BATCH_WINDOW_ROUNDS: 1 } });
            expect(h.p.batchWindowRounds).to.equal(1);
            expect(logs.warn.join('\n')).to.not.contain('ORACLE_BATCH_WINDOW_ROUNDS');
        };

const testCase3 = function () {
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_BATCH_WINDOW_ROUNDS: 12 } });
            expect(h.p.batchWindowRounds).to.equal(2);
            let warn = logs.warn.join('\n');
            expect(warn).to.contain('ORACLE_BATCH_WINDOW_ROUNDS=12');
            expect(warn).to.contain('1800s fee-price staleness bound');
            expect(warn).to.contain('clamping to 2');
        };

const testCase4 = function () {
            // A shorter grace and a shorter landing reserve free budget for more rounds
            // per wire: at a 300s round interval, (1800 - 60 - 60) / 300 buys 5.
            let h = makePublisher({ fleetCadence: true,
                                    cfg: { ORACLE_ROUND_INTERVAL: 300000,
                                           ORACLE_BATCH_GRACE_MS: 60000,
                                           ORACLE_BATCH_LANDING_RESERVE_MS: 60000 } });
            expect(h.p.batchWindowRoundsCeiling).to.equal(5);
            expect(h.p.batchWindowRounds).to.equal(5);
        };

const testCase5 = function () {
            // An hour-long round interval cannot fit a 1800s bound at any window size.
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_ROUND_INTERVAL: 3600000 } });
            expect(h.p.batchWindowRounds).to.equal(1);
            expect(logs.warn.join('\n')).to.contain('no batch window fits');
        };

const testCase6 = function () {
            let h = makePublisher({ fleetCadence: true });
            let s = h.p.getStats();
            expect(s.batchWindowRounds).to.equal(2);
            expect(s.batchWindowRoundsCeiling).to.equal(2);
            expect(s.batchCadenceSeconds).to.equal(1200);
            expect(s.oracleMaxPriceAgeSeconds).to.equal(1800);
            // 2 * 600 + 300 grace + 300 landing reserve. The reserve is budgeted at 300s
            // against a measured ~180s, so the peak an operator actually sees sits below
            // this figure; it must never sit above the bound.
            expect(s.batchWorstCaseSnapshotAgeSeconds).to.equal(1800);
            expect(s.batchWorstCaseSnapshotAgeSeconds).to.be.at.most(s.oracleMaxPriceAgeSeconds);
        };

const testCase7 = function () {
            let h = makePublisher();
            expect(h.p.bufferPath).to.equal(h.bufferPath);
            expect(path.dirname(h.p.bufferPath)).to.equal(path.dirname(h.p.deadLetterPath));
        };

function registerSuite1() {
    it('defaults the window to the cadence ceiling, keeps 300000 / 4032, and reads ' +
           'grace and buffer overrides from p2pConfig', testCase1);
    it('honours a window at or below the ceiling', testCase2);
    it('clamps a window that would outrun the fee-price staleness bound, and says so', testCase3);
    it('re-derives the ceiling when the grace or the round interval moves', testCase4);
    it('publishes one round per batch, loudly, when no window fits the bound', testCase5);
    it('reports the cadence against the bound in getStats', testCase6);
    it('puts the buffer file beside the queue and the dead-letter file', testCase7);
}

function registerOuterSuite13() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('knobs', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite13);
