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
// A hub can be closed and reopened inside one process (every multi-hub test venue
    // does it). The publisher subscribes to 'request:finalized' in start(), so if that
    // subscription cannot be removed, each cycle leaves the previous lifetime's
    // publisher listening and one finalized response fans out to all of them, every
    // copy racing for the same spend reservation.
    const { EventEmitter } = require('events');

function hubWithConsensus() {
        const consensus = new EventEmitter();
        return { hub: makeHub(MY_PUB, { attestationConsensus: consensus }), consensus };
    }

describe('AttestationPublisher: the finalized subscription is detachable', function () { it('start subscribes once and stop removes exactly that subscription', async function () {
        const { hub, consensus } = hubWithConsensus();
        const pub = new AttestationPublisher(hub);
        pub.queuePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attest-pub-')), 'queue.jsonl');

        expect(consensus.listenerCount('request:finalized')).to.equal(0);
        await pub.start();
        expect(consensus.listenerCount('request:finalized')).to.equal(1);
        await pub.stop();
        expect(consensus.listenerCount('request:finalized')).to.equal(0);
    }); });

describe('AttestationPublisher: the finalized subscription is detachable', function () { it('leaves no subscription behind across repeated start and stop cycles', async function () {
        const { hub, consensus } = hubWithConsensus();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-pub-'));

        for (let i = 0; i < 3; i++) {
            const pub = new AttestationPublisher(hub);
            pub.queuePath = path.join(dir, 'queue-' + i + '.jsonl');
            await pub.start();
            await pub.stop();
        }
        // A leak shows as a rising count, which is why this loops rather than
        // asserting one cycle: the first cycle passes even when stop() detaches nothing.
        expect(consensus.listenerCount('request:finalized')).to.equal(0);
    }); });
}
