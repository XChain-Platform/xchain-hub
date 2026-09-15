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
describe('AttestationPublisher: myRank', function () { it('returns null when identity is not set', function () {
        const hub = makeHub(MY_PUB, { p2pConfig: {} });
        hub.getIdentity = () => null;
        const pub = new AttestationPublisher(hub);
        pub.queuePath = '/tmp/test.jsonl';
        expect(pub.myRank({ responsible: [MY_PUB] })).to.be.null;
    }); });

describe('AttestationPublisher: myRank', function () { it('returns 0 when this node is the leader in the responsible set', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.myRank({ responsible: [MY_PUB, LEADER_PUB] })).to.equal(0);
    }); });

describe('AttestationPublisher: myRank', function () { it('returns 1 when this node is rank-1 follower in the responsible set', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.myRank({ responsible: [LEADER_PUB, MY_PUB] })).to.equal(1);
    }); });

describe('AttestationPublisher: myRank', function () { it('returns null when this node is not in the responsible set', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.myRank({ responsible: [LEADER_PUB, OTHER_PUB] })).to.be.null;
    }); });

describe('AttestationPublisher: myRank', function () { it('uses leaderPubkey fallback when responsible array is empty/absent (we are leader)', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.myRank({ leaderPubkey: MY_PUB })).to.equal(0);
    }); });

describe('AttestationPublisher: myRank', function () { it('uses leaderPubkey fallback when responsible array is empty/absent (we are follower)', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.myRank({ leaderPubkey: LEADER_PUB })).to.equal(1);
    }); });

describe('AttestationPublisher: myRank', function () { it('returns 0 when neither responsible nor leaderPubkey is present', function () {
        const pub = makePublisher(MY_PUB);
        expect(pub.myRank({})).to.equal(0);
    }); });

describe('AttestationPublisher: myRank', function () { it('is case-insensitive for pubkey comparison', function () {
        const pub = makePublisher(MY_PUB);
        // MY_PUB already lowercase, but verify the uppercase variant is matched
        expect(pub.myRank({ responsible: [MY_PUB.toUpperCase(), LEADER_PUB] })).to.equal(0);
    }); });
}
