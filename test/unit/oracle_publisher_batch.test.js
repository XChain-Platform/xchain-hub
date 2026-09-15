'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// OraclePublisher PRICE batch rail (spec
// section 7). Real fs against a temp directory rather than a stubbed one, because
// the separation of the buffer file from the publish queue is the point of half
// these tests and a stub would let both "files" be the same object.

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const crypto     = require('crypto');
const sinon      = require('sinon');
const { expect } = require('chai');

const OraclePublisher = require('../../src/oracle/publisher.js');
const { waitUntil }   = require('../helpers/waitUntil');
const { PRICE_BATCH_COMPRESSION_MARKER, inflatePriceBatchBody } = require('../../src/price_batch_compression.js');
const { DB_METHODS }  = require('../helpers/mockHub.js');

const PRICE_WIRE_MAX_BYTES = 8189;

const ME    = 'aa'.repeat(32);
const PEER1 = 'bb'.repeat(32);
const PEER2 = 'cc'.repeat(32);

let tmpDirs   = [];
let instances = [];

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function hex(n, seed) {
    let out = '';
    let i = 0;
    while (out.length < n) {
        out += crypto.createHash('sha256').update(seed + ':' + (i++)).digest('hex');
    }
    return out.slice(0, n);
}

function makeIdentity(pubkey) {
    return {
        getPubkeyHex: sinon.stub().returns(pubkey || ME),
        sign:         sinon.stub().returns(hex(128, 'local-sig'))
    };
}

// Signature set shaped exactly like a real one: 64-hex pubkey, 128-hex signature,
// distinct per index so the deflate estimate is not flattered by repetition.
function sigsOf(count) {
    let out = [];
    for (let i = 0; i < count; i++) {
        out.push({ pubkey: hex(64, 'pub' + i), sig: hex(128, 'sig' + i) });
    }
    return out;
}

// High-entropy pair set. Realistic pair names compress well; these do not, which is
// what makes the split and ceiling tests measure a wire an operator could actually
// hit rather than one deflate erases.
function pairsOf(count, seed) {
    let out = [];
    for (let i = 0; i < count; i++) {
        let h = crypto.createHash('sha256').update(seed + ':' + i).digest('hex');
        out.push({ coinPair: h.slice(0, 8).toUpperCase() + '/' + h.slice(8, 16).toUpperCase(),
                   price: (parseInt(h.slice(16, 24), 16) / 1000).toFixed(6) });
    }
    return out;
}

function roundFixture(round, opts) {
    opts = opts || {};
    return {
        round:          round,
        btcBlockHeight: opts.anchor !== undefined ? opts.anchor : 800000 + round,
        btcBlockTime:   opts.time   !== undefined ? opts.time   : 1800000000 + round * 600,
        prices:         opts.pairs  || [{ coinPair: 'BTC/USD', price: '60000.12' },
                                        { coinPair: 'LTC/USD', price: '80.5' }],
        signatures:     [{ pubkey: ME, sig: hex(128, 'v0sig' + round) }]
    };
}

// The canonical builder's input shape, which is also what the buffer file holds.
function bufferedFixture(round, opts) {
    let e = roundFixture(round, opts);
    return {
        round:          e.round,
        timestamp:      e.btcBlockTime,
        btcBlockHeight: e.btcBlockHeight,
        pairs:          e.prices.map(p => ({ pair: p.coinPair, price: String(p.price) }))
    };
}

function makeSigner(opts) {
    opts = opts || {};
    let signer = {
        calls: [],
        getStats: () => ({ batchSignTimeouts: opts.timeouts || 0 }),
        start() {}, stop() {}
    };
    signer.collectBatchSignatures = sinon.stub().callsFake(async (f, l, a, rounds) => {
        signer.calls.push({ first: f, last: l, anchor: a, count: rounds.length,
                            rounds: rounds.map(r => r.round) });
        if (opts.met === false) return { met: false, sigs: sigsOf(1), firstRound: f, lastRound: l };
        return { met: true, sigs: sigsOf(opts.sigCount === undefined ? 3 : opts.sigCount),
                 firstRound: f, lastRound: l, btcBlockHeight: a, canonical: 'canonical-' + f + '-' + l };
    });
    return signer;
}

