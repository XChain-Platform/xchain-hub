'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// OraclePublisher landing guards: the confirmed-UTXO reserve that refuses to build
// a wire nothing can mine, and the watchdog that tracks a broadcast to a block.
// Real fs against a temp directory, like the batch-rail suite: the durable queue is
// what proves a deferral kept the round and burned no attempt.

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');

const OraclePublisher = require('../../src/OraclePublisher.js');
const { waitUntil }   = require('../helpers/waitUntil');

const ME   = 'aa'.repeat(32);
const ADDR = 'DPubLisherAddr1111111111111111111';

let tmpDirs   = [];
let instances = [];

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

// One get_utxos entry in the tracker's shape: satoshi `value` string, a 64-hex
// txid, and the confirmations field the reserve and the watchdog both read.
// 50 DOGE apiece, so a set of any size clears the default 10 DOGE balance floor
// and the reserve is the only thing that can stop a pass.
function utxo(txid, confirmations, opts) {
    opts = opts || {};
    let out = { txid: txid, vout: opts.vout || 0, value: opts.value || '5000000000' };
    if (confirmations !== null) out.confirmations = confirmations;
    return out;
}

function makeEncoder(utxos) {
    let enc = {
        sets:        [utxos || []],
        getUtxosCalls: 0,
        createTx:    sinon.stub().rejects(new Error('the watchdog must never build a transaction')),
        broadcastTx: sinon.stub().rejects(new Error('the watchdog must never broadcast'))
    };
    enc.getUtxos = sinon.stub().callsFake(async () => {
        enc.getUtxosCalls++;
        return enc.sets[0];
    });
    enc.serve = (next) => { enc.sets[0] = next; };
    return enc;
}

function queueEntry(round, attempts) {
    return { round: round, btcBlockTime: 1800000000 + round * 600,
             prices: [{ coinPair: 'BTC/USD', price: '60000.12' }],
             sigs:   [{ pubkey: ME, sig: 'cc'.repeat(64) }],
             attempts: attempts || 0 };
}

