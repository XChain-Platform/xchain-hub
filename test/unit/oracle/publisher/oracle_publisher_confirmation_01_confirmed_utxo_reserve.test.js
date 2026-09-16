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
            // The live wedge: a prior publish never mined, so the whole balance is
            // change sitting in the mempool behind it. Balance is 150 DOGE, far above
            // the floor, which is exactly why the floor gate cannot see this.
            let h = makePublisher({ utxos: [utxo('a1'.repeat(32), 0), utxo('a2'.repeat(32), 0),
                                            utxo('a3'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();

            expect(h.broadcasts).to.have.length(0);
            let diag = logs.warn.filter(w => w.includes('NO_CONFIRMED_UTXO'));
            expect(diag).to.have.length(1);
            expect(diag[0]).to.include(ADDR);
        };

const testCase2 = async function () {
            let h = makePublisher({ utxos: [utxo('b1'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();
            await h.p.processQueue();
            await h.p.processQueue();

            let queued = readJsonl(h.queuePath);
            expect(queued).to.have.length(1);
            expect(queued[0].round).to.equal(5);
            // A deferral is not a broadcast failure: three passes must leave the
            // attempts counter where it started, or the round eventually dead-letters
            // for a condition that resolves on its own.
            expect(queued[0].attempts).to.equal(0);
            expect(fs.existsSync(h.deadPath)).to.be.false;
        };

const testCase3 = async function () {
            let h = makePublisher({ utxos: [utxo('c1'.repeat(32), 6), utxo('c2'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(logs.warn.filter(w => w.includes('NO_CONFIRMED_UTXO'))).to.have.length(0);
            expect(readJsonl(h.queuePath)).to.have.length(0);
        };

const testCase4 = async function () {
            let h = makePublisher({ utxos: [utxo('d1'.repeat(32), 0), utxo('d2'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            expect(h.p.getStats().noConfirmedUtxoDeferrals).to.equal(0);
            expect(h.p.getStats().confirmedUtxos).to.equal(null);

            await h.p.processQueue();

            let stats = h.p.getStats();
            expect(stats.confirmedUtxos).to.equal(0);
            expect(stats.unconfirmedUtxos).to.equal(2);
            expect(stats.noConfirmedUtxoDeferrals).to.equal(1);
            expect(stats.lastNoConfirmedUtxoAt).to.be.a('number');
        };

const testCase5 = async function () {
            let enc = makeEncoder([]);
            enc.getUtxos = sinon.stub().rejects(new Error('encoder unreachable'));
            let h = makePublisher({ encoder: enc });
            // The balance gate reads through the same encoder and fails closed on its
            // own, so drive the balance from a hook to isolate the reserve check.
            h.p.setBalanceHook(async () => 150);
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(h.p.getStats().noConfirmedUtxoDeferrals).to.equal(0);
        };

const testCase6 = async function () {
            // An unknown confirmation state must never read as "nothing is confirmed",
            // or a field rename on the tracker side wedges every publisher.
            let h = makePublisher({ utxos: [utxo('e1'.repeat(32), null)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(h.p.getStats().noConfirmedUtxoDeferrals).to.equal(0);
        };

const testCase7 = async function () {
            let h = makePublisher({ utxos: [] });
            h.p.setBalanceHook(async () => 150);
            seedQueue(h, [queueEntry(5)]);

            await h.p.processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(logs.warn.filter(w => w.includes('NO_CONFIRMED_UTXO'))).to.have.length(0);
        };

function registerSuite1() {
    it('defers the publish pass when every spendable output is unconfirmed', testCase1);
    it('keeps the deferred round queued, burns no attempt and dead-letters nothing', testCase2);
    it('publishes normally when at least one output is confirmed', testCase3);
    it('surfaces the reserve and the deferral count in getStats', testCase4);
    it('publishes anyway when the UTXO set cannot be read (fail soft, not a second stall)', testCase5);
    it('publishes anyway when the source serves no confirmations field', testCase6);
    it('leaves the empty-wallet case to the balance floor', testCase7);
}

function registerOuterSuite1() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherConfirmation();
    });
    // The confirmed-UTXO reserve.
    describe('confirmed-UTXO reserve', registerSuite1);
}

describe('OraclePublisher landing guards', registerOuterSuite1);