// Capability snapshot stand-in. `oracle_publish` drives leader election, `price`
// only sizes the pre-signing estimate.
function makeSnapshot(publishers, priceSet) {
    return {
        getSnapshot: sinon.stub().callsFake(async (capability) => {
            if (capability === 'oracle_publish') {
                return { validators: (publishers || [ME]).map(p => ({ pubkey: p })) };
            }
            return { validators: (priceSet || publishers || [ME]).map(p => ({ pubkey: p })) };
        })
    };
}

// In-memory stand-in for the hub DB. Models the two tables this rail reads:
// price_snapshots (self-check + observed-batch prune) and oracle_published_rounds
// (the at-most-once markers). Predicates are applied from the SQL TEXT so a
// production query that drops one really does behave differently here.
function snapshotQuery(db, q, args) {
    // The observation-feed probe asks "has ANY batch ever landed here", with
    // no round range and no args at all.
    if (!args || args.length < 2) {
        return db.snapshots.filter(s => s.batch === true).map(s => ({ seen: 1 }));
    }
    let first = Number(args[0]);
    let last  = Number(args[1]);
    let rows  = db.snapshots.filter(s => Number(s.round_number) >= first &&
                                         Number(s.round_number) <= last);
    if (/status\s*=\s*\?/i.test(q)) rows = rows.filter(s => s.status === args[2]);
    if (/consensus_proof\s+LIKE/i.test(q)) rows = rows.filter(s => s.batch === true);
    // Every branch below keys on the select LIST, not the whole statement: the
    // reconcile query names block_timestamp AND coin_pair AND consensus_proof,
    // so matching anywhere in the text would route it to the wrong shape.
    let selectList = (q.match(/SELECT([\s\S]*?)FROM/i) || [, ''])[1];
    if (/coin_pair/i.test(selectList)) return snapshotPairs(rows);
    if (/consensus_proof/i.test(selectList)) {
        return rows.map(s => ({ round_number: s.round_number,
                                consensus_proof: s.proof !== undefined ? s.proof : null }));
    }
    if (/block_timestamp/i.test(selectList)) {
        return rows.map(s => ({ round_number: s.round_number, block_timestamp: s.block_timestamp }));
    }
    return rows.map(s => ({ round_number: s.round_number }));
}

function snapshotPairs(rows) {
    let out = [];
    // The reconcile reads the window's rows in full, one per pair, exactly as
    // the co-signers' own derivation does. A seed row may carry `pairs`; when it
    // does not, it models a row this stub cannot flesh out, which is what the
    // production guard has to survive without touching the buffer.
    for (let snapshot of rows) {
        for (let pair of (snapshot.pairs || [{ pair: undefined, price: undefined }])) {
            out.push({ round_number: snapshot.round_number, coin_pair: pair.pair, price: pair.price,
                       reference_block: snapshot.reference_block,
                       block_timestamp: snapshot.block_timestamp,
                       proof_head: snapshot.batch === true ? '{"batch"' : '[{"pubk' });
        }
    }
    return out;
}

