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
 * XChain Hub - OraclePublisher: the publish-intent marker across a failure and a
 * restart.
 *
 * A send proven never to have left the process withdraws its intent rows, so a
 * restart publishes the round instead of quarantining it; a round a restart does
 * quarantine leaves the queue for the dead-letter file, never silently; a named node
 * rejection keeps its rows; and a hook that failed after funding has its funding and
 * signed reveal on the dead-letter record. The marker table is an in-memory store
 * answering the real statement text, shared across the two publisher lives.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const OraclePublisher = require('../../../../src/oracle/publisher.js');
const { DB_METHODS } = require('../../../helpers/mockHub.js');

const ROUNDS = [100, 101, 102];

function route(rows, sql, args) {
    if (/^SELECT round, txid, sent_at FROM oracle_published_rounds WHERE round = \?$/.test(sql))
        return rows.filter(r => r.round === Number(args[0])).map(r => Object.assign({}, r));
    if (/^SELECT round, txid, sent_at FROM oracle_published_rounds$/.test(sql))
        return rows.map(r => Object.assign({}, r));
    if (/^INSERT INTO oracle_published_rounds \(round\)/.test(sql)) {
        if (!rows.some(r => r.round === Number(args[0]))) rows.push({ round: Number(args[0]), txid: null, sent_at: null });
        return { affectedRows: 1 };
    }
    if (/^UPDATE oracle_published_rounds SET txid = \?, sent_at = NOW\(\) WHERE round = \?$/.test(sql)) {
        let r = rows.find(x => x.round === Number(args[1]));
        if (r) { r.txid = args[0]; r.sent_at = 1; }
        return { affectedRows: r ? 1 : 0 };
    }
    if (/^UPDATE oracle_published_rounds SET txid = \? WHERE round = \? AND sent_at IS NULL AND txid IS NULL$/.test(sql)) {
        let r = rows.find(x => x.round === Number(args[1]) && x.sent_at === null && x.txid === null);
        if (r) r.txid = args[0];
        return { affectedRows: r ? 1 : 0 };
    }
    if (/^DELETE FROM oracle_published_rounds WHERE round = \? AND sent_at IS NULL$/.test(sql)) {
        let i = rows.findIndex(x => x.round === Number(args[0]) && x.sent_at === null);
        if (i >= 0) rows.splice(i, 1);
        return { affectedRows: i >= 0 ? 1 : 0 };
    }
    throw new Error('unexpected statement: ' + sql);
}

function makeDb() {
    let rows = [];
    return Object.assign({}, DB_METHODS, {
        rows,
        async doQuery(sql, args) { return route(rows, String(sql).trim(), args || []); }
    });
}

// One publisher life over the shared directory and table; a restart is a second call.
async function boot(dir, db, broadcast) {
    let p = new OraclePublisher({
        network: 'regtest', db,
        p2pConfig: { PUBLISHER_QUEUE_PATH: path.join(dir, 'queue.jsonl'),
                     ORACLE_PUBLISH_SPEND_STATE_PATH: path.join(dir, 'spend.json') },
        getIdentity: () => ({ getPubkeyHex: () => 'aa'.repeat(32), sign: () => 'dd'.repeat(64) }),
        capabilityRegistry: null, capabilitySnapshot: null, oracleConsensus: null
    });
    p.encoder = null;
    p.setBroadcastHook(broadcast);
    p.setBalanceHook(async () => 1000);
    await p.hydratePublishedMarkers();
    return p;
}

function enqueueBatch(p) {
    return p.enqueue({ round: ROUNDS[0], wire: 'PRICEB|regtest|7|' + ROUNDS.join(',') + '|sigs',
                       batch: { rounds: ROUNDS, windowIndex: 7, wireIndex: 0, firstRound: 100, lastRound: 102 } });
}

function deadLetters(dir) {
    let file = path.join(dir, 'queue.deadletter.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

function throwing(fields) {
    return async () => { throw Object.assign(new Error('refused'), fields); };
}

// One case's scratch directory and marker table, shared by the registered groups below.
const ctx = { dir: null, db: null };

describe('OraclePublisher publish intent across a failure and a restart', function () {
    beforeEach(function () {
        ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-intent-'));
        ctx.db = makeDb();
    });
    afterEach(function () { fs.rmSync(ctx.dir, { recursive: true, force: true }); });
    registerNeverSentTests();
    registerQuarantineTests();
});

function registerNeverSentTests() {
    it('withdraws the intent of a never-sent failure, so a restart publishes the round', async function () {
        let first = await boot(ctx.dir, ctx.db, throwing({ neverSent: true }));
        await enqueueBatch(first);
        await first.processQueue();
        expect(ctx.db.rows).to.deep.equal([]);

        let sent = [];
        let second = await boot(ctx.dir, ctx.db, async (payload) => { sent.push(payload); return { txid: 'ab'.repeat(32) }; });
        await second.processQueue();
        expect(sent).to.have.length(1);
        expect(ctx.db.rows.map(r => r.sent_at !== null)).to.deep.equal([true, true, true]);
    });

    it('keeps the intent of a named node rejection, which reached the node', async function () {
        let p = await boot(ctx.dir, ctx.db, throwing({ rpcCode: -32010, rpcData: { reason: 'NODE_REJECTED' },
                                                       message: 'Encoder RPC error: rejected' }));
        await enqueueBatch(p);
        await p.processQueue();
        expect(ctx.db.rows.map(r => r.round)).to.deep.equal(ROUNDS);
    });
}

function registerQuarantineTests() {
    it('moves a round a restart quarantines to the dead-letter file instead of dropping it', async function () {
        let first = await boot(ctx.dir, ctx.db, async () => ({ txid: 'ab'.repeat(32) }));
        await enqueueBatch(first);
        for (let r of ROUNDS) ctx.db.rows.push({ round: r, txid: null, sent_at: null });   // a crash after intent

        let sent = [];
        let second = await boot(ctx.dir, ctx.db, async (payload) => { sent.push(payload); return { txid: 'cd'.repeat(32) }; });
        await second.processQueue();
        expect(sent).to.deep.equal([]);
        expect(deadLetters(ctx.dir).map(d => d.round)).to.deep.equal([100]);
        expect(deadLetters(ctx.dir)[0].wire).to.match(/^PRICEB\|/);
        expect(second.readQueue()).to.deep.equal([]);
    });

    it('keeps the funding and signed reveal of a send that failed after money moved, on the record and the marker', async function () {
        let p = await boot(ctx.dir, ctx.db, throwing({ fundsCommitted: true, phase1Txid: 'cc'.repeat(32),
                                                       revealTxid: 'dd'.repeat(32), revealTxHex: '0200beef' }));
        await enqueueBatch(p);
        await p.processQueue();
        expect(deadLetters(ctx.dir)[0]).to.include({ phase1Txid: 'cc'.repeat(32), revealTxid: 'dd'.repeat(32),
                                                    revealTxHex: '0200beef' });
        // The intent rows keep quarantining and now name the reveal to look for.
        expect(ctx.db.rows).to.deep.equal(ROUNDS.map(r => ({ round: r, txid: 'dd'.repeat(32), sent_at: null })));
    });
}
