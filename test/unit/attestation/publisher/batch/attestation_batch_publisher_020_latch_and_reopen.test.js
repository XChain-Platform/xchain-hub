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
 * XChain Hub - AttestationBatchPublisher: what a failed window records, and what
 * a retraction reopens.
 *
 * A window that latches must say what already left (the head of a multi-wire
 * window, or the funding and reveal of a two-phase hook); a window refused on every
 * allowed attempt sent nothing and is dead-lettered rather than quarantined as a
 * crash; a wallet-sign failure is a pre-send failure; and a retraction reopens the
 * window whether it was `landed` or only `sent`, including one older than the
 * catch-up horizon. The marker table is a small in-memory store that answers the
 * real statement text, so a statement the publisher does not send cannot pass.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const AttestationBatchPublisher = require('../../../../../src/attestation/batch_publisher.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const NET = 'regtest';
const W = 10;

function matchMarker(markers, ws, extra) {
    return markers.find(m => m.network === NET && Number(m.window_start) === Number(ws) && extra(m));
}

function deleteRow(markers, args) {
    let [, ws, status] = args;
    let idx = markers.findIndex(m => Number(m.window_start) === Number(ws) && m.status === status);
    if (idx < 0) return { affectedRows: 0 };
    markers.splice(idx, 1);
    return { affectedRows: 1 };
}

function updateStatus(markers, args) {
    let [to, , ws, we, from] = args;
    let m = matchMarker(markers, ws, r => Number(r.window_end) === Number(we) && r.status === from);
    if (!m) return { affectedRows: 0 };
    m.status = to;
    return { affectedRows: 1 };
}

function updateIntentTxid(markers, args) {
    let [txid, , ws, status] = args;
    let m = matchMarker(markers, ws, r => r.status === status && r.txid == null);
    if (!m) return { affectedRows: 0 };
    m.txid = txid;
    return { affectedRows: 1 };
}

function insertIgnore(markers, args) {
    let [network, ws, we, key, rc, status] = args;
    if (markers.some(m => Number(m.window_start) === Number(ws))) return { affectedRows: 0 };
    markers.push({ network, window_start: ws, window_end: we, batch_key: key, row_count: rc, txid: null, status });
    return { affectedRows: 1 };
}

// The receive half's landed upsert: any existing row becomes `landed`, keeping its txid.
function upsertLanded(markers, args) {
    let [network, ws, we, rc, txid, status] = args;
    let m = matchMarker(markers, ws, () => true);
    if (m) { Object.assign(m, { status, row_count: rc, txid: m.txid == null ? txid : m.txid }); return { affectedRows: 2 }; }
    markers.push({ network, window_start: ws, window_end: we, row_count: rc, txid, status });
    return { affectedRows: 1 };
}

// Exact statement text only: a regex loose enough to accept the old statements
// for the new ones would let a publisher that never sends them pass.
function route(markers, sql, args) {
    if (/^DELETE FROM attest_published_batches WHERE network = \? AND window_start = \? AND status = \?$/.test(sql))
        return deleteRow(markers, args);
    if (/^UPDATE attest_published_batches SET status = \? WHERE network = \? AND window_start = \? AND window_end = \? AND status = \?$/.test(sql))
        return updateStatus(markers, args);
    if (/^UPDATE attest_published_batches SET txid = \? WHERE network = \? AND window_start = \? AND status = \? AND txid IS NULL$/.test(sql))
        return updateIntentTxid(markers, args);
    if (/^SELECT window_start FROM attest_published_batches WHERE network = \? AND status = \?$/.test(sql))
        return markers.filter(m => m.status === args[1]).map(m => ({ window_start: m.window_start }));
    if (/^SELECT network, window_start, window_end, batch_key, row_count, txid, status FROM attest_published_batches WHERE network = \? AND window_start = \?$/.test(sql)) {
        let m = matchMarker(markers, args[1], () => true);
        return m ? [Object.assign({}, m)] : [];
    }
    if (/^INSERT IGNORE INTO attest_published_batches/.test(sql)) return insertIgnore(markers, args);
    if (/^INSERT INTO attest_published_batches \(network, window_start, window_end, row_count, txid, status, landed_at\)/.test(sql))
        return upsertLanded(markers, args);
    throw new Error('unexpected statement: ' + sql);
}

function makeDb() {
    let markers = [];
    return Object.assign({}, DB_METHODS, {
        markers,
        marker: (ws) => markers.find(m => Number(m.window_start) === Number(ws)) || null,
        async doQuery(sql, args) { return route(markers, String(sql).trim(), args || []); }
    });
}

// A publisher over the real prototype with only the state these paths read.
function makePublisher(db, dir, opts) {
    let p = Object.create(AttestationBatchPublisher.prototype);
    let tokens = { committed: 0, released: 0 };
    Object.assign(p, {
        hub: { db }, network: NET, windowS: W, _floorWindow: null,
        maxRefusalAttempts: (opts && opts.maxRefusalAttempts) || 3,
        _refusalAttempts: new Map(), _quarantined: new Set(), _reopenedOffers: new Map(),
        _coverageGaps: new Set(), _newestMarkerWindow: null,
        deadLetterPath: path.join(dir, 'deadletter.jsonl'), bufferPath: path.join(dir, 'buffer.jsonl'),
        reopenSeenPath: path.join(dir, 'buffer.reopened.json'), _reopenSeen: null,
        stats: { windowsDeferred: 0, wiresBroadcast: 0, windowsDeadLettered: 0, windowsRefusalRetried: 0,
                 windowsQuarantined: 0, windowsPublished: 0, rowsPublished: 0 },
        spendGuard: { reserve: () => ({}), commit() { tokens.committed++; }, release() { tokens.released++; },
                      noteBlocked: () => 'blocked' },
        balanceAllows: async () => true,
        // The DOGE tip the reopen wait counts on; regtest waits 3 blocks.
        readReopenTip: async () => ctx.tip
    });
    return { p, tokens };
}

function deadLetters(dir) {
    let file = path.join(dir, 'deadletter.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}

const WINDOW = { network: NET, window_start: 100, window_end: 110, row_count: 1, btc_block_height: 5,
                 rows: [{ request_id: 'r1' }] };

// One case's database and scratch directory, shared by the registered groups below.
const ctx = { dir: null, db: null, tip: 1000 };

describe('AttestationBatchPublisher latch evidence and retraction reopen', function () {
    beforeEach(function () {
        ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-latch-'));
        ctx.db = makeDb();
        ctx.tip = 1000;
    });
    afterEach(function () { fs.rmSync(ctx.dir, { recursive: true, force: true }); });
    registerLatchTests();
    registerRefusalTests();
    registerReopenTests();
    registerReopenWaitTests();
    registerReopenHorizonTests();
});

function registerLatchTests() {
    it('records the head txid on the intent marker when a later wire fails', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        let n = 0;
        p.broadcastFn = async () => {
            if (n++ === 0) return { txid: 'aa'.repeat(32) };
            throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        };
        expect(await p.broadcastWindow(WINDOW, 'k'.repeat(64), { wires: ['w0', 'w1'] })).to.equal(false);
        expect(ctx.db.marker(100)).to.include({ status: 'intent', txid: 'aa'.repeat(32) });
        expect(deadLetters(ctx.dir)[0]).to.include({ window_start: 100, failed_wire: 2, head_txid: 'aa'.repeat(32) });
    });

    it('keeps the funding and the signed reveal of a head that failed after money moved', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        p.broadcastFn = async () => {
            throw Object.assign(new Error('reveal refused'), {
                rpcCode: -32010, rpcData: { reason: 'NODE_REJECTED' }, fundsCommitted: true,
                phase1Txid: 'cc'.repeat(32), revealTxid: 'dd'.repeat(32), revealTxHex: '0200beef' });
        };
        expect(await p.broadcastWindow(WINDOW, 'k'.repeat(64), { wires: ['w0'] })).to.equal(false);
        expect(ctx.db.marker(100)).to.include({ status: 'intent', txid: 'dd'.repeat(32) });
        expect(deadLetters(ctx.dir)[0]).to.include({ phase1Txid: 'cc'.repeat(32), revealTxid: 'dd'.repeat(32),
                                                     revealTxHex: '0200beef' });
    });

    it('tags a wallet-sign failure as never sent, so the window is retried rather than quarantined', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        p.encoder = { getUtxos: async () => [{ txid: 'ee'.repeat(32), vout: 0, value: 1e8, confirmations: 6 }],
                      createTx: async () => ({ psbt: 'p', encoding: 'OP_RETURN' }),
                      releaseInputs: async () => {} };
        p.dogeAddress = 'DTest';
        p.walletSignFn = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
        let err = null;
        try { await p.defaultBroadcast('payload'); } catch (e) { err = e; }
        expect(err && err.neverSent).to.equal(true);
    });
}