function deleteMarkers(db, q, args) {
    let deleted = 0;
    if (/round\s+IN\s*\(/i.test(q)) {
        for (let arg of args) {
            if (db.markers[Number(arg)]) { delete db.markers[Number(arg)]; deleted++; }
        }
        return { affectedRows: deleted };
    }
    let cutoff = Number(args[0]);
    let confirmedOnly = /sent_at\s+IS\s+NOT\s+NULL/i.test(q);
    for (let key of Object.keys(db.markers)) {
        let row = db.markers[key];
        if (!(Number(row.round) < cutoff)) continue;
        if (confirmedOnly && row.sent_at == null) continue;
        delete db.markers[key];
        deleted++;
    }
    return { affectedRows: deleted };
}

async function queryDb(db, q, args) {
    db.queries.push({ q, args });
    if (/FROM\s+price_snapshots/i.test(q)) return snapshotQuery(db, q, args);
    if (/^\s*SELECT/i.test(q)) {
        if (/WHERE\s+round\s*=/i.test(q)) {
            let round = Number(args[0]);
            return db.markers[round] ? [db.markers[round]] : [];
        }
        return Object.keys(db.markers).map(key => db.markers[key]);
    }
    if (/^\s*INSERT/i.test(q)) {
        let round = Number(args[0]);
        if (!db.markers[round]) db.markers[round] = { round, txid: null, sent_at: null };
        return { affectedRows: 1 };
    }
    if (/^\s*UPDATE/i.test(q)) {
        let round = Number(args[args.length - 1]);
        if (!db.markers[round]) db.markers[round] = { round, txid: null, sent_at: null };
        db.markers[round].txid = args[0];
        db.markers[round].sent_at = '2026-08-26 12:00:00';
        return { affectedRows: 1 };
    }
    if (/^\s*DELETE/i.test(q)) return deleteMarkers(db, q, args);
    return [];
}

function makeDb(seed) {
    seed = seed || {};
    let db = {
        snapshots: seed.snapshots || [],   // { round_number, block_timestamp, status, batch }
        markers: Object.assign({}, seed.markers || {}),
        queries: []
    };
    // The named query methods sit on the PROTOTYPE, so anything this fake
    // defines itself still wins while the publisher's db.findX() calls resolve
    // and land on the doQuery stub below with the statement they always carried.
    Object.setPrototypeOf(db, DB_METHODS);
    db.doQuery = sinon.stub().callsFake((q, args) => queryDb(db, q, args));
    return db;
}

function makePublisher(opts) {
    opts = opts || {};
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-pub-batch-'));
    tmpDirs.push(dir);

    let signer = opts.signer === null ? null : (opts.signer || makeSigner(opts.signerOpts));
    // The window-mechanics tests below buffer explicit 6-round windows, which the
    // cadence ceiling would clamp at the fleet's 600s round interval (a
    // 6-round window there publishes hourly against a 1800s fee-price staleness
    // bound). Give them the 1s rounds a regtest venue runs, where the ceiling is
    // ~1200 rounds and a 6-round window is honoured verbatim, so those tests keep
    // measuring assembly and splitting rather than the ceiling. `fleetCadence: true`
    // opts back into the real interval for the tests that exercise the ceiling itself.
    let cadenceDefaults = opts.fleetCadence
        ? {}
        : { ORACLE_ROUND_INTERVAL: 1000, ORACLE_BATCH_WINDOW_ROUNDS: 6 };
    let hub = {
        p2pConfig: Object.assign({ PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                                 cadenceDefaults, opts.cfg || {}),
        network:            opts.network === undefined ? 'regtest' : opts.network,
        db:                 opts.db || null,
        getIdentity:        () => makeIdentity(opts.me || ME),
        capabilitySnapshot: opts.capabilitySnapshot !== undefined
            ? opts.capabilitySnapshot
            : makeSnapshot(opts.publishers, opts.priceSet),
        oracleConsensus:    null,
        oracleBatchSigner:  signer
    };
    let broadcasts = [];
    let p = new OraclePublisher(hub);
    p.setBroadcastHook(async (payload) => {
        broadcasts.push(payload);
        if (opts.broadcastFails) throw new Error('broadcast refused');
        return { txid: 'tx-' + broadcasts.length };
    });
    instances.push(p);
    return { p, hub, dir, signer, broadcasts,
             queuePath:  path.join(dir, 'publisher-queue.jsonl'),
             bufferPath: path.join(dir, 'publisher-queue.buffer.jsonl'),
             deadPath:   path.join(dir, 'publisher-queue.deadletter.jsonl') };
}

// The body a READER recovers from a wire, through the real reader path. Returns
// null when the reader refuses it, which is the only honest way to assert that a
// wire this publisher emitted is one the chain will actually accept.
function bodyOf(wire) {
    let f = wire.split('|');
    if (f[2] !== PRICE_BATCH_COMPRESSION_MARKER) return wire.slice('PRICE|0|'.length);
    let r = inflatePriceBatchBody(f[3]);
    return r.ok ? r.body : null;
}

function readJsonl(p) {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// ────────────────────────────────────────────────────────────────────────────

function cleanupPublisherBatch() {
    sinon.restore();
    for (let publisher of instances) {
        try { publisher.stop(); } catch (error) { /* already stopped */ }
    }
    instances.length = 0;
    for (let dir of tmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { /* gone */ }
    }
    tmpDirs.length = 0;
}

module.exports = {
    fs,
    os,
    path,
    crypto,
    sinon,
    expect,
    OraclePublisher,
    waitUntil,
    PRICE_BATCH_COMPRESSION_MARKER,
    inflatePriceBatchBody,
    DB_METHODS,
    PRICE_WIRE_MAX_BYTES,
    ME,
    PEER1,
    PEER2,
    hex,
    makeIdentity,
    sigsOf,
    pairsOf,
    roundFixture,
    bufferedFixture,
    makeSigner,
    makeSnapshot,
    makeDb,
    makePublisher,
    bodyOf,
    readJsonl,
    instances,
    cleanupPublisherBatch
};
