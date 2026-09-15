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
let pub;

const hookAt19388 = function () {
        pub = makePublisher();
        // Ensure the queue file exists (start() would do this normally)
        fs.mkdirSync(path.dirname(pub.queuePath), { recursive: true });
        fs.writeFileSync(pub.queuePath, '');
    };

const hookAt19647 = function () {
        sinon.restore();
        try { fs.unlinkSync(pub.queuePath); } catch (_) {}
    };

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('_enqueue appends a JSON line and readQueue parses it back', function () {
        const entry = { ts: 12345, requestId: '11'.repeat(32), wire: 'ATTEST|1|...' };
        pub._enqueue(entry);
        const entries = pub.readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('11'.repeat(32));
        expect(entries[0].wire).to.equal('ATTEST|1|...');
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('_enqueue appends multiple entries correctly', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._enqueue({ ts: 2, requestId: 'bb'.repeat(32), wire: 'W2' });
        const entries = pub.readQueue();
        expect(entries).to.have.length(2);
        expect(entries[0].requestId).to.equal('aa'.repeat(32));
        expect(entries[1].requestId).to.equal('bb'.repeat(32));
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('readQueue returns [] when the file does not exist', function () {
        fs.unlinkSync(pub.queuePath);
        expect(pub.readQueue()).to.deep.equal([]);
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('readQueue skips malformed JSON lines', function () {
        fs.writeFileSync(pub.queuePath, 'not json\n{"requestId":"aa".repeat(32),"wire":"W"}\n');
        // The second line is also not valid JSON as written; let's write proper content
        fs.writeFileSync(pub.queuePath,
            'not json\n' +
            JSON.stringify({ requestId: 'aa'.repeat(32), wire: 'W' }) + '\n'
        );
        const entries = pub.readQueue();
        // malformed line is skipped; valid line is parsed
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('aa'.repeat(32));
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('readQueue filters entries without requestId or wire', function () {
        fs.writeFileSync(pub.queuePath,
            JSON.stringify({ requestId: 'aa'.repeat(32) }) + '\n' +  // missing wire
            JSON.stringify({ wire: 'W' }) + '\n' +                     // missing requestId
            JSON.stringify({ requestId: 'bb'.repeat(32), wire: 'W2' }) + '\n'
        );
        const entries = pub.readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('bb'.repeat(32));
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('rewriteQueue replaces file contents with the given entries', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._enqueue({ ts: 2, requestId: 'bb'.repeat(32), wire: 'W2' });
        pub.rewriteQueue([{ ts: 3, requestId: 'cc'.repeat(32), wire: 'W3' }]);
        const entries = pub.readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('cc'.repeat(32));
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('rewriteQueue with empty array clears the file', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub.rewriteQueue([]);
        const entries = pub.readQueue();
        expect(entries).to.have.length(0);
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('removeFromQueue removes matching IDs and keeps others', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub._enqueue({ ts: 2, requestId: 'BB'.repeat(32), wire: 'W2' });  // uppercase, tests lowercasing
        pub._enqueue({ ts: 3, requestId: 'cc'.repeat(32), wire: 'W3' });
        pub.removeFromQueue(new Set(['aa'.repeat(32), 'bb'.repeat(32)]));  // lowercase drop set
        const entries = pub.readQueue();
        expect(entries).to.have.length(1);
        expect(entries[0].requestId).to.equal('cc'.repeat(32));
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('removeFromQueue is a no-op for empty drop set', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub.removeFromQueue(new Set());
        expect(pub.readQueue()).to.have.length(1);
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('removeFromQueue is a no-op for null drop set', function () {
        pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        pub.removeFromQueue(null);
        expect(pub.readQueue()).to.have.length(1);
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('_enqueue logs critical + returns false (does not throw) when queue path is unwritable (item 2681)', function () {
        const errStub = sinon.stub(console, 'error');
        pub.queuePath = '/nonexistent-root/cannot-write.jsonl';
        let ok = pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' });
        expect(ok).to.equal(false);
        expect(errStub.called).to.equal(true);
        expect(pub._enqueueFailures).to.equal(1);
        errStub.restore();
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('_enqueue returns true on a durable write (item 2681)', function () {
        expect(pub._enqueue({ ts: 1, requestId: 'aa'.repeat(32), wire: 'W1' })).to.equal(true);
    }); });

describe('AttestationPublisher: queue I/O', function () { beforeEach(hookAt19388); afterEach(hookAt19647); it('rewriteQueue logs error (does not throw) on unwritable path', function () {
        const errStub = sinon.stub(console, 'error');
        pub.queuePath = '/nonexistent-root/cannot-write.jsonl';
        pub.rewriteQueue([]);
        expect(errStub.called).to.equal(true);
        errStub.restore();
    }); });
}
