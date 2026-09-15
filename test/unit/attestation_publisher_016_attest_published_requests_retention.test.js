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
const ENV_KEY = 'ATTEST_PUBLISHED_REQUESTS_RETENTION_MS';

const RID_A   = 'a1'.repeat(32);

const RID_B   = 'b2'.repeat(32);

const hookAt97681 = function () {
        delete process.env[ENV_KEY];
        sinon.restore();
    };

// A db double that records every statement and reports a fixed delete count, so
    // the assertions are about the STATEMENT the sweep issues (the invariants live
    // in its predicates) rather than about a re-implementation of MariaDB.
    function mkDb(affected, failOnDelete) {
        const seen = [];
        return { ...DB_METHODS,
            seen,
            doQuery: async (sql, params) => {
                seen.push({ sql, params });
                if (/^\s*DELETE/i.test(sql)) {
                    if (failOnDelete) throw new Error('ER_LOCK_WAIT_TIMEOUT');
                    return { affectedRows: affected === undefined ? 0 : affected };
                }
                return [];
            }
        };
    }

const deletes = (db) => db.seen.filter(q => /^\s*DELETE/i.test(q.sql));

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('defaults to a ~90-day window and honours p2pConfig, the env var, and 0 as "off"', function () {
        expect(makePublisher(MY_PUB).publishedRequestsRetentionMs).to.equal(7776000000);

        const cfgPub = new AttestationPublisher(makeHub(MY_PUB, { p2pConfig: { [ENV_KEY]: '500000' } }));
        expect(cfgPub.publishedRequestsRetentionMs).to.equal(500000);

        process.env[ENV_KEY] = '77000';
        const envPub = new AttestationPublisher(makeHub(MY_PUB, { p2pConfig: { [ENV_KEY]: '500000' } }));
        expect(envPub.publishedRequestsRetentionMs, 'the env var wins over p2pConfig').to.equal(77000);
        delete process.env[ENV_KEY];

        const off = new AttestationPublisher(makeHub(MY_PUB, { p2pConfig: { [ENV_KEY]: '0' } }));
        expect(off.publishedRequestsRetentionMs).to.equal(0);

        for (const bad of ['abc', '-5', '']) {
            const pub = new AttestationPublisher(makeHub(MY_PUB, { p2pConfig: { [ENV_KEY]: bad } }));
            expect(pub.publishedRequestsRetentionMs, 'input ' + JSON.stringify(bad)).to.equal(7776000000);
        }
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('issues a DELETE carrying the sent_at IS NOT NULL filter, which is the quarantine invariant', async function () {
        const db  = mkDb(2);
        const pub = makePublisher(MY_PUB, { db, p2pConfig: { [ENV_KEY]: '600000' } });
        fs.writeFileSync(pub.queuePath, '');

        expect(await pub.prunePublishedRequests()).to.equal(2);

        const del = deletes(db);
        expect(del.length, 'no DELETE was issued').to.equal(1);
        expect(del[0].sql).to.match(/FROM\s+attest_published_requests/i);
        expect(del[0].sql, 'the quarantine filter is the safety constraint of this item')
            .to.match(/sent_at\s+IS\s+NOT\s+NULL/i);
        expect(del[0].sql, 'the cutoff must be DB-clock arithmetic, not a Node-side timestamp')
            .to.match(/DATE_SUB\(NOW\(\),\s*INTERVAL\s+\?\s+SECOND\)/i);
        expect(del[0].params[0]).to.equal(600);
        expect(pub.publishedRequestsPruned).to.equal(2);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('never prunes a marker for a request still sitting on the durable WAL', async function () {
        // RID_A has drained off the queue; RID_B has not. Pruning B's marker would let
        // the next sweep re-broadcast it and spend a second BTC fee, so the statement
        // excludes it by identity (the rid analogue of the oracle queue-floor clamp).
        const db  = mkDb(1);
        const pub = makePublisher(MY_PUB, { db, p2pConfig: { [ENV_KEY]: '600000' } });
        writeQueue(pub.queuePath, [{ ts: Date.now(), requestId: RID_B.toUpperCase(), wire: 'ATTEST|1|x' }]);

        await pub.prunePublishedRequests();

        const del = deletes(db)[0];
        expect(del.sql).to.match(/request_id\s+NOT\s+IN\s*\(\?\)/i);
        expect(del.params.slice(1), 'the queued rid is excluded, lower-cased to match the stored form')
            .to.deep.equal([RID_B]);
        expect(del.params, 'the drained rid is not excluded').to.not.include(RID_A);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('skips the sweep entirely when the queue is too deep to exclude safely', async function () {
        sinon.stub(console, 'warn');
        const db  = mkDb(1);
        const pub = makePublisher(MY_PUB, { db, p2pConfig: { [ENV_KEY]: '600000' } });
        const many = [];
        for (let i = 0; i < 5001; i++) many.push({ ts: Date.now(), requestId: 'ff'.repeat(31) + (i % 100).toString(16).padStart(2, '0'), wire: 'w' });
        writeQueue(pub.queuePath, many);

        expect(await pub.prunePublishedRequests()).to.equal(0);
        expect(deletes(db).length, 'a queue that deep is a drain failure, not a retention problem').to.equal(0);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('floors the window at the longest live provider deadline window, so a short setting cannot delete a re-presentable marker', async function () {
        // 100 blocks x 600000 ms x the safety multiple = 240000 s, far above the
        // 60 s the operator configured. The floor is re-derived from the registry
        // rather than from any baked 100-block figure.
        const db  = mkDb(0);
        const pub = makePublisher(MY_PUB, {
            db,
            p2pConfig: { [ENV_KEY]: '60000' },
            providerRegistry: { maxDeadlineWindowBlocks: () => ({ blocks: 100, providerId: 'http_get' }) }
        });
        fs.writeFileSync(pub.queuePath, '');

        await pub.prunePublishedRequests();
        expect(deletes(db)[0].params[0]).to.equal(240000);

        // Governance widening the window widens the floor with it.
        const db2  = mkDb(0);
        const pub2 = makePublisher(MY_PUB, {
            db: db2,
            p2pConfig: { [ENV_KEY]: '60000' },
            providerRegistry: { maxDeadlineWindowBlocks: () => ({ blocks: 1000, providerId: 'slow_provider' }) }
        });
        fs.writeFileSync(pub2.queuePath, '');
        await pub2.prunePublishedRequests();
        expect(deletes(db2)[0].params[0]).to.equal(2400000);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('leaves a configured window that already clears the floor alone', async function () {
        const db  = mkDb(0);
        const pub = makePublisher(MY_PUB, {
            db,
            p2pConfig: { [ENV_KEY]: String(7776000000) },
            providerRegistry: { maxDeadlineWindowBlocks: () => ({ blocks: 100, providerId: 'http_get' }) }
        });
        fs.writeFileSync(pub.queuePath, '');
        await pub.prunePublishedRequests();
        expect(deletes(db)[0].params[0]).to.equal(7776000);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('issues no DELETE when retention is off, no DB is wired, or no registry answers', async function () {
        const dbOff = mkDb(1);
        const off   = makePublisher(MY_PUB, { db: dbOff, p2pConfig: { [ENV_KEY]: '0' } });
        fs.writeFileSync(off.queuePath, '');
        expect(await off.prunePublishedRequests()).to.equal(0);
        expect(deletes(dbOff).length).to.equal(0);

        const noDb = makePublisher(MY_PUB, { p2pConfig: { [ENV_KEY]: '600000' } });
        fs.writeFileSync(noDb.queuePath, '');
        expect(await noDb.prunePublishedRequests()).to.equal(0);

        // No registry: the floor contributes nothing and the configured window stands.
        const dbNoReg = mkDb(0);
        const noReg   = makePublisher(MY_PUB, { db: dbNoReg, p2pConfig: { [ENV_KEY]: '600000' } });
        fs.writeFileSync(noReg.queuePath, '');
        expect(noReg.publishedRetentionFloorMs()).to.equal(0);
        await noReg.prunePublishedRequests();
        expect(deletes(dbNoReg)[0].params[0]).to.equal(600);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('sweeps after a pass that published, and not on a pass that published nothing', async function () {
        const db  = mkDb(1);
        const pub = makePublisher(MY_PUB, { db, p2pConfig: { [ENV_KEY]: '600000' } });
        fs.writeFileSync(pub.queuePath, '');

        await pub._processQueue();
        await pub._retentionSweep;
        expect(deletes(db).length, 'nothing published yet, so nothing to age out').to.equal(0);

        // A confirmed marker landing is what arms the sweep.
        await pub.markPublished(RID_A, 'tx-1');
        expect(pub._markersAddedSinceSweep).to.equal(true);
        await pub._processQueue();
        await pub._retentionSweep;
        expect(deletes(db).length).to.equal(1);
        expect(pub.publishedRequestsPruned).to.equal(1);

        // Disarmed again: a second pass with no new marker must not re-sweep.
        await pub._processQueue();
        await pub._retentionSweep;
        expect(deletes(db).length).to.equal(1);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('never lets a retention failure break the broadcast pass, and never sweeps while disabled', async function () {
        sinon.stub(console, 'warn');
        const db  = mkDb(0, true);   // every DELETE throws
        const pub = makePublisher(MY_PUB, { db, p2pConfig: { [ENV_KEY]: '600000' } });
        fs.writeFileSync(pub.queuePath, '');
        await pub.markPublished(RID_A, 'tx-1');

        await pub._processQueue();          // must not reject
        await pub._retentionSweep;          // the rejection is swallowed inside
        expect(pub.publishedRequestsPruned).to.equal(0);

        pub.enabled = false;
        pub._markersAddedSinceSweep = true;
        pub._retentionSweep = null;
        await pub._processQueue();
        expect(pub._retentionSweep, 'a paused publisher touches nothing').to.equal(null);
    }); });

describe('AttestationPublisher: attest_published_requests retention (#4869)', function () { afterEach(hookAt97681); it('surfaces the window and the lifetime prune count through getPublisherStats()', function () {
        const pub = makePublisher(MY_PUB, { p2pConfig: { [ENV_KEY]: '250000' } });
        pub.publishedRequestsPruned = 7;
        const stats = pub.getPublisherStats();
        expect(stats.publishedRequestsRetentionMs).to.equal(250000);
        expect(stats.publishedRequestsPruned).to.equal(7);
    }); });
}
