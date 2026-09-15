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

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep never re-broadcasts a quarantined request', async function () {
        const rid = 'd7'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: null, sent_at: null }]);
        const pub = makePublisher(MY_PUB, { db });
        await pub.hydratePublishedMarkers();
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'an unknown-on-chain-state request must await operator replay').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(0);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('sweep FAILS CLOSED and retains the entry when the marker is unreadable', async function () {
        const rid = 'd8'.repeat(32);
        const db = makeMarkerDb([], /^SELECT request_id, txid/);
        const pub = makePublisher(MY_PUB, { db });
        const bcast = sinon.stub().resolves({ txid: 'x' });
        pub.setBroadcastHook(bcast);
        sinon.stub(pub, 'fetchPendingRequestIds').resolves(new Set([rid]));
        writeQueue(pub.queuePath, [{ ts: Date.now() - 10 * 60000, requestId: rid, wire: wireFor(rid),
            responsible: [MY_PUB], leaderPubkey: MY_PUB }]);
        await pub._processQueue();
        expect(bcast.called, 'must not spend when the request cannot be proven unpublished').to.equal(false);
        expect(readQueue(pub.queuePath).length).to.equal(1);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('live path records durable intent BEFORE the send and confirms it after', async function () {
        const rid = 'd9'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        let intentAtSendTime = null;
        pub.setBroadcastHook(async () => {
            intentAtSendTime = db.calls.filter(c => /^INSERT/.test(c.sql)).length;
            return { txid: 'tx-live' };
        });
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(intentAtSendTime, 'intent must be durable before the fee is spent').to.equal(1);
        expect(rows.length).to.equal(1);
        expect(rows[0].txid).to.equal('tx-live');
        expect(rows[0].sent_at).to.not.equal(null);
    }); });

// The other half of #4250: the marker must never make a NEVER-SENT request worse
    // off than it was without it. An intent row that outlives a no-send exit is read as
    // a crash-mid-send at the next startup, and quarantine is permanent (operator-only
    // replay), so a routine ceiling trip or RPC rejection plus a restart would strand a
    // request the pre-marker code would simply have published in a later window.
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a ceiling-blocked (never sent) request leaves NO intent row and survives a restart', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const sent = 'e1'.repeat(32), blocked = 'e2'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'tx-1' }));
        const finalize = (rid) => pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        await finalize(sent);
        await finalize(blocked);
        expect(rows.map(r => r.request_id), 'the ceiling trip must not record an intent to send').to.deep.equal([sent]);

        // Restart over the same marker table and the same WAL: the blocked entry must
        // still be publishable, not quarantined.
        const pub2 = makePublisher(MY_PUB, { db });
        pub2.queuePath = pub.queuePath;
        await pub2.hydratePublishedMarkers();
        expect(pub2._quarantinedRequests.size, 'a never-sent request must not be quarantined').to.equal(0);
        const bcast2 = sinon.stub().resolves({ txid: 'tx-2' });
        pub2.setBroadcastHook(bcast2);
        sinon.stub(pub2, 'fetchPendingRequestIds').resolves(new Set([blocked]));
        writeQueue(pub2.queuePath, readQueue(pub2.queuePath).map(e => Object.assign({}, e, { ts: Date.now() - 60 * 60000 })));
        await pub2._processQueue();
        expect(bcast2.called, 'the deferred response must publish in the later window').to.equal(true);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a definitive send failure withdraws its intent row', async function () {
        const rid = 'e3'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().rejects(new Error('Encoder RPC error: rejected')));
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(rows.length, 'a rejected pre-send leaves nothing to quarantine').to.equal(0);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('an AMBIGUOUS send failure KEEPS its intent row', async function () {
        // The mirror of the test above: the tx may have reached the BTC node, so the
        // intent must survive and quarantine on restart rather than risk a second fee.
        const rid = 'e4'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        const ambiguous = new Error('socket hang up');
        ambiguous.attestAmbiguousSend = true;
        pub.setBroadcastHook(sinon.stub().rejects(ambiguous));
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(rows.length).to.equal(1);
        expect(rows[0].sent_at, 'an ambiguous send stays intent-only, which is what quarantines it').to.equal(null);
    }); });

// ── The marker identifies a PUBLICATION, not a request ──
    //
    // A non-ok response is advisory and leaves the request PENDING and retryable on
    // the indexer, so the very next round can finalize the same request as ok. A
    // marker keyed by request id alone reads that ok as a duplicate and drops it, and
    // the requester's paid-for attestation never reaches the chain.
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a published non-ok response does not suppress the later ok response', async function () {
        const rid = 'f1'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx' });
        pub.setBroadcastHook(bcast);
        const finalize = (status) => pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('x'),
            status: status, meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        await finalize('provider_error');
        await finalize('ok');
        expect(bcast.callCount, 'the paid-for ok response must publish after an advisory failure row').to.equal(2);
        expect(rows.length, 'both publications share one marker row').to.equal(1);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a restart does not re-publish a non-ok status already broadcast', async function () {
        // The other direction: the per-outcome marker must keep the protection it
        // replaces. A retry round that finalizes the SAME failure status again spends
        // a second BTC fee for no new information.
        const rid = 'f2'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: 'tx-pre-crash', sent_at: new Date(),
                                   sent_statuses: 'no_quorum', intent_status: null }]);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx' });
        pub.setBroadcastHook(bcast);
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('x'),
            status: 'no_quorum', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called, 'a second fee for an audit row already on chain').to.equal(false);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a marker row written before the per-outcome columns stays terminal', async function () {
        // Upgrade safety: a row carrying no recorded statuses is a pre-upgrade marker
        // whose outcome is unknown, so it must suppress every status exactly as it did
        // before, never be read as "no status published yet".
        const rid = 'f3'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: 'tx-legacy', sent_at: new Date(),
                                   sent_statuses: null, intent_status: null }]);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx' });
        pub.setBroadcastHook(bcast);
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('x'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called, 'an unattributed marker must not be re-opened by an upgrade').to.equal(false);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('an ok publication is terminal for every later status', async function () {
        const rid = 'f4'.repeat(32);
        const db = makeMarkerDb([{ request_id: rid, txid: 'tx-ok', sent_at: new Date(),
                                   sent_statuses: 'ok', intent_status: null }]);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        const bcast = sinon.stub().resolves({ txid: 'tx' });
        pub.setBroadcastHook(bcast);
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('x'),
            status: 'no_quorum', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(bcast.called, 'the request is answered; nothing further is publishable').to.equal(false);
    }); });
}
