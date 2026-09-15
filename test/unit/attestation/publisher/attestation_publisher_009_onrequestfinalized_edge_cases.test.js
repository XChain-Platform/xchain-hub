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
 * _enqueue/readQueue/rewriteQueue/removeFromQueue, getBroadcaster, myRank,
 * computeResponsible, fetchPendingRequestIds, resolveBtcIndexerUrl,
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
        resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
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

// ---------- myRank ---------------------------------------------------------

// ---------- computeResponsible ---------------------------------------------

// ---------- resolveBtcIndexerUrl -------------------------------------------

// ---------- fetchPendingRequestIds -----------------------------------------

// ---------- onRequestFinalized edge cases -----------------------------------

// ---------- processQueue extra paths not covered by replay suite -----------

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
const hookAt42857 = function () {
        sinon.restore();
    };

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('returns early when event is null', async function () {
        const pub = makePublisher();
        await pub.onRequestFinalized(null);  // should not throw
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('returns early when event has no requestId', async function () {
        const pub = makePublisher();
        await pub.onRequestFinalized({});  // should not throw
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('proceeds (as follower) when identity is null in onRequestFinalized', async function () {
        // Line 155: `this.identity ? getPubkeyHex() : null` (null branch)
        const hub = makeHub(MY_PUB);
        hub.getIdentity = () => null;
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'attest-noid-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-noid' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId:    'ef'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: LEADER_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: LEADER_PUB
        });

        // myPubkey = null → isLeader = false → FOLLOWER path → no broadcast
        expect(bcast.called).to.equal(false);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('logs a warning and returns when signatures array is empty', async function () {
        const pub = makePublisher();
        const warnStub = sinon.stub(console, 'warn');
        await pub.onRequestFinalized({
            requestId: '11'.repeat(32),
            providerId: 'http_get',
            responseBody: Buffer.from('foo'),
            status: 'ok',
            meta: '',
            signatures: []
        });
        expect(warnStub.called).to.equal(true);
        expect(warnStub.args[0][0]).to.match(/no sigs/);
        warnStub.restore();
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('logs a warning and returns when signatures is null/missing', async function () {
        const pub = makePublisher();
        const warnStub = sinon.stub(console, 'warn');
        await pub.onRequestFinalized({
            requestId: '22'.repeat(32),
            providerId: 'http_get',
            responseBody: null,
            status: 'ok',
            meta: '',
            signatures: null
        });
        expect(warnStub.called).to.equal(true);
        warnStub.restore();
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('drops oversized wire payloads with a console.error and does not enqueue', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-oversize-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const errStub = sinon.stub(console, 'error');

        // Create a responseBody that will make the wire > 8189 bytes
        const hugeBody = Buffer.alloc(8200, 'X');
        await pub.onRequestFinalized({
            requestId:    '33'.repeat(32),
            providerId:   'http_get',
            responseBody: hugeBody,
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 5, redundancy: 1 }
        });

        expect(errStub.called).to.equal(true);
        expect(errStub.args[0][0]).to.match(/exceeds encoder limit/);
        expect(readQueue(pub.queuePath)).to.have.length(0);
        errStub.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('logs a warning when no broadcast hook is configured (leader, no broadcaster)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-nobcast-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const warnStub = sinon.stub(console, 'warn');

        await pub.onRequestFinalized({
            requestId:    '44'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 5, redundancy: 1 }
        });

        expect(warnStub.called).to.equal(true);
        warnStub.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('enqueues and retries on broadcast failure (entry stays on queue)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-bcastfail-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().rejects(new Error('broadcast network error'));
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId:    '55'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 5, redundancy: 1 }
        });

        expect(bcast.calledOnce).to.equal(true);
        // Entry must remain on the queue for the next sweep retry
        expect(readQueue(pub.queuePath)).to.have.length(1);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('uses null leaderPubkey when responsible is null and event has no leaderPubkey', async function () {
        // Line 191: `responsible && responsible.length ? responsible[0] : null`
        // When no leaderPubkey and computeResponsible returns null (no block_index) → leaderPubkey=null
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-noLeader-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-noleader' });
        pub.setBroadcastHook(bcast);

        // No leaderPubkey, no request block_index → responsible=null → leaderPubkey=null
        // isLeader = (null && MY_PUB && null === MY_PUB) → false → FOLLOWER path
        await pub.onRequestFinalized({
            requestId:    'ab'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
            // no leaderPubkey, no request
        });

        // With leaderPubkey=null the isLeader check fails → follower path, no broadcast
        expect(bcast.called).to.equal(false);
        expect(readQueue(pub.queuePath)).to.have.length(1);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('normalizes redundancy to 1 (not signatures.length) when request.redundancy is absent (item 2643)', async function () {
        // Canonical rule shared with AttestationRound and the indexer:
        // Math.max(1, Number(redundancy) || 1). The prior signatures.length
        // fallback produced a responsible list of a different LENGTH than
        // consensus derived, mis-ranking failover step-in.
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-redfallback-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx1' });
        pub.setBroadcastHook(bcast);
        const computeStub = sinon.stub(pub, 'computeResponsible').resolves([MY_PUB]);

        await pub.onRequestFinalized({
            requestId:    '66'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            // three signers, but request carries a block and NO redundancy:
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) },
                           { pubkey: LEADER_PUB, sig: 'ff'.repeat(64) },
                           { pubkey: 'cc'.repeat(32), sig: 'dd'.repeat(64) }],
            leaderPubkey: MY_PUB,
            request:      { block_index: 100 }
        });

        expect(computeStub.calledOnce).to.equal(true);
        // redundancy arg is 1 (canonical), NOT 3 (signatures.length).
        expect(computeStub.firstCall.args[2]).to.equal(1);
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('uses "ok" status when event.status is absent (status || "ok" branch)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-status-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx-status-fallback' });
        pub.setBroadcastHook(bcast);

        await pub.onRequestFinalized({
            requestId:    '88'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            // no status, should fall back to 'ok'
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB
        });

        expect(bcast.calledOnce).to.equal(true);
        const wire = bcast.args[0][0];
        const parts = wire.split('|');
        expect(parts[5]).to.equal('ok');  // status field
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });

describe('AttestationPublisher: onRequestFinalized edge cases', function () { afterEach(hookAt42857); it('logs "?" when broadcaster returns result without txid', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = path.join(os.tmpdir(), 'attest-notxid-' + process.pid + '.jsonl');
        fs.writeFileSync(pub.queuePath, '');
        // Return result without txid to exercise `result.txid ? result.txid : '?'` branch
        const bcast = sinon.stub().resolves({});
        pub.setBroadcastHook(bcast);
        const logStub = sinon.stub(console, 'log');

        await pub.onRequestFinalized({
            requestId:    '99'.repeat(32),
            providerId:   'http_get',
            responseBody: Buffer.from('ok'),
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            leaderPubkey: MY_PUB
        });

        const loggedBroadcast = logStub.args.find(a => String(a[0]).match(/broadcast.*txid=\?/));
        expect(loggedBroadcast).to.exist;
        logStub.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    }); });
}
