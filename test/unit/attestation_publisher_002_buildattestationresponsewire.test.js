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
let pub;

const hookAt15905 = function () { pub = makePublisher(); };

describe('AttestationPublisher: buildAttestationResponseWire', function () { before(hookAt15905); it('builds a pipe-delimited ATTEST v1 wire with Buffer body', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    'req' + '11'.repeat(30),
            providerId:   'http_get',
            responseBody: Buffer.from('hello', 'utf8'),
            status:       'ok',
            meta:         '200',
            signatures:   [
                { pubkey: MY_PUB,     sig: 'ee'.repeat(64) },
                { pubkey: LEADER_PUB, sig: 'ff'.repeat(64) }
            ]
        });
        const parts = wire.split('|');
        expect(parts[0]).to.equal('ATTEST');
        expect(parts[1]).to.equal('1');
        expect(parts[2]).to.equal(('req' + '11'.repeat(30)).toLowerCase());
        expect(parts[3]).to.equal('http_get');
        // parts[4] is base64 of "hello"
        expect(Buffer.from(parts[4], 'base64').toString()).to.equal('hello');
        expect(parts[5]).to.equal('ok');
        expect(parts[6]).to.equal('200');
        expect(parts[7]).to.equal('2');  // 2 signatures
        expect(parts[8]).to.equal(MY_PUB.toLowerCase());
        expect(parts[9]).to.equal('ee'.repeat(64));
        expect(parts[10]).to.equal(LEADER_PUB.toLowerCase());
        expect(parts[11]).to.equal('ff'.repeat(64));
    }); });

describe('AttestationPublisher: buildAttestationResponseWire', function () { before(hookAt15905); it('handles null responseBody (uses empty Buffer)', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    '00'.repeat(32),
            providerId:   'llm',
            responseBody: null,
            status:       'error',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        const parts = wire.split('|');
        // base64 of empty buffer is empty string
        expect(parts[4]).to.equal('');
        expect(parts[5]).to.equal('error');
    }); });

describe('AttestationPublisher: buildAttestationResponseWire', function () { before(hookAt15905); it('handles string responseBody (converts to UTF-8 Buffer)', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    '11'.repeat(32),
            providerId:   'http_get',
            responseBody: 'string content',
            status:       'ok',
            meta:         '200',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        const parts = wire.split('|');
        expect(Buffer.from(parts[4], 'base64').toString()).to.equal('string content');
    }); });

describe('AttestationPublisher: buildAttestationResponseWire', function () { before(hookAt15905); it('lowercases requestId in the wire', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    'AAAA' + '00'.repeat(30),
            providerId:   'http_get',
            responseBody: null,
            status:       'ok',
            meta:         '',
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        expect(wire.split('|')[2]).to.equal(('AAAA' + '00'.repeat(30)).toLowerCase());
    }); });

describe('AttestationPublisher: buildAttestationResponseWire', function () { before(hookAt15905); it('handles missing meta (uses empty string)', function () {
        const wire = pub.buildAttestationResponseWire({
            requestId:    '22'.repeat(32),
            providerId:   'llm',
            responseBody: null,
            status:       'ok',
            meta:         undefined,
            signatures:   [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }]
        });
        expect(wire.split('|')[6]).to.equal('');
    }); });
}
