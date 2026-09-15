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
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            seedQueue(h, [queueEntry(5)]);
            await h.p._processQueue();

            h.encoder.getUtxos = sinon.stub().rejects(new Error('encoder unreachable'));
            await h.p.checkPublishedConfirmations();   // must not throw

            let stats = h.p.getStats();
            expect(stats.unconfirmedPublishes).to.equal(1);
            expect(stats.confirmationCheckFailures).to.equal(1);
            expect(stats.lastConfirmationCheckAt).to.equal(null);
        };

const testCase2 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            seedQueue(h, [queueEntry(5)]);
            await h.p._processQueue();

            h.encoder.serve([utxo('tx1', null)]);
            await h.p.checkPublishedConfirmations();

            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);
            expect(h.p.getStats().confirmationCheckFailures).to.equal(1);
        };

const testCase3 = async function () {
            // The watchdog reads the chain, not the hub DB, so a dead DB must not stop
            // it reporting or clearing. The DB failure keeps the publish path fail-closed
            // on its own; nothing here may throw out of the timer.
            let db = { doQuery: sinon.stub().rejects(new Error('DB down')) };
            let h  = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], db: db });
            h.p.notePendingConfirmation(5, 'tx1');

            h.encoder.serve([utxo('tx1', 4)]);
            await h.p.checkPublishedConfirmations();   // must not throw

            expect(h.p.getStats().unconfirmedPublishes).to.equal(0);
            expect(h.p.getStats().confirmedPublishes).to.equal(1);
        };

const testCase4 = async function () {
            // A DB fault defers by design (fail closed against a duplicate spend); the
            // reserve check must not turn that into a different failure or a throw.
            let db = { doQuery: sinon.stub().rejects(new Error('DB down')) };
            let h  = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], db: db });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();   // must not throw

            expect(h.broadcasts).to.have.length(0);
            expect(readJsonl(h.queuePath)).to.have.length(1);
        };

function registerSuite1() {
    it('swallows an encoder failure, keeps the pending tail and counts the miss', testCase1);
    it('counts an unreadable confirmation state rather than resolving it', testCase2);
    it('resolves a confirmation even while every hub DB query is failing', testCase3);
    it('does not block publishing when the durable marker read fails', testCase4);
}

function registerOuterSuite3() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherConfirmation();
    });
    // Watchdog fail-soft behavior.
    describe('watchdog fail-soft', registerSuite1);
}

describe('OraclePublisher landing guards', registerOuterSuite3);
