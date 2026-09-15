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
const AttestationPublisher = require('../../src/attestation/publisher');
const { waitUntil } = require('../helpers/waitUntil');
const { DB_METHODS } = require('../helpers/mockHub.js');

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
const wireFor = (rid) => 'ATTEST|1|' + rid + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64);

const hookAt68170 = function () {
        sinon.restore();
        delete process.env.ATTEST_ENABLED;
        delete process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW;
        delete process.env.ATTEST_SPEND_WINDOW_MS;
    };

// ── The at-most-once guard must survive a restart ──

    // Minimal hub DB double over the attest_published_requests marker table. Models the
    // per-outcome columns the real statements maintain: `sent_statuses` accumulates one
    // entry per completed publication and `intent_status` names the armed one.
    function makeMarkerDb(rows, failOn) {
        const calls = [];
        return { ...DB_METHODS,
            calls,
            doQuery: async (sql, params) => {
                calls.push({ sql, params });
                if (failOn && failOn.test(sql)) throw new Error('marker table unreachable');
                if (/^SELECT/.test(sql)) {
                    return /WHERE request_id/.test(sql)
                        ? rows.filter(r => r.request_id === params[0])
                        : rows.slice();
                }
                if (/^INSERT/.test(sql)) {
                    // ON DUPLICATE KEY UPDATE intent_status: arms the intent either way.
                    const row = rows.find(r => r.request_id === params[0]);
                    if (row) row.intent_status = params[1];
                    else rows.push({ request_id: params[0], txid: null, sent_at: null,
                                     sent_statuses: null, intent_status: params[1] });
                    return {};
                }
                if (/SET intent_status = NULL/.test(sql)) {
                    // The disarm, scoped to the status this caller armed.
                    const row = rows.find(r => r.request_id === params[0] && r.intent_status === params[1]);
                    if (row) row.intent_status = null;
                    return {};
                }
                if (/^UPDATE/.test(sql)) {
                    // The confirmation: params are [txid, status, status, request_id].
                    const row = rows.find(r => r.request_id === params[3]);
                    if (row) {
                        row.txid = params[0];
                        row.sent_at = new Date();
                        row.intent_status = null;
                        const listed = String(row.sent_statuses || '').split(',').filter(s => s);
                        if (!listed.includes(params[1])) listed.push(params[1]);
                        row.sent_statuses = listed.join(',');
                    }
                    return {};
                }
                if (/^DELETE/.test(sql)) {
                    // ... WHERE request_id = ? AND sent_at IS NULL: a confirmed marker survives.
                    const i = rows.findIndex(r => r.request_id === params[0]);
                    if (i >= 0 && (rows[i].sent_at === null || rows[i].sent_at === undefined)) rows.splice(i, 1);
                    return {};
                }
                return {};
            }
        };
    }

// ── item 2678 kill switch ──
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('defaults to enabled', function () {
        expect(makePublisher(MY_PUB).enabled).to.equal(true);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('disabled: onRequestFinalized enqueues and broadcasts nothing (item 2678)', async function () {
        process.env.ATTEST_ENABLED = 'false';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        await pub.onRequestFinalized({
            requestId: '33'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called).to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('disabled: _processQueue does not query the indexer or broadcast (item 2678)', async function () {
        process.env.ATTEST_ENABLED = 'false';
        const pub = makePublisher(MY_PUB);
        const fetchStub = sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set());
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: '33'.repeat(32),
            wire: wireFor('33'.repeat(32)), responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(fetchStub.called).to.equal(false);
        expect(bcast.called).to.equal(false);
    }); });

// ── item 2681 enqueue-gate: no spend without a durable record ──
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('leader skips broadcast when the durable enqueue fails (item 2681)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.queuePath = '/nonexistent-root/cannot-write.jsonl';
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        const errStub = sinon.stub(console, 'error');
        await pub.onRequestFinalized({
            requestId: '77'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called, 'must not spend a BTC fee without a durable record').to.equal(false);
        expect(pub._enqueueFailures).to.equal(1);
        errStub.restore();
    }); });

// ── item 2681 durable spend-audit record ──
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('writes an append-only spend-audit record on a successful broadcast (item 2681)', async function () {
        const pub = makePublisher(MY_PUB);
        pub.spendLogPath = path.join(os.tmpdir(), 'attest-spend-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
        const rid = 'ab'.repeat(32);
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'txid-123' }));
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        const recs = readQueue(pub.spendLogPath);
        expect(recs.length).to.equal(1);
        expect(recs[0].txid).to.equal('txid-123');
        expect(recs[0].requestId).to.equal(rid);
        try { fs.unlinkSync(pub.spendLogPath); } catch (_) {}
    }); });

