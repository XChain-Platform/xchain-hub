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


const ENV_KEY = 'ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS';

// Marker rows spanning the window: `old` are far below any cutoff, `recent`
// sits inside it. Mixed sent/intent so the quarantine filter is exercised.
function seedMarkers() {
    return {
        10:    { round: 10,    txid: 'tx-10', sent_at: '2026-01-01 00:00:00' },
        11:    { round: 11,    txid: null,    sent_at: null },   // quarantined
        12:    { round: 12,    txid: 'tx-12', sent_at: '2026-01-02 00:00:00' },
        99000: { round: 99000, txid: 'tx-99000', sent_at: '2026-06-01 00:00:00' }
    };
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


// ── oracle_published_rounds retention ────────────────────────────
// The durable marker table gained one row per published round and never lost
// one, so a money-bearing broadcast path grew a table without bound. Retention
// may only ever touch CONFIRMED rows: a sent_at NULL row is the quarantine
// marker for a round whose on-chain state is unknown and which an operator
// reconciles by hand, and no round still on the publish queue may be pruned
// (the marker is what stops a restart re-broadcasting it).
oraclePublisherTests('oracle_published_rounds retention', function () {

    afterEach(function () {
        delete process.env[ENV_KEY];
    });

    it('defaults to a 12960-round window', function () {
        let pub = new OraclePublisher(makeHub());
        expect(pub.publishedRoundsRetentionRounds).to.equal(12960);
    });

    it('reads the window from p2pConfig and lets the env var win', function () {
        let pub = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: '500' } }));
        expect(pub.publishedRoundsRetentionRounds).to.equal(500);

        process.env[ENV_KEY] = '77';
        let pub2 = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: '500' } }));
        expect(pub2.publishedRoundsRetentionRounds).to.equal(77);
    });

    it('treats 0 as "disable pruning" and garbage/negatives as "use the default"', function () {
        let off = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: '0' } }));
        expect(off.publishedRoundsRetentionRounds).to.equal(0);

        for (let bad of ['abc', '-5', '']) {
            let pub = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: bad } }));
            expect(pub.publishedRoundsRetentionRounds, 'input ' + JSON.stringify(bad)).to.equal(12960);
        }
    });

    it('prunes ONLY confirmed rows and never the intent-only quarantine markers', async function () {
        let db  = makeDb(seedMarkers());
        let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));

        let deleted = await pub.prunePublishedRounds(1000);   // cutoff 900

        expect(deleted).to.equal(2);                    // only the confirmed rounds 10 and 12
        expect(db.markers[10]).to.be.undefined;
        expect(db.markers[12]).to.be.undefined;
        expect(db.markers[11], 'quarantined intent-only row must survive forever').to.not.be.undefined;
        expect(db.markers[99000], 'row inside the window must survive').to.not.be.undefined;
        expect(pub.publishedRoundsPruned).to.equal(2);
    });

});

oraclePublisherTests('oracle_published_rounds retention', function () {

    afterEach(function () {
        delete process.env[ENV_KEY];
    });

    it('issues a DELETE that carries the sent_at IS NOT NULL filter', async function () {
        let db  = makeDb(seedMarkers());
        let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));

        await pub.prunePublishedRounds(1000);

        let del = db.doQuery.getCalls().find(c => /^\s*DELETE/i.test(c.args[0]));
        expect(del, 'no DELETE was issued').to.not.be.undefined;
        expect(del.args[0]).to.match(/FROM\s+oracle_published_rounds/i);
        expect(del.args[0], 'the quarantine filter is the safety constraint of this item')
            .to.match(/sent_at\s+IS\s+NOT\s+NULL/i);
        expect(del.args[1][0]).to.equal(900);
    });

    it('issues no DELETE when pruning is disabled, no DB is wired, or the cutoff is not yet positive', async function () {
        let dbOff = makeDb(seedMarkers());
        let off   = new OraclePublisher(makeHub({ db: dbOff, p2pConfig: { [ENV_KEY]: '0' } }));
        expect(await off.prunePublishedRounds(1000000)).to.equal(0);
        expect(dbOff.doQuery.called).to.be.false;

        let noDb = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: '10' } }));
        expect(await noDb.prunePublishedRounds(1000000)).to.equal(0);

        // Young chain: the window has not been filled yet, so nothing is old enough.
        let dbYoung = makeDb(seedMarkers());
        let young   = new OraclePublisher(makeHub({ db: dbYoung, p2pConfig: { [ENV_KEY]: '12960' } }));
        expect(await young.prunePublishedRounds(50)).to.equal(0);
        expect(dbYoung.doQuery.called).to.be.false;
    });

});