function makePublisher(opts) {
    opts = opts || {};
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pub-confirm-'));
    tmpDirs.push(dir);

    let hub = {
        p2pConfig: Object.assign({ PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                                 opts.cfg || {}),
        network:            'regtest',
        db:                 opts.db || null,
        getIdentity:        () => ({ getPubkeyHex: () => ME, sign: () => 'dd'.repeat(64) }),
        capabilitySnapshot: null,
        oracleConsensus:    null,
        oracleBatchSigner:  null
    };

    let p = new OraclePublisher(hub);
    p.dogeAddress = ADDR;
    p.encoder     = opts.encoder === null ? null : (opts.encoder || makeEncoder(opts.utxos));

    let broadcasts = [];
    p.setBroadcastHook(async (payload) => {
        broadcasts.push(payload);
        return { txid: opts.txids ? opts.txids[broadcasts.length - 1] : ('tx' + broadcasts.length) };
    });

    instances.push(p);
    return { p, hub, dir, broadcasts, encoder: p.encoder,
             queuePath: path.join(dir, 'publisher-queue.jsonl'),
             deadPath:  path.join(dir, 'publisher-queue.deadletter.jsonl') };
}

function seedQueue(h, entries) {
    fs.writeFileSync(h.queuePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function readJsonl(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ────────────────────────────────────────────────────────────────────────────

describe('OraclePublisher landing guards', function () {

    let logs;
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });

    afterEach(function () {
        sinon.restore();
        for (let p of instances) { try { p.stop(); } catch (e) { /* already stopped */ } }
        instances = [];
        for (let d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* gone */ } }
        tmpDirs = [];
    });

    // ───────────────────────────────────── the confirmed-UTXO reserve

    describe('confirmed-UTXO reserve', function () {

        it('defers the publish pass when every spendable output is unconfirmed', async function () {
            // The live wedge: a prior publish never mined, so the whole balance is
            // change sitting in the mempool behind it. Balance is 150 DOGE, far above
            // the floor, which is exactly why the floor gate cannot see this.
            let h = makePublisher({ utxos: [utxo('a1'.repeat(32), 0), utxo('a2'.repeat(32), 0),
                                            utxo('a3'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();

            expect(h.broadcasts).to.have.length(0);
            let diag = logs.warn.filter(w => w.includes('NO_CONFIRMED_UTXO'));
            expect(diag).to.have.length(1);
            expect(diag[0]).to.include(ADDR);
        });

        it('keeps the deferred round queued, burns no attempt and dead-letters nothing', async function () {
            let h = makePublisher({ utxos: [utxo('b1'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();
            await h.p._processQueue();
            await h.p._processQueue();

            let queued = readJsonl(h.queuePath);
            expect(queued).to.have.length(1);
            expect(queued[0].round).to.equal(5);
            // A deferral is not a broadcast failure: three passes must leave the
            // attempts counter where it started, or the round eventually dead-letters
            // for a condition that resolves on its own.
            expect(queued[0].attempts).to.equal(0);
            expect(fs.existsSync(h.deadPath)).to.be.false;
        });

        it('publishes normally when at least one output is confirmed', async function () {
            let h = makePublisher({ utxos: [utxo('c1'.repeat(32), 6), utxo('c2'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(logs.warn.filter(w => w.includes('NO_CONFIRMED_UTXO'))).to.have.length(0);
            expect(readJsonl(h.queuePath)).to.have.length(0);
        });

        it('surfaces the reserve and the deferral count in getStats', async function () {
            let h = makePublisher({ utxos: [utxo('d1'.repeat(32), 0), utxo('d2'.repeat(32), 0)] });
            seedQueue(h, [queueEntry(5)]);

            expect(h.p.getStats().noConfirmedUtxoDeferrals).to.equal(0);
            expect(h.p.getStats().confirmedUtxos).to.equal(null);

            await h.p._processQueue();

            let stats = h.p.getStats();
            expect(stats.confirmedUtxos).to.equal(0);
            expect(stats.unconfirmedUtxos).to.equal(2);
            expect(stats.noConfirmedUtxoDeferrals).to.equal(1);
            expect(stats.lastNoConfirmedUtxoAt).to.be.a('number');
        });

        it('publishes anyway when the UTXO set cannot be read (fail soft, not a second stall)', async function () {
            let enc = makeEncoder([]);
            enc.getUtxos = sinon.stub().rejects(new Error('encoder unreachable'));
            let h = makePublisher({ encoder: enc });
            // The balance gate reads through the same encoder and fails closed on its
            // own, so drive the balance from a hook to isolate the reserve check.
            h.p.setBalanceHook(async () => 150);
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(h.p.getStats().noConfirmedUtxoDeferrals).to.equal(0);
        });

        it('publishes anyway when the source serves no confirmations field', async function () {
            // An unknown confirmation state must never read as "nothing is confirmed",
            // or a field rename on the tracker side wedges every publisher.
            let h = makePublisher({ utxos: [utxo('e1'.repeat(32), null)] });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(h.p.getStats().noConfirmedUtxoDeferrals).to.equal(0);
        });

        it('leaves the empty-wallet case to the balance floor', async function () {
            let h = makePublisher({ utxos: [] });
            h.p.setBalanceHook(async () => 150);
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(logs.warn.filter(w => w.includes('NO_CONFIRMED_UTXO'))).to.have.length(0);
        });
    });

    // ───────────────────────────────────── the confirmation watchdog

    describe('confirmation watchdog', function () {

        // Publish one round against a confirmed reserve, then hand the encoder back a
        // set that describes the published transaction's fate.
        async function publishThen(h, after) {
            seedQueue(h, [queueEntry(5)]);
            await h.p._processQueue();
            expect(h.broadcasts).to.have.length(1);
            h.encoder.serve(after);
        }

        it('flags a published transaction that has not been seen confirmed', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p._checkPublishedConfirmations();

            let stats = h.p.getStats();
            expect(stats.unconfirmedPublishes).to.equal(1);
            expect(stats.oldestUnconfirmedTxid).to.equal('tx1');
            expect(stats.oldestUnconfirmedRound).to.equal(5);
            expect(stats.oldestUnconfirmedAgeMs).to.be.at.least(0);
            // The broadcast marker still reads healthy, which is the whole reason the
            // watchdog has to report separately.
            expect(stats.lastPublishedTxid).to.equal('tx1');
        });

        it('clears the flag once the transaction is confirmed', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);
            await h.p._checkPublishedConfirmations();
            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);

            h.encoder.serve([utxo('tx1', 3)]);
            await h.p._checkPublishedConfirmations();

            let stats = h.p.getStats();
            expect(stats.unconfirmedPublishes).to.equal(0);
            expect(stats.oldestUnconfirmedTxid).to.equal(null);
            expect(stats.oldestUnconfirmedAgeMs).to.equal(null);
            expect(stats.confirmedPublishes).to.equal(1);
        });

        it('clears a transaction whose change was spent by a mined descendant', async function () {
            // The txid is gone from the set because a later publish spent its change,
            // and that later output is confirmed: no confirmed output at this address
            // can descend from an unmined ancestor.
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx2', 2)]);

            await h.p._checkPublishedConfirmations();

            expect(h.p.getStats().unconfirmedPublishes).to.equal(0);
            expect(h.p.getStats().confirmedPublishes).to.equal(1);
        });

        it('keeps a transaction pending while its descendants are all unconfirmed', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx2', 0), utxo('tx3', 0)]);

            await h.p._checkPublishedConfirmations();

            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);
            expect(h.p.getStats().oldestUnconfirmedTxid).to.equal('tx1');
        });

        it('logs a greppable diagnostic once the oldest pending broadcast goes stale', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], cfg: { ORACLE_PUBLISH_CONFIRM_STALE_MS: 0 } });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p._checkPublishedConfirmations();

            let diag = logs.warn.filter(w => w.includes('UNCONFIRMED_PUBLISH'));
            expect(diag).to.have.length(1);
            expect(diag[0]).to.include('tx1');
        });

        it('stays silent while a fresh broadcast is still inside the stale window', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p._checkPublishedConfirmations();

            expect(logs.warn.filter(w => w.includes('UNCONFIRMED_PUBLISH'))).to.have.length(0);
            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);
        });

        it('never spends: the check builds and broadcasts nothing', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            await publishThen(h, [utxo('tx1', 0)]);

            await h.p._checkPublishedConfirmations();
            await h.p._checkPublishedConfirmations();

            expect(h.encoder.createTx.called).to.be.false;
            expect(h.encoder.broadcastTx.called).to.be.false;
        });

        it('does not track a broadcast that returned no txid', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], txids: [null] });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();

            expect(h.broadcasts).to.have.length(1);
            expect(h.p.getStats().unconfirmedPublishes).to.equal(0);
        });
    });

    // ───────────────────────────────────── fail-soft

    describe('watchdog fail-soft', function () {

        it('swallows an encoder failure, keeps the pending tail and counts the miss', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            seedQueue(h, [queueEntry(5)]);
            await h.p._processQueue();

            h.encoder.getUtxos = sinon.stub().rejects(new Error('encoder unreachable'));
            await h.p._checkPublishedConfirmations();   // must not throw

            let stats = h.p.getStats();
            expect(stats.unconfirmedPublishes).to.equal(1);
            expect(stats.confirmationCheckFailures).to.equal(1);
            expect(stats.lastConfirmationCheckAt).to.equal(null);
        });

        it('counts an unreadable confirmation state rather than resolving it', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)] });
            seedQueue(h, [queueEntry(5)]);
            await h.p._processQueue();

            h.encoder.serve([utxo('tx1', null)]);
            await h.p._checkPublishedConfirmations();

            expect(h.p.getStats().unconfirmedPublishes).to.equal(1);
            expect(h.p.getStats().confirmationCheckFailures).to.equal(1);
        });

        it('resolves a confirmation even while every hub DB query is failing', async function () {
            // The watchdog reads the chain, not the hub DB, so a dead DB must not stop
            // it reporting or clearing. The DB failure keeps the publish path fail-closed
            // on its own; nothing here may throw out of the timer.
            let db = { doQuery: sinon.stub().rejects(new Error('DB down')) };
            let h  = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], db: db });
            h.p._notePendingConfirmation(5, 'tx1');

            h.encoder.serve([utxo('tx1', 4)]);
            await h.p._checkPublishedConfirmations();   // must not throw

            expect(h.p.getStats().unconfirmedPublishes).to.equal(0);
            expect(h.p.getStats().confirmedPublishes).to.equal(1);
        });

        it('does not block publishing when the durable marker read fails', async function () {
            // A DB fault defers by design (fail closed against a duplicate spend); the
            // reserve check must not turn that into a different failure or a throw.
            let db = { doQuery: sinon.stub().rejects(new Error('DB down')) };
            let h  = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], db: db });
            seedQueue(h, [queueEntry(5)]);

            await h.p._processQueue();   // must not throw

            expect(h.broadcasts).to.have.length(0);
            expect(readJsonl(h.queuePath)).to.have.length(1);
        });
    });

    // ───────────────────────────────────── the timer

    describe('watchdog timer', function () {

        it('arms an unref\'d interval on start and releases it on stop', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 5 } });
            await h.p.start();

            expect(h.p._confirmTimer).to.not.equal(null);
            expect(h.p._confirmTimer.hasRef()).to.be.false;

            h.p.stop();
            expect(h.p._confirmTimer).to.equal(null);
        });

        it('clears a confirmation on its own schedule', async function () {
            let h = makePublisher({ utxos: [utxo('f0'.repeat(32), 9)], cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 5 } });
            await h.p.start();
            h.p._notePendingConfirmation(5, 'tx1');
            h.encoder.serve([utxo('tx1', 1)]);

            await waitUntil(() => h.p.getStats().unconfirmedPublishes === 0,
                            { label: 'the watchdog tick to clear tx1' });
            expect(h.p.getStats().confirmedPublishes).to.equal(1);
        });

        it('stays disarmed when the cadence is set to 0', async function () {
            let h = makePublisher({ cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 0 } });
            await h.p.start();

            expect(h.p.confirmCheckIntervalMs).to.equal(0);
            expect(h.p._confirmTimer).to.equal(null);
        });

        it('stays disarmed when nothing could be read (no encoder or no address)', async function () {
            let h = makePublisher({ encoder: null });
            await h.p.start();
            expect(h.p._confirmTimer).to.equal(null);
        });

        it('defaults to a 5-minute cadence and a 30-minute stale threshold', function () {
            let a = makePublisher();
            expect(a.p.confirmCheckIntervalMs).to.equal(300000);
            expect(a.p.confirmStaleMs).to.equal(1800000);
            expect(a.p.getStats().confirmationCheckIntervalMs).to.equal(300000);

            let b = makePublisher({ cfg: { ORACLE_PUBLISH_CONFIRM_CHECK_MS: 60000,
                                           ORACLE_PUBLISH_CONFIRM_STALE_MS: 120000 } });
            expect(b.p.confirmCheckIntervalMs).to.equal(60000);
            expect(b.p.confirmStaleMs).to.equal(120000);
        });
    });
});
