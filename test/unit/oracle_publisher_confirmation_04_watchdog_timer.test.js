'use strict';

const {
    fs,
    os,
    path,
    sinon,
    expect,
    OraclePublisher,
    waitUntil,
    ME,
    ADDR,
    utxo,
    makeEncoder,
    queueEntry,
    makePublisher,
    seedQueue,
    readJsonl,
    cleanupPublisherConfirmation
} = require('./oracle_publisher_confirmation.test.js');

let logs;

const testCase1 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 5 } });
            await h.p.start();

            expect(h.p._confirmTimer).to.not.equal(null);
            expect(h.p._confirmTimer.hasRef()).to.be.false;

            h.p.stop();
            expect(h.p._confirmTimer).to.equal(null);
        };

const testCase2 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 5 } });
            await h.p.start();
            h.p.notePendingConfirmation(5, 'tx1');
            h.encoder.serve([utxo('tx1', 1)]);

            await waitUntil(() => h.p.getStats().unconfirmedPublishes === 0,
                            { label: 'the watchdog tick to clear tx1' });
            expect(h.p.getStats().confirmedPublishes).to.equal(1);
        };

const testCase3 = async function () {
            let h = makePublisher({ cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 0 } });
            await h.p.start();

            expect(h.p.confirmCheckIntervalMs).to.equal(0);
            expect(h.p._confirmTimer).to.equal(null);
        };

const testCase4 = async function () {
            let h = makePublisher({ encoder: null });
            await h.p.start();
            expect(h.p._confirmTimer).to.equal(null);
        };

const testCase5 = function () {
            let a = makePublisher();
            expect(a.p.confirmCheckIntervalMs).to.equal(300000);
            expect(a.p.confirmStaleMs).to.equal(1800000);
            expect(a.p.getStats().confirmationCheckIntervalMs).to.equal(300000);

            let b = makePublisher({ cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 60000,
                                           ORACLE_PUBLISH_CONFIRM_STALE_MS: 120000 } });
            expect(b.p.confirmCheckIntervalMs).to.equal(60000);
            expect(b.p.confirmStaleMs).to.equal(120000);
        };

function registerSuite1() {
    it('arms an unref\'d interval on start and releases it on stop', testCase1);
    it('clears a confirmation on its own schedule', testCase2);
    it('stays disarmed when the cadence is set to 0', testCase3);
    it('stays disarmed when nothing could be read (no encoder or no address)', testCase4);
    it('defaults to a 5-minute cadence and a 30-minute stale threshold', testCase5);
}

function registerOuterSuite4() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherConfirmation();
    });
    // The watchdog timer.
    describe('watchdog timer', registerSuite1);
}

describe('OraclePublisher landing guards', registerOuterSuite4);