function registerRefusalTests() {
    it('dead-letters a window refused on every allowed attempt instead of quarantining it', async function () {
        let { p, tokens } = makePublisher(ctx.db, ctx.dir, { maxRefusalAttempts: 1 });
        p.broadcastFn = async () => { throw Object.assign(new Error('rate limited'), { response: { status: 429 } }); };
        expect(await p.broadcastWindow(WINDOW, 'k'.repeat(64), { wires: ['w0', 'w1'] })).to.equal(false);
        expect(ctx.db.marker(100)).to.include({ status: 'deadletter' });
        expect(tokens).to.deep.equal({ committed: 0, released: 2 });
        expect(deadLetters(ctx.dir)[0]).to.include({ window_start: 100, never_sent: true });
        // A dead-lettered window is settled: the sweep neither proposes nor quarantines it.
        expect((await p.pendingWindows(115)).map(w => w.windowStart)).to.not.include(100);
        expect(p._quarantined.has(100)).to.equal(false);
    });
}

function registerReopenTests() {
    it('reopens a window whose own sent marker a retraction un-landed', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        ctx.db.markers.push({ network: NET, window_start: 100, window_end: 110, txid: 'ff'.repeat(32), status: 'sent' });
        await p.reopenLandedWindow(100, 110);
        expect(ctx.db.marker(100).status).to.equal('reopened');
        // The first sweep to see it starts the wait; three DOGE blocks later it is offered.
        expect((await p.pendingWindows(125)).map(w => w.windowStart)).to.not.include(100);
        ctx.tip = 1002;
        expect((await p.pendingWindows(135)).map(w => w.windowStart)).to.not.include(100);
        ctx.tip = 1003;
        expect(await p.pendingWindows(135)).to.deep.include({ windowStart: 100, age: 2, reopened: true });
    });

}

