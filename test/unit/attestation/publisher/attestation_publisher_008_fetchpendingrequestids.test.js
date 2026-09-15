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
const hookAt35822 = function () {
        nock.cleanAll();
        sinon.restore();
    };

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('returns null when indexer URL is unavailable', async function () {
        const hub = makeHub(MY_PUB, { _resolveBtcIndexerUrl: async () => null });
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(os.tmpdir(), 'test-' + process.pid + '.jsonl');
        const result = await pub.fetchPendingRequestIds();
        expect(result).to.be.null;
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('returns a Set of request IDs from the indexer response', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: {
                    requests: [
                        { request_id: 'AA'.repeat(32), block_index: 10, action_index: 1 },
                        { request_id: 'BB'.repeat(32), block_index: 10, action_index: 2 }
                    ]
                }
            });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids).to.be.instanceof(Set);
        expect(ids.has('aa'.repeat(32))).to.equal(true);
        expect(ids.has('bb'.repeat(32))).to.equal(true);
        expect(ids.size).to.equal(2);
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('returns an empty Set when there are no pending requests', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: { requests: [] }
            });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids).to.be.instanceof(Set);
        expect(ids.size).to.equal(0);
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('returns null when the indexer returns a result.error', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: { error: 'method not found' }
            });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids).to.be.null;
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('returns null when the indexer call fails (network error)', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .replyWithError('ECONNREFUSED');

        const ids = await pub.fetchPendingRequestIds();
        expect(ids).to.be.null;
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('returns null when the indexer call throws a non-Error value (e.message falsy branch)', async function () {
        // Exercises the `e` arm of `e && e.message ? e.message : e` in the fetch catch.
        //
        // The throw is injected through the hub's header hook rather than by stubbing
        // axios.post, because the header hook is evaluated INSIDE the same try block and
        // a module-level axios stub cannot be trusted to be the instance under test.
        // Any suite that proxyquires a module which transitively requires axios (src/api
        // does) purges the axios require-cache entry, so a later require('axios') hands
        // back a NEW object while AttestationPublisher keeps the one it captured at load.
        // Stubbing the new object left the real post() in the call path, which then made
        // a live request to the fake indexer host and returned only when axios hit its own
        // 5000ms timeout: the same 5000ms mocha allows the test, so it failed in a full
        // tier run and passed in isolation. Injecting at a seam the test owns keeps this
        // case deterministic and off the network.
        const pub = makePublisher(MY_PUB, {
            btcIndexerHeaders: () => { throw { code: 'ECONNREFUSED' }; }   // plain object, no .message
        });
        const ids = await pub.fetchPendingRequestIds();
        expect(ids).to.be.null;
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('handles result without requests field (result.requests || [] fallback)', async function () {
        const pub = makePublisher(MY_PUB);
        // Return a result that has no `requests` field; should fall back to []
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: {}  // no requests field
            });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids).to.be.instanceof(Set);
        expect(ids.size).to.equal(0);
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('skips entries with empty request_id', async function () {
        const pub = makePublisher(MY_PUB);
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, {
                jsonrpc: '2.0', id: 1,
                result: {
                    requests: [
                        { request_id: '', block_index: 1, action_index: 1 },
                        { request_id: 'AA'.repeat(32), block_index: 1, action_index: 2 }
                    ]
                }
            });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids.size).to.equal(1);
        expect(ids.has('aa'.repeat(32))).to.equal(true);
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('handles pagination: stops when result count < PENDING_PAGE_LIMIT (100)', async function () {
        const pub = makePublisher(MY_PUB);
        // Return 50 entries (< 100); should stop after 1 page
        const requests = Array.from({ length: 50 }, (_, i) => ({
            request_id: String(i).padStart(64, '0'),
            block_index: i,
            action_index: i
        }));
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, { jsonrpc: '2.0', id: 1, result: { requests } });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids.size).to.equal(50);
    }); });

describe('AttestationPublisher: fetchPendingRequestIds', function () { afterEach(hookAt35822); it('paginates when first response has exactly 100 (PENDING_PAGE_LIMIT) entries', async function () {
        const pub = makePublisher(MY_PUB);
        // Page 1: exactly 100 entries → triggers pagination cursor
        const page1 = Array.from({ length: 100 }, (_, i) => ({
            request_id: ('00'.repeat(31) + String(i).padStart(2, '0')).slice(-64),
            block_index: i,
            action_index: i
        }));
        // Page 2: 1 entry → stops pagination
        const page2 = [{
            request_id: 'ff'.repeat(32),
            block_index: 200,
            action_index: 0
        }];

        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, { jsonrpc: '2.0', id: 1, result: { requests: page1 } });
        nock('http://indexer.local')
            .post('/rpc')
            .reply(200, { jsonrpc: '2.0', id: 1, result: { requests: page2 } });

        const ids = await pub.fetchPendingRequestIds();
        expect(ids.size).to.equal(101);
        expect(ids.has('ff'.repeat(32))).to.equal(true);
    }); });
}
