/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - AttestationPublisher unit tests
 *
 * Covers: constructor defaults, start/stop lifecycle, buildAttestationResponseWire,
 * _enqueue/readQueue/rewriteQueue/removeFromQueue, getBroadcaster, _myRank,
 * _computeResponsible, fetchPendingRequestIds, _resolveBtcIndexerUrl,
 * defaultBroadcast, onRequestFinalized edge cases (no-sigs, oversized payload).
 *
 ********************************************************************/

'use strict';

const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const sinon = require('sinon');
const nock  = require('nock');
const { expect } = require('chai');
const AttestationPublisher = require('../../../../src/attestation/publisher');
const { waitUntil } = require('../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const MY_PUB     = 'aa'.repeat(32);
const LEADER_PUB = 'bb'.repeat(32);
const OTHER_PUB  = 'cc'.repeat(32);

// ---------- hub factory (mirrors AttestationPublisherReplay pattern) --------

function makeHub(myPub, overrides) {
    overrides = overrides || {};
    return Object.assign({
        getIdentity: () => ({ getPubkeyHex: () => myPub }),
        p2pConfig: {},
        attestationConsensus: null,
        capabilitySnapshot: {
            getSnapshot: async () => ({ validators: [{ pubkey: myPub }, { pubkey: LEADER_PUB }] })
        },
        _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
        btcIndexerHeaders: () => ({})
    }, overrides);
}

// Create a publisher with a unique tmpdir queue path per test.
function makePublisher(myPub, hubOverrides) {
    const pub = new AttestationPublisher(makeHub(myPub || MY_PUB, hubOverrides));
    pub.queuePath = path.join(os.tmpdir(), 'attest-pub-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    return pub;
}

function writeQueue(file, entries) {
    fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function readQueue(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ---------- constructor --------------------------------------------------

// ---------- setBroadcastHook / setWalletSignHook / setEncoder ---------------

// ---------- start / stop ----------------------------------------------------

// ---------- buildAttestationResponseWire ------------------------------------

// ---------- _enqueue / readQueue / rewriteQueue / removeFromQueue --------

// ---------- getBroadcaster -------------------------------------------------

// ---------- _myRank ---------------------------------------------------------

// ---------- _computeResponsible ---------------------------------------------

// ---------- _resolveBtcIndexerUrl -------------------------------------------

// ---------- fetchPendingRequestIds -----------------------------------------

// ---------- onRequestFinalized edge cases -----------------------------------

// ---------- _processQueue extra paths not covered by replay suite -----------

// ---------- defaultBroadcast -----------------------------------------------

// ---------- items 2674 / 2676 / 2678 / 2681: effector-safety guards ----------

// ── attest_published_requests retention (#4869) ────────────────────────────────
// The durable marker table gained one row per paid ATTEST request and never lost
// one, so a money-bearing broadcast path grew a table without bound while its
// oracle_published_rounds sibling was swept. Retention may only ever touch
// CONFIRMED rows (a sent_at NULL row is the quarantine marker an operator
// reconciles by hand), may never touch a request still on the durable WAL, and may
// never reach inside the horizon in which a live path can still surface the
// request, which is the longest provider deadline_window_blocks.

{
const hookAt7601 = function () { sinon.restore(); };

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() creates the queue file when it does not exist', async function () {
        const pub = makePublisher();
        // Stub _processQueue to avoid network calls
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        try {
            expect(fs.existsSync(pub.queuePath)).to.equal(true);
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() does not error if queue file already exists', async function () {
        const pub = makePublisher();
        fs.mkdirSync(path.dirname(pub.queuePath), { recursive: true });
        fs.writeFileSync(pub.queuePath, 'existing content\n');
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        try {
            expect(fs.existsSync(pub.queuePath)).to.equal(true);
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() subscribes to attestationConsensus when present', async function () {
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        const hub = makeHub(MY_PUB, { attestationConsensus: emitter });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-start-' + process.pid + '.jsonl');
        sinon.stub(pub, '_processQueue').resolves();

        await pub.start();
        try {
            // Emit a finalized event and verify onRequestFinalized is called
            const onStub = sinon.stub(pub, 'onRequestFinalized').resolves();
            emitter.emit('request:finalized', { requestId: 'test' });
            // Flush microtasks
            await new Promise(r => setImmediate(r));
            expect(onStub.calledOnce).to.equal(true);
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() sets up the sweep interval', async function () {
        const pub = makePublisher();
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        try {
            expect(pub._sweepTimer).to.not.be.null;
        } finally {
            await pub.stop();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('stop() clears the sweep timer', async function () {
        const pub = makePublisher();
        sinon.stub(pub, '_processQueue').resolves();
        await pub.start();
        expect(pub._sweepTimer).to.not.be.null;
        await pub.stop();
        expect(pub._sweepTimer).to.be.null;
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('stop() is safe to call when no timer is set', async function () {
        const pub = makePublisher();
        pub._sweepTimer = null;
        await pub.stop();  // should not throw
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() logs a warning when the queue path is unwritable', async function () {
        const pub = makePublisher();
        // Point to an impossible path to trigger the catch branch
        pub.queuePath = '/nonexistent-root/deep/path/queue.jsonl';
        sinon.stub(pub, '_processQueue').resolves();
        const warnStub = sinon.stub(console, 'warn');
        await pub.start();
        try {
            expect(warnStub.called).to.equal(true);
        } finally {
            await pub.stop();
            warnStub.restore();
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() catches and logs errors from onRequestFinalized when the event handler throws', async function () {
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        const hub = makeHub(MY_PUB, { attestationConsensus: emitter });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-catch-' + process.pid + '.jsonl');
        sinon.stub(pub, '_processQueue').resolves();

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            // Make onRequestFinalized reject with a real Error (tests the err.message branch)
            sinon.stub(pub, 'onRequestFinalized').rejects(new Error('handler exploded'));
            emitter.emit('request:finalized', { requestId: 'test' });
            await waitUntil(() => errStub.called, { label: 'the rejected handler to be logged' });
            expect(errStub.called).to.equal(true);
            const loggedMsg = errStub.args.find(a => String(a[0]).match(/onRequestFinalized error/));
            expect(loggedMsg).to.exist;
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() catches and logs non-Error from onRequestFinalized (err.message falsy → err branch)', async function () {
        // Line 117: `err && err.message ? err.message : err` (the `: err` path)
        const EventEmitter = require('events');
        const emitter = new EventEmitter();
        const hub = makeHub(MY_PUB, { attestationConsensus: emitter });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-nonerrorcatch-' + process.pid + '.jsonl');
        sinon.stub(pub, '_processQueue').resolves();

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            // Reject with a plain string (no .message property) to exercise the `: err` branch
            sinon.stub(pub, 'onRequestFinalized').rejects('plain string error');
            emitter.emit('request:finalized', { requestId: 'test' });
            await waitUntil(() => errStub.called, { label: 'the non-Error rejection to be logged' });
            expect(errStub.called).to.equal(true);
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() catches and logs errors when the sweep interval _processQueue rejects', async function () {
        const pub = makePublisher();
        pub.failoverPollMs = 20;  // fire quickly for testing
        let firstCall = true;
        sinon.stub(pub, '_processQueue').callsFake(async () => {
            if (firstCall) { firstCall = false; return; }  // startup call succeeds
            throw new Error('sweep exploded');
        });

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            // Wait for the interval to fire
            // Wait for the interval to fire
            await waitUntil(() => errStub.called, { label: 'the sweep interval to fire and log its rejection' });
            expect(errStub.called).to.equal(true);
            const loggedMsg = errStub.args.find(a => String(a[0]).match(/sweep error/));
            expect(loggedMsg).to.exist;
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });

describe('AttestationPublisher: start / stop', function () { afterEach(hookAt7601); it('start() sweep logs non-Error (err.message falsy → err branch) when _processQueue rejects with non-Error', async function () {
        // Line 131: `err && err.message ? err.message : err` (the `: err` path)
        const pub = makePublisher();
        pub.failoverPollMs = 20;
        let firstCall = true;
        sinon.stub(pub, '_processQueue').callsFake(async () => {
            if (firstCall) { firstCall = false; return; }
            // Throw a non-Error value (plain object without .message)
            throw { code: 'UNKNOWN_ERR' };
        });

        const errStub = sinon.stub(console, 'error');
        await pub.start();
        try {
            await waitUntil(() => errStub.called, { label: 'the sweep interval to log its non-Error rejection' });
            expect(errStub.called).to.equal(true);
        } finally {
            await pub.stop();
            errStub.restore();
            try { fs.unlinkSync(pub.queuePath); } catch (_) {}
        }
    }); });
}
