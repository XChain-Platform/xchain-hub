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
describe('AttestationPublisher: getBroadcaster', function () { it('returns a function wrapping broadcastFn when set', function () {
        const pub = makePublisher();
        const fn = sinon.stub().resolves({ txid: 'abc' });
        pub.setBroadcastHook(fn);
        const broadcaster = pub.getBroadcaster();
        expect(typeof broadcaster).to.equal('function');
    }); });

describe('AttestationPublisher: getBroadcaster', function () { it('returns null when no hooks and no encoder are configured', function () {
        const pub = makePublisher();
        expect(pub.getBroadcaster()).to.be.null;
    }); });

describe('AttestationPublisher: getBroadcaster', function () { it('returns the defaultBroadcast pipeline when encoder + walletSignFn + address + pubkey are all set', function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub(), createTx: sinon.stub(), broadcastTx: sinon.stub() });
        pub.setWalletSignHook(sinon.stub().resolves('txhex'));
        pub.btcAddress    = '1TestAddress';
        pub.btcPubkeyHex  = 'ab'.repeat(33);
        const broadcaster = pub.getBroadcaster();
        expect(typeof broadcaster).to.equal('function');
    }); });

describe('AttestationPublisher: getBroadcaster', function () { it('returns null when encoder is set but walletSignFn or address is missing', function () {
        const pub = makePublisher();
        pub.setEncoder({ getUtxos: sinon.stub() });
        // No walletSignFn, no address
        expect(pub.getBroadcaster()).to.be.null;
    }); });

describe('AttestationPublisher: getBroadcaster', function () { it('broadcastFn path: broadcaster calls broadcastFn with payload and event', async function () {
        const pub = makePublisher();
        const fn = sinon.stub().resolves({ txid: 'xyz' });
        pub.setBroadcastHook(fn);
        const broadcaster = pub.getBroadcaster();
        const result = await broadcaster('wire-payload', { requestId: 'test' });
        expect(fn.calledWith('wire-payload', { requestId: 'test' })).to.equal(true);
        expect(result.txid).to.equal('xyz');
    }); });
}
