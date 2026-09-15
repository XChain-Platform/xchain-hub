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
const hookAt2846 = function () { sinon.restore(); };

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('reads failover tuning from p2pConfig', function () {
        const hub = makeHub(MY_PUB, {
            p2pConfig: {
                ATTESTATION_FAILOVER_WINDOW_BLOCKS: '5',
                ATTESTATION_FAILOVER_POLL_MS:       '15000',
                ATTESTATION_LEADER_RETRY_MS:        '45000',
                ATTESTATION_BLOCK_MS:               '120000',
                ATTESTATION_QUEUE_PATH:             '/tmp/test-queue.jsonl'
            }
        });
        const pub = new AttestationPublisher(hub);
        expect(pub.failoverWindowBlocks).to.equal(5);
        expect(pub.failoverPollMs).to.equal(15000);
        expect(pub.leaderRetryMs).to.equal(45000);
        expect(pub.approxBlockMs).to.equal(120000);
        expect(pub.queuePath).to.equal('/tmp/test-queue.jsonl');
    }); });

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('falls back to env vars for tuning', function () {
        process.env.ATTESTATION_FAILOVER_WINDOW_BLOCKS = '7';
        process.env.ATTESTATION_FAILOVER_POLL_MS       = '20000';
        process.env.ATTESTATION_LEADER_RETRY_MS        = '90000';
        process.env.ATTESTATION_BLOCK_MS               = '300000';
        process.env.ATTESTATION_QUEUE_PATH             = '/tmp/env-queue.jsonl';
        try {
            const pub = new AttestationPublisher(makeHub(MY_PUB));
            expect(pub.failoverWindowBlocks).to.equal(7);
            expect(pub.failoverPollMs).to.equal(20000);
            expect(pub.leaderRetryMs).to.equal(90000);
            expect(pub.approxBlockMs).to.equal(300000);
            expect(pub.queuePath).to.equal('/tmp/env-queue.jsonl');
        } finally {
            delete process.env.ATTESTATION_FAILOVER_WINDOW_BLOCKS;
            delete process.env.ATTESTATION_FAILOVER_POLL_MS;
            delete process.env.ATTESTATION_LEADER_RETRY_MS;
            delete process.env.ATTESTATION_BLOCK_MS;
            delete process.env.ATTESTATION_QUEUE_PATH;
        }
    }); });

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('wires up encoder from env vars when BTC_ENCODER_URL is set', function () {
        process.env.BTC_ENCODER_URL     = 'http://encoder.local:3000';
        process.env.BTC_ENCODER_API_KEY = 'key123';
        process.env.BTC_ADDRESS         = '1ABCaddress';
        process.env.BTC_PUBKEY_HEX      = 'ab'.repeat(33);
        try {
            const pub = new AttestationPublisher(makeHub(MY_PUB));
            expect(pub.encoder).to.not.be.null;
            expect(pub.btcAddress).to.equal('1ABCaddress');
            expect(pub.btcPubkeyHex).to.equal('ab'.repeat(33));
        } finally {
            delete process.env.BTC_ENCODER_URL;
            delete process.env.BTC_ENCODER_API_KEY;
            delete process.env.BTC_ADDRESS;
            delete process.env.BTC_PUBKEY_HEX;
        }
    }); });

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('leaves encoder null when no BTC_ENCODER_URL is configured', function () {
        const pub = makePublisher();
        expect(pub.encoder).to.be.null;
    }); });

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('assigns identity from hub.getIdentity()', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.identity).to.exist;
        expect(pub.identity.getPubkeyHex()).to.equal(MY_PUB);
    }); });

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('sets identity to null when hub has no getIdentity method', function () {
        const hub = { p2pConfig: {}, attestationConsensus: null };
        const pub = new AttestationPublisher(hub);
        expect(pub.identity).to.be.null;
    }); });

describe('AttestationPublisher: constructor', function () { afterEach(hookAt2846); it('uses empty p2pConfig when hub.p2pConfig is undefined (hub.p2pConfig || {} branch)', function () {
        // This exercises the `hub.p2pConfig || {}` fallback on line 75.
        const hub = { getIdentity: () => null, attestationConsensus: null };
        // p2pConfig deliberately omitted
        const pub = new AttestationPublisher(hub);
        expect(pub.queuePath).to.be.a('string');
    }); });
}
