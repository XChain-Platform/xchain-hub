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
 * enqueue/readQueue/rewriteQueue/removeFromQueue, getBroadcaster, myRank,
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

// ---------- enqueue / readQueue / rewriteQueue / removeFromQueue --------

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

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a crash between the ok intent and its confirmation quarantines only the ok', async function () {
        // The armed intent for a SECOND publication needs its own durable record, or a
        // crash mid-send leaves the sweep free to pay for the same ok response twice.
        const rid = 'f5'.repeat(32);
        const rows = [];
        const db = makeMarkerDb(rows);
        const pub = makePublisher(MY_PUB, { db });
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().resolves({ txid: 'tx-nonok' }));
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('x'),
            status: 'provider_error', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        const ambiguous = new Error('socket hang up');
        ambiguous.attestAmbiguousSend = true;
        pub.setBroadcastHook(sinon.stub().rejects(ambiguous));
        await pub.onRequestFinalized({
            requestId: rid, providerId: 'http_get', responseBody: Buffer.from('x'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(rows[0].intent_status, 'the unconfirmed ok send must survive as an intent').to.equal('ok');

        const pub2 = makePublisher(MY_PUB, { db });
        await pub2.hydratePublishedMarkers();
        expect(pub2._quarantinedRequests.has(rid + '|ok'),
               'the ok send may have reached the node; it awaits an operator').to.equal(true);
        expect(pub2._quarantinedRequests.has(rid),
               'the whole request must not be held for one unresolved outcome').to.equal(false);
    }); });

describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('a send that never went out releases its reservation', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        pub.setBroadcastHook(sinon.stub().rejects(new Error('Encoder RPC error: rejected')));
        await pub.onRequestFinalized({
            requestId: 'c3'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(pub.spendGuard.stats().count.inWindow, 'a failed send consumes no budget').to.equal(0);
        expect(pub.spendGuard.allow()).to.equal(true);
    }); });

// The mirror of the test above, and the rule AttestationRelay already states at
    // its own ambiguous branch: an ambiguous send MAY have reached the BTC node and
    // paid its fee, so the window is CHARGED for it. Releasing hands the ceiling back
    // an allowance a real spend consumed, and the next finalized request spends past
    // the ceiling.
describe('AttestationPublisher: effector-safety guards', function () { afterEach(hookAt68170); it('an AMBIGUOUS send KEEPS its reservation, charging the window for a fee that may have been paid', async function () {
        process.env.ATTEST_MAX_PUBLISHES_PER_WINDOW = '1';
        const pub = makePublisher(MY_PUB);
        fs.writeFileSync(pub.queuePath, '');
        const ambiguous = new Error('socket hang up');
        ambiguous.attestAmbiguousSend = true;
        pub.setBroadcastHook(sinon.stub().rejects(ambiguous));
        await pub.onRequestFinalized({
            requestId: 'c4'.repeat(32), providerId: 'http_get', responseBody: Buffer.from('ok'),
            status: 'ok', meta: '', signatures: [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }], leaderPubkey: MY_PUB
        });
        expect(pub.spendGuard.stats().count.inWindow,
               'a possibly-paid fee consumes budget').to.equal(1);
        expect(pub.spendGuard.allow(), 'the one-send window is now spent').to.equal(false);
    }); });
}