// ── item 2676 per-window BTC spend ceiling ──
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep stops at the per-window ceiling, retaining the rest (item 2676)', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        const rid1 = '88'.repeat(32), rid2 = '99'.repeat(32);
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'x' }));
        const bcast = pub.broadcastFn;
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid1, rid2]));
        writeQueue(pub.queuePath, [
            { ts: Date.now() - 10 * 60000, requestId: rid1, wire: wireFor(rid1), responsible: [MY_PUB], leaderPubkey: MY_PUB },
            { ts: Date.now() - 10 * 60000, requestId: rid2, wire: wireFor(rid2), responsible: [MY_PUB], leaderPubkey: MY_PUB }
        ]);
        await pub._processQueue();
        expect(bcast.calledOnce).to.equal(true);
        expect(readQueue(pub.queuePath).length).to.equal(1);
    }); });

// ── item 2674 ambiguous send: never blind re-broadcast ──
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('marks an ambiguous live-broadcast failure and retains the entry (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        const timeout = new Error('socket timeout'); timeout.code = 'ETIMEDOUT';
        pub.setBroadcastHook(sinon.stub().rejects(timeout));
        const rid = '33'.repeat(32);
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(pub._ambiguousSends.has(rid)).to.equal(true);
        expect(pub._publishedRequests.has(rid)).to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(1);   // retained for the sweep
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep DEFERS re-broadcast of a recently-ambiguous, still-pending request (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        const rid = '44'.repeat(32);
        pub._ambiguousSends.set(rid, Date.now());   // just now, within cooldown
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'must not re-broadcast within the ambiguous cooldown').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(1);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep re-broadcasts once the ambiguous cooldown passes and it is still pending (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        const rid = '55'.repeat(32);
        pub.ambiguousCooldownMs = 1000;
        pub._ambiguousSends.set(rid, Date.now() - 5000);   // older than cooldown
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.calledOnce).to.equal(true);
        expect(pub._ambiguousSends.has(rid)).to.equal(false);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep drops an ambiguous request that has LEFT the pending set, without re-broadcast (item 2674)', async function () {
        const pub = makePublisher(MY_PUB);
        const rid = '66'.repeat(32);
        pub._ambiguousSends.set(rid, Date.now());
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set());   // landed/expired
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called).to.equal(false);
        expect(pub._ambiguousSends.has(rid)).to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    }); });

// ── The spend ceiling must hold across the awaited broadcast ──
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('two concurrent finalized events cannot both pass a ceiling of 1', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');

        // Park every broadcast until both handlers have reached the await: that is the
        // interleaving the pure-predicate allow() could not survive, since both
        // handlers then read the same pre-send count and both spend a real fee.
        let release;
        const gate = new Promise(res => { release = res; });
        const bcast = sinon.stub().callsFake(async () => { await gate; return { txid: 'x' }; });
        pub.setBroadcastHook(bcast);

        const finalize = (rid) => pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        const inFlight = [finalize('a1'.repeat(32)), finalize('b2'.repeat(32))];
        release();
        await Promise.all(inFlight);

        expect(bcast.callCount, 'a ceiling of 1 must admit exactly one irreversible send').to.equal(1);
        expect(pub.spendGuard.stats().count.inWindow).to.equal(1);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('startup hydration adopts sent markers and quarantines intent-only rows', async function () {
        const sent = 'd4'.repeat(32), intent = 'e5'.repeat(32);
        const db = makeMarkerDb([
            { request_id: sent,   txid: 'tx-1', sent_at: new Date() },
            { request_id: intent, txid: null,   sent_at: null }
        ]);
        const pub = makePublisher(MY_PUB, { db });
        await pub.hydratePublishedMarkers();
        expect(pub._publishedRequests.has(sent)).to.equal(true);
        expect(pub._quarantinedRequests.has(intent)).to.equal(true);
        expect(pub._quarantinedRequests.has(sent)).to.equal(false);
        expect(pub.getPublisherStats().quarantined).to.equal(1);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep does NOT re-broadcast a still-pending request with a durable sent marker', async function () {
        // The restart case: fresh process (empty in-process guards), the response was
        // broadcast before the crash and is still PENDING because it is not yet mined.
        const rid = 'd6'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: 'tx-pre-crash', sent_at: new Date() }]);
        const pub = makePublisher(MY_PUB, { db });
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'a second BTC fee for an already-sent response').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    }); });
}