oraclePublisherTests('oracle_published_rounds retention', function () {

    afterEach(function () {
        delete process.env[ENV_KEY];
    });

    it('never prunes a marker for a round still sitting on the durable queue', async function () {
        // Round 10 is beyond the retention window but has NOT drained off the
        // queue. Pruning its marker would let a restart re-broadcast it and spend
        // DOGE twice, so the cutoff clamps below it.
        fsMock.readFileSync.returns(
            JSON.stringify({ round: 10, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 }) + '\n');
        let db  = makeDb(seedMarkers());
        let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));

        let deleted = await pub.prunePublishedRounds(1000);

        expect(deleted).to.equal(0);
        expect(db.markers[10]).to.not.be.undefined;
        expect(db.markers[12]).to.not.be.undefined;   // clamped below the queued round
        let del = db.doQuery.getCalls().find(c => /^\s*DELETE/i.test(c.args[0]));
        expect(del.args[1][0]).to.equal(10);
    });

    it('sweeps after a publish pass, and not when nothing published', async function () {
        let entry = { round: 30000, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let db  = makeDb(seedMarkers());
        let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));
        pub.broadcastFn  = sinon.stub().resolves({ txid: 'tx-30000' });
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue();
        await pub._retentionSweep;                     // fire-and-forget handle

        expect(pub.publishedRoundsPruned).to.equal(2); // confirmed rounds 10 and 12 aged out
        expect(db.markers[11], 'quarantine row survives the live path too').to.not.be.undefined;

        // A pass that publishes nothing must not sweep again.
        let before = db.doQuery.getCalls().filter(c => /^\s*DELETE/i.test(c.args[0])).length;
        fsMock.readFileSync.returns('');
        pub._retentionSweep = null;
        await pub._processQueue();
        await pub._retentionSweep;
        let after = db.doQuery.getCalls().filter(c => /^\s*DELETE/i.test(c.args[0])).length;
        expect(after).to.equal(before);
    });

});

oraclePublisherTests('oracle_published_rounds retention', function () {

    afterEach(function () {
        delete process.env[ENV_KEY];
    });

    it('never lets a retention failure break or retry the broadcast pass', async function () {
        sinon.stub(console, 'warn');
        let entry = { round: 30000, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
        fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
        let db = makeDb();
        let realQuery = db.doQuery;
        db.doQuery = sinon.stub().callsFake(async function (q, args) {
            if (/^\s*DELETE/i.test(q)) throw new Error('ER_LOCK_WAIT_TIMEOUT');
            return realQuery(q, args);
        });
        let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));
        let broadcastStub = sinon.stub().resolves({ txid: 'tx-30000' });
        pub.broadcastFn  = broadcastStub;
        pub.getBalanceFn = sinon.stub().resolves(50);

        await pub._processQueue();     // must not reject
        await pub._retentionSweep;     // rejection is swallowed inside

        expect(broadcastStub.calledOnce).to.be.true;
        expect(pub.publishedCount).to.equal(1);
        expect(pub.publishedRoundsPruned).to.equal(0);
    });

    it('surfaces the window and the lifetime prune count via getStats()', function () {
        let pub = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: '250' } }));
        pub.publishedRoundsPruned = 7;
        let stats = pub.getStats();
        expect(stats.publishedRoundsRetentionRounds).to.equal(250);
        expect(stats.publishedRoundsPruned).to.equal(7);
    });

});

