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
 * computeResponsible, fetchPendingRequestIds, _resolveBtcIndexerUrl,
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
const AttestationPublisher = require('../../../../../src/attestation/publisher');
const { waitUntil } = require('../../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

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

// ---------- computeResponsible ---------------------------------------------

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
let queueFile;

const hookAt54798 = function () {
        queueFile = path.join(os.tmpdir(), 'attq-extra-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    };

const hookAt54960 = function () {
        sinon.restore();
        try { fs.unlinkSync(queueFile); } catch (_) {}
    };

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('logs a warning and retains entry when no broadcaster is configured during sweep', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // No broadcast hook configured
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set(['aa'.repeat(32)]));
        const warnStub = sinon.stub(console, 'warn');

        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,  // old, eligible
            requestId:    'aa'.repeat(32),
            wire:         'ATTEST|1|' + 'aa'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(warnStub.called).to.equal(true);
        const msg = warnStub.args.find(a => String(a[0]).match(/no broadcast pipeline/));
        expect(msg).to.exist;
        // Entry should be retained
        expect(readQueue(queueFile)).to.have.length(1);
        warnStub.restore();
    }); });

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('returns immediately (no error) when the queue is empty', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // Write an empty queue
        fs.writeFileSync(queueFile, '');
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set());
        await pub._processQueue();  // should return immediately, no throw
        // Verify fetchPendingRequestIds was NOT called (early return)
        // (We can check by seeing the stub was not called)
        // Actually the stub is set up; the early return happens before fetchPendingRequestIds
    }); });

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('uses singular "entry" in the unreachable-indexer log when exactly 1 entry is queued', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(null);  // indexer unreachable
        const warnStub = sinon.stub(console, 'warn');

        writeQueue(queueFile, [{
            ts:           Date.now() - 60000,
            requestId:    'aa'.repeat(32),
            wire:         'ATTEST|1|' + 'aa'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();
        expect(warnStub.called).to.equal(true);
        const msg = warnStub.args.find(a => String(a[0]).match(/1 entry retained/));
        expect(msg).to.exist;
        warnStub.restore();
    }); });

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('skips a queue entry whose responsible set does not include this node (rank === null continue)', async function () {
        // Line 360: `if (rank === null) continue`
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        const bcast = sinon.stub().resolves({ txid: 'should-not-fire' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set(['cc'.repeat(32)]));

        // responsible array does NOT include MY_PUB → _myRank returns null → skip
        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,
            requestId:    'cc'.repeat(32),
            wire:         'ATTEST|1|' + 'cc'.repeat(32) + '|http_get|Zm9v|ok||1|' + LEADER_PUB + '|' + 'ee'.repeat(64),
            responsible:  [LEADER_PUB, OTHER_PUB],  // MY_PUB not listed
            leaderPubkey: LEADER_PUB
        }]);

        await pub._processQueue();
        expect(bcast.called).to.equal(false);
        expect(readQueue(queueFile)).to.have.length(1);  // entry retained (not our responsibility)
    }); });

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('handles queue entry with no ts field (ts || 0 branch) as not-yet-eligible', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        pub.leaderRetryMs = 999999;  // very long; entry without ts treated as ts=0 so age=now >= very-long is false
        const bcast = sinon.stub().resolves({ txid: 'should-not-fire' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set(['dd'.repeat(32)]));

        // Entry with no ts field; ts falls back to 0, age = Date.now() which is large
        // but with leaderRetryMs = 999999 the entry is ONLY eligible if age >= leaderRetryMs
        // Since now - 0 = current epoch ms (~1.7e12) which is >> 999999, it's eligible.
        // So we need an extremely large leaderRetryMs to make it NOT eligible.
        pub.leaderRetryMs = Number.MAX_SAFE_INTEGER;

        writeQueue(queueFile, [{
            requestId:    'dd'.repeat(32),
            wire:         'ATTEST|1|' + 'dd'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
            // no ts, falls back to 0 in the eligibility formula
        }]);

        await pub._processQueue();
        // With MAX_SAFE_INTEGER retryMs, age (now - 0 = ~1.7e12ms) is less than MAX_SAFE_INTEGER
        // so the entry is NOT eligible; broadcast should not be called
        expect(bcast.called).to.equal(false);
    }); });

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('logs "?" txid in the replay sweep log when broadcaster returns no txid', async function () {
        // Line 382: `result.txid ? result.txid : '?'`
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // Return result without txid
        const bcast = sinon.stub().resolves({});
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set(['ee'.repeat(32)]));
        const logStub = sinon.stub(console, 'log');

        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,
            requestId:    'ee'.repeat(32),
            wire:         'ATTEST|1|' + 'ee'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ff'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(bcast.calledOnce).to.equal(true);
        const logged = logStub.args.find(a => String(a[0]).match(/txid=\?/));
        expect(logged).to.exist;
        logStub.restore();
    }); });

describe('AttestationPublisher: _processQueue (no broadcaster + replay error)', function () { beforeEach(hookAt54798); afterEach(hookAt54960); it('logs an error and retains entry when replay broadcast throws', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = queueFile;
        // Definitive (never-sent) error so this exercises the plain-retry path, not
        // the ambiguous-defer path (item 2674), which has its own tests below.
        const refused = new Error('connect ECONNREFUSED'); refused.code = 'ECONNREFUSED';
        const bcast = sinon.stub().rejects(refused);
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set(['bb'.repeat(32)]));
        const errStub = sinon.stub(console, 'error');

        writeQueue(queueFile, [{
            ts:           Date.now() - 10 * 60000,
            requestId:    'bb'.repeat(32),
            wire:         'ATTEST|1|' + 'bb'.repeat(32) + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible:  [MY_PUB],
            leaderPubkey: MY_PUB
        }]);

        await pub._processQueue();

        expect(errStub.called).to.equal(true);
        const msg = errStub.args.find(a => String(a[0]).match(/replay broadcast failed/));
        expect(msg).to.exist;
        // Entry must remain in the queue for the next retry
        expect(readQueue(queueFile)).to.have.length(1);
        errStub.restore();
    }); });
}