function registerReopenWaitTests() {
    it('keeps the reopen wait across a restart', async function () {
        let first = makePublisher(ctx.db, ctx.dir).p;
        ctx.db.markers.push({ network: NET, window_start: 100, window_end: 110, status: 'landed' });
        await first.reopenLandedWindow(100, 110);
        await first.pendingWindows(125);
        let restarted = makePublisher(ctx.db, ctx.dir).p;
        ctx.tip = 1002;
        expect((await restarted.pendingWindows(130)).map(w => w.windowStart)).to.not.include(100);
        ctx.tip = 1003;
        expect((await restarted.pendingWindows(135)).map(w => w.windowStart)).to.include(100);
    });

    it('never counts a lower reported tip toward the wait', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        ctx.db.markers.push({ network: NET, window_start: 100, window_end: 110, status: 'landed' });
        await p.reopenLandedWindow(100, 110);
        await p.pendingWindows(125);                     // first sighting at tip 1000
        for (let tip of [500, 501, 502, 503, 999]) {     // a lagging replica
            ctx.tip = tip;
            expect((await p.pendingWindows(135)).map(w => w.windowStart)).to.not.include(100);
        }
        ctx.tip = null;                                  // no tip: nothing is offered
        expect((await p.pendingWindows(135)).map(w => w.windowStart)).to.not.include(100);
    });

    it('starts a second reopen of the same window from its own sighting', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        ctx.db.markers.push({ network: NET, window_start: 100, window_end: 110, status: 'landed' });
        await p.reopenLandedWindow(100, 110);
        await p.pendingWindows(125);                     // first reopen sighted at tip 1000
        ctx.tip = 1010;
        await p.recordLandedWindow(100, 110, 'aa'.repeat(32), 1);   // the original re-landed
        await p.reopenLandedWindow(100, 110);            // and a second reorg reopens it
        expect((await p.pendingWindows(135)).map(w => w.windowStart)).to.not.include(100);
        ctx.tip = 1013;
        expect((await p.pendingWindows(135)).map(w => w.windowStart)).to.include(100);
    });

    it('publishes no reopened window when the chain cannot be asked', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        p.fetchLandedAttestBatches = async () => null;
        let pending = [{ windowStart: 100, age: 0, reopened: true }, { windowStart: 120, age: 0 }];
        expect(await p.reconcilePendingAgainstChain(pending)).to.deep.equal([{ windowStart: 120, age: 0 }]);
    });

}

function registerReopenHorizonTests() {
    it('offers a reopened window older than the catch-up horizon after its wait, climbing the ladder per sweep', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        ctx.db.markers.push({ network: NET, window_start: 100, window_end: 110, txid: 'ff'.repeat(32), status: 'landed' });
        await p.reopenLandedWindow(100, 110);
        expect((await p.pendingWindows(205)).map(w => w.windowStart)).to.not.include(100);
        ctx.tip = 1003;
        let first  = await p.pendingWindows(215);
        let second = await p.pendingWindows(215);
        expect(first[0]).to.deep.equal({ windowStart: 100, age: 0, reopened: true });
        expect(second[0]).to.deep.equal({ windowStart: 100, age: 1, reopened: true });
        expect(await p.claimWindowForBroadcast(WINDOW, 'k'.repeat(64), 'reopened')).to.equal(true);
        expect(ctx.db.marker(100).status).to.equal('intent');
        expect(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'buffer.reopened.json'), 'utf8'))).to.deep.equal({});
    });

    it('leaves an intent, a deadletter and another window end alone', async function () {
        let { p } = makePublisher(ctx.db, ctx.dir);
        ctx.db.markers.push({ network: NET, window_start: 100, window_end: 110, status: 'intent' },
                            { network: NET, window_start: 200, window_end: 210, status: 'deadletter' },
                            { network: NET, window_start: 300, window_end: 311, status: 'landed' });
        await p.reopenLandedWindow(100, 110);
        await p.reopenLandedWindow(200, 210);
        await p.reopenLandedWindow(300, 310);
        expect(ctx.db.markers.map(m => m.status)).to.deep.equal(['intent', 'deadletter', 'landed']);
    });
}
