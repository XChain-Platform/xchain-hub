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

async function publishThen(h, after) {
            // Publish one round against a confirmed reserve, then hand the encoder
            // a set that describes the published transaction's fate.
            seedQueue(h, [queueEntry(5)]);
            await h.p.processQueue();
            expect(h.broadcasts).to.have.length(1);
            h.encoder.serve(after);
        }

const testCase1 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p.checkPublishedConfirmations();

            let stats = h.p.getStats();
            expect(stats.unconfirmedPublishes).to.equal(1);
            expect(stats.oldestUnconfirmedTxid).to.equal('tx1');
            expect(stats.oldestUnconfirmedRound).to.equal(5);
            expect(stats.oldestUnconfirmedAgeMs).to.be.at.least(0);
            // The broadcast marker still reads healthy, which is the whole reason the
            // watchdog has to report separately.
            expect(stats.lastPublishedTxid).to.equal('tx1');
        };

const testCase2 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);
            await h.p.checkPublishedConfirmations();
            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);

            h.encoder.serve([utxo('tx1', 3)]);
            await h.p.checkPublishedConfirmations();

            let stats = h.p.getStats();
            expect(stats.unconfirmedPublishes).to.equal(0);
            expect(stats.oldestUnconfirmedTxid).to.equal(null);
            expect(stats.oldestUnconfirmedAgeMs).to.equal(null);
            expect(stats.confirmedPublishes).to.equal(1);
        };

const testCase3 = async function () {
            // The txid is gone from the set because a later publish spent its change,
            // and that later output is confirmed: no confirmed output at this address
            // can descend from an unmined ancestor.
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx2', 2)]);

            await h.p.checkPublishedConfirmations();

            expect(h.p.getStats().unconfirmedPublishes).to.equal(0);
            expect(h.p.getStats().confirmedPublishes).to.equal(1);
        };

const testCase4 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx2', 0), utxo('tx3', 0)]);

            await h.p.checkPublishedConfirmations();

            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);
            expect(h.p.getStats().oldestUnconfirmedTxid).to.equal('tx1');
        };

const testCase5 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], cfg: { ORACLE_PUBLISH_CONFIRM_STALE_MS: 0 } });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p.checkPublishedConfirmations();

            let diag = logs.warn.filter(w => w.includes('UNCONFIRMED_PUBLISH'));
            expect(diag).to.have.length(1);
            expect(diag[0]).to.include('tx1');
        };

const testCase6 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p.checkPublishedConfirmations();

            expect(logs.warn.filter(w => w.includes('UNCONFIRMED_PUBLISH'))).to.have.length(0);
            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);
        };

const testCase7 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p.checkPublishedConfirmations();
            await h.p.checkPublishedConfirmations();

            expect(h.encoder.createTx.called).to.be.false;
            expect(h.encoder.broadcastTx.called).to.be.false;
        };

const testCase8 = async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], txids: [null] });
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(h.p.getStats().unconfirmedPublishes).to.equal(0);
        };

function registerSuite1() {
    it('flags a published transaction that has not been seen confirmed', testCase1);
    it('clears the flag once the transaction is confirmed', testCase2);
    it('clears a transaction whose change was spent by a mined descendant', testCase3);
    it('keeps a transaction pending while its descendants are all unconfirmed', testCase4);
    it('logs a greppable diagnostic once the oldest pending broadcast goes stale', testCase5);
    it('stays silent while a fresh broadcast is still inside the stale window', testCase6);
    it('never spends: the check builds and broadcasts nothing', testCase7);
    it('does not track a broadcast that returned no txid', testCase8);
}

function registerOuterSuite2() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherConfirmation();
    });
    // The confirmation watchdog.
    describe('confirmation watchdog', registerSuite1);
}

describe('OraclePublisher landing guards', registerOuterSuite2);
