'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -


const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const path           = require('path');
const os             = require('os');
const { DB_METHODS } = require('../helpers/mockHub');


let fsMock;
let OraclePublisher;

function loadModule() {
    fsMock = {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns('')
    };
    OraclePublisher = proxyquire('../../src/oracle/publisher', {
        fs: fsMock,
        '../peers/encoder_client': function () { return null; }
    });
}

function makeIdentity(pubkey) {
    return {
        getPubkeyHex: sinon.stub().returns(pubkey || 'aa'.repeat(32)),
        sign:         sinon.stub().returns('bb'.repeat(64))
    };
}

function makeHub(overrides) {
    return {
        p2pConfig:          overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getIdentity:        sinon.stub().returns(makeIdentity()),
        capabilityRegistry: overrides && overrides.capabilityRegistry !== undefined
            ? overrides.capabilityRegistry : null,
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        oracleConsensus:    overrides && overrides.oracleConsensus !== undefined
            ? overrides.oracleConsensus : null,
        ...(overrides || {})
    };
}


function makeDb(seed) {
    let markers = Object.assign({}, seed || {});
    let db = {


        ...DB_METHODS,
        markers,
        doQuery: sinon.stub().callsFake(async function (q, args) {
            if (/^\s*SELECT/i.test(q)) {
                if (/WHERE\s+round/i.test(q)) {
                    let r = Number(args[0]);
                    return markers[r] ? [markers[r]] : [];
                }
                return Object.keys(markers).map(k => markers[k]);
            }
            if (/^\s*INSERT/i.test(q)) {
                let r = Number(args[0]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                return { affectedRows: 1 };
            }
            if (/^\s*UPDATE/i.test(q)) {
                let txid = args[0];
                let r    = Number(args[args.length - 1]);
                if (!markers[r]) markers[r] = { round: r, txid: null, sent_at: null };
                markers[r].txid    = txid;
                markers[r].sent_at = '2026-01-01 00:00:00';
                return { affectedRows: 1 };
            }


            if (/^\s*DELETE/i.test(q)) {
                let cutoff       = Number(args[0]);
                let confirmedOnly = /sent_at\s+IS\s+NOT\s+NULL/i.test(q);
                let deleted = 0;
                for (let k of Object.keys(markers)) {
                    let row = markers[k];
                    if (!(Number(row.round) < cutoff)) continue;
                    if (confirmedOnly && (row.sent_at === null || row.sent_at === undefined)) continue;
                    delete markers[k];
                    deleted++;
                }
                return { affectedRows: deleted };
            }
            return [];
        })
    };
    return db;
}

function oraclePublisherTests(title, registerTests) {
    describe('OraclePublisher', function () {
        beforeEach(function () {
            loadModule();
        });

        afterEach(function () {
            sinon.restore();
        });

        describe(title, registerTests);
    });
}


// ── _processQueue ─────────────────────────────────────────────────────────

oraclePublisherTests('_processQueue()', function () {
    it('returns early when queue is empty', async function () {
        fsMock.readFileSync.returns('');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        await pub._processQueue();  // must not throw
    });

    it('calls custom broadcastFn for each queued entry', async function () {
        let entry = { round: 5, btcBlockTime: 1700000000, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let broadcastStub = sinon.stub().resolves({ txid: 'abc123' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);
        await pub._processQueue();
        expect(broadcastStub.calledOnce).to.be.true;
    });

    it('increments attempts and keeps entry in queue when broadcast fails', async function () {
        let entry = { round: 5, btcBlockTime: 1700000000, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.broadcastFn  = sinon.stub().rejects(new Error('network down'));
        pub.getBalanceFn = sinon.stub().resolves(50);
        await pub._processQueue();
        // Rewrite should have been called with the entry (attempts=1)
        expect(fsMock.writeSync.called).to.be.true;
    });

    it('discards entries that have exceeded max attempts', async function () {
        let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 5 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.broadcastFn  = sinon.stub().resolves({ txid: 'abc' });
        pub.getBalanceFn = sinon.stub().resolves(50);
        await pub._processQueue();
        // Broadcast should NOT have been called (entry already exceeded maxAttempts=5)
        expect(pub.broadcastFn.called).to.be.false;
    });

});

oraclePublisherTests('_processQueue()', function () {

    it('logs warning when no broadcast pipeline is configured', async function () {
        let entry = { round: 1, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        // No broadcastFn, no encoder, no walletSignFn
        pub.getBalanceFn = sinon.stub().resolves(50);
        await pub._processQueue();  // must not throw
    });

});


// ── At-most-once under queue-rewrite failure ───────────────────────────────
// Regression for the swallowed rewriteQueue failure that let an already-
// published round stay on the durable queue and be re-broadcast on the next
// tick, spending real DOGE twice for the same PRICE v0 round.
oraclePublisherTests('_processQueue() at-most-once under rewrite failure', function () {
    it('broadcasts a round exactly once even when the post-broadcast queue rewrite keeps failing', async function () {
        let entry = { round: 7, btcBlockTime: 1700000000, prices: [], sigs: [], attempts: 0 };
        // The queue file durably retains the entry on every read, simulating a
        // rewrite that never truncates it (disk full / permissions flip after a
        // successful broadcast).
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        // Force every queue rewrite (openSync 'w') to fail.
        fsMock.openSync.throws(new Error('ENOSPC: no space left on device'));
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        let broadcastStub = sinon.stub().resolves({ txid: 'tx-7' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue(); // tick 1: broadcasts round 7, rewrite fails
        await pub._processQueue(); // tick 2: entry still on queue; must NOT re-broadcast

        expect(broadcastStub.calledOnce).to.be.true;
        expect(pub._publishedRounds.has(7)).to.be.true;
    });

    it('keeps the dedup guard armed and surfaces a CRITICAL error when the rewrite fails', async function () {
        let entry = { round: 8, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        fsMock.openSync.throws(new Error('EACCES: permission denied'));
        let errStub = sinon.stub(console, 'error');
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.broadcastFn  = sinon.stub().resolves({ txid: 'tx-8' });
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue();

        expect(pub._publishedRounds.has(8)).to.be.true;
        let loggedCritical = errStub.getCalls().some(c => String(c.args[0]).includes('CRITICAL'));
        expect(loggedCritical).to.be.true;
    });

    it('clears the dedup guard after a successful queue rewrite so it does not grow unbounded', async function () {
        let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        // openSync default returns 99 (success), so the rewrite succeeds.
        let hub = makeHub();
        let pub = new OraclePublisher(hub);
        pub.broadcastFn  = sinon.stub().resolves({ txid: 'tx-9' });
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue();

        expect(pub._publishedRounds.size).to.equal(0);
    });

});


// ── Durable at-most-once across a restart (oracle_published_rounds) ─────────
// Regression for the in-memory-only guard: a restart with an empty _publishedRounds
// Set but the round still on the durable JSONL queue re-broadcast an already-paid
// PRICE v0 round, spending DOGE twice. The durable marker table makes the guard
// survive the restart.
oraclePublisherTests('_processQueue() durable at-most-once', function () {
    it('records a durable intent before broadcast and a sent marker after (happy path)', async function () {
        let entry = { round: 20, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let db  = makeDb();
        let pub = new OraclePublisher(makeHub({ db: db }));
        let broadcastStub = sinon.stub().resolves({ txid: 'tx-20' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue();

        expect(broadcastStub.calledOnce).to.be.true;
        // Intent (INSERT) must precede the send, and the sent marker (UPDATE) follow it.
        let inserted = db.doQuery.getCalls().some(c => /INSERT/i.test(c.args[0]) && Number(c.args[1][0]) === 20);
        let updated  = db.doQuery.getCalls().some(c => /UPDATE/i.test(c.args[0]));
        expect(inserted).to.be.true;
        expect(updated).to.be.true;
        expect(db.markers[20].txid).to.equal('tx-20');
        expect(db.markers[20].sent_at).to.not.be.null;
    });

    it('does NOT re-broadcast a round that already has a durable sent marker (restart with round still on the queue)', async function () {
        // Simulate a restart: the round is still on the durable JSONL queue, the
        // in-process Set is empty, but the DB already holds a sent marker.
        let entry = { round: 21, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let db  = makeDb({ 21: { round: 21, txid: 'tx-21', sent_at: '2026-01-01 00:00:00' } });
        let pub = new OraclePublisher(makeHub({ db: db }));
        let broadcastStub = sinon.stub().resolves({ txid: 'tx-21-DUP' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        expect(pub._publishedRounds.has(21)).to.be.false; // fresh process, empty in-memory guard

        await pub._processQueue();

        expect(broadcastStub.called).to.be.false; // no duplicate DOGE spend
    });

});

oraclePublisherTests('_processQueue() durable at-most-once', function () {

    it('survives the ENOSPC rewrite-failure path across a restart (durable marker, not just in-memory)', async function () {
        // Tick 1 on process A: broadcast succeeds, then the queue rewrite fails
        // (disk full), leaving the round on the durable queue. The sent marker was
        // persisted to the DB before the rewrite failure.
        let entry = { round: 22, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        fsMock.openSync.throws(new Error('ENOSPC: no space left on device'));
        let db  = makeDb();
        let pubA = new OraclePublisher(makeHub({ db: db }));
        pubA.broadcastFn  = sinon.stub().resolves({ txid: 'tx-22' });
        pubA.getBalanceFn = sinon.stub().resolves(50);
        await pubA._processQueue();
        expect(db.markers[22] && db.markers[22].sent_at).to.not.be.null;

        // Process A dies. Process B starts fresh (empty in-memory Set) with the round
        // STILL on the JSONL queue and the sent marker present in the shared DB.
        let pubB = new OraclePublisher(makeHub({ db: db }));
        let broadcastB = sinon.stub().resolves({ txid: 'tx-22-DUP' });
        pubB.broadcastFn  = broadcastB;
        pubB.getBalanceFn = sinon.stub().resolves(50);
        await pubB.start();       // hydrate loads the sent marker into the guard
        await pubB._processQueue();

        expect(broadcastB.called).to.be.false; // NOT re-broadcast after restart
    });

    it('fails closed (does not broadcast) when the durable marker cannot be read', async function () {
        let entry = { round: 23, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let db  = makeDb();
        db.doQuery = sinon.stub().rejects(new Error('Circuit breaker open: database connections rejected'));
        let pub = new OraclePublisher(makeHub({ db: db }));
        let broadcastStub = sinon.stub().resolves({ txid: 'tx-23' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue();

        expect(broadcastStub.called).to.be.false; // fail closed: no spend when the marker is unknowable
    });

});


// ── Startup hydration / quarantine of durable markers ──────────────────────
oraclePublisherTests('start() durable-marker hydration', function () {
    it('hydrates the in-process guard from confirmed (sent) markers', async function () {
        let db  = makeDb({
            30: { round: 30, txid: 'tx-30', sent_at: '2026-01-01 00:00:00' },
            31: { round: 31, txid: 'tx-31', sent_at: '2026-01-01 00:00:00' }
        });
        let pub = new OraclePublisher(makeHub({ db: db }));
        await pub.start();
        expect(pub._publishedRounds.has(30)).to.be.true;
        expect(pub._publishedRounds.has(31)).to.be.true;
        expect(pub._quarantinedRounds.size).to.equal(0);
    });

    it('quarantines intent-only (NULL sent_at) markers and never auto-rebroadcasts them', async function () {
        let entry = { round: 32, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        // An intent row with no confirmation: a crash left the on-chain state unknown.
        let db  = makeDb({ 32: { round: 32, txid: null, sent_at: null } });
        let pub = new OraclePublisher(makeHub({ db: db }));
        let broadcastStub = sinon.stub().resolves({ txid: 'tx-32-DUP' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub.start();
        expect(pub._quarantinedRounds.has(32)).to.be.true;
        expect(pub._publishedRounds.has(32)).to.be.false;

        await pub._processQueue();
        expect(broadcastStub.called).to.be.false; // quarantined round is never re-broadcast
    });

    it('surfaces quarantined rounds via getStats().quarantined', async function () {
        let db  = makeDb({ 33: { round: 33, txid: null, sent_at: null } });
        let pub = new OraclePublisher(makeHub({ db: db }));
        await pub.start();
        expect(pub.getStats().quarantined).to.equal(1);
    });

});

