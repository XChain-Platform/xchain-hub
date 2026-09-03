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

const OraclePublisher = require('../../src/OraclePublisher.js');
const { waitUntil }   = require('../helpers/waitUntil');
const { PRICE_BATCH_COMPRESSION_MARKER, inflatePriceBatchBody } = require('../../src/price_batch_compression.js');

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
function makeDb(seed) {
    seed = seed || {};
    let db = {
        snapshots: seed.snapshots || [],   // { round_number, block_timestamp, status, batch }
        markers:   Object.assign({}, seed.markers || {}),
        queries:   []
    };
    db.doQuery = sinon.stub().callsFake(async (q, args) => {
        db.queries.push({ q, args });
        if (/FROM\s+price_snapshots/i.test(q)) {
            // The observation-feed probe asks "has ANY batch ever landed here", with
            // no round range and no args at all.
            if (!args || args.length < 2) {
                return db.snapshots.filter(s => s.batch === true).map(s => ({ seen: 1 }));
            }
            let first = Number(args[0]);
            let last  = Number(args[1]);
            let rows  = db.snapshots.filter(s => Number(s.round_number) >= first &&
                                                 Number(s.round_number) <= last);
            if (/status\s*=\s*\?/i.test(q))                  rows = rows.filter(s => s.status === args[2]);
            if (/consensus_proof\s+LIKE/i.test(q))           rows = rows.filter(s => s.batch === true);
            // Every branch below keys on the select LIST, not the whole statement: the
            // reconcile query names block_timestamp AND coin_pair AND consensus_proof,
            // so matching anywhere in the text would route it to the wrong shape.
            let selectList = (q.match(/SELECT([\s\S]*?)FROM/i) || [, ''])[1];
            // The reconcile reads the window's rows in full, one per pair, exactly as
            // the co-signers' own derivation does. A seed row may carry `pairs`; when it
            // does not, it models a row this stub cannot flesh out, which is what the
            // production guard has to survive without touching the buffer.
            if (/coin_pair/i.test(selectList)) {
                let out = [];
                for (let s of rows) {
                    for (let p of (s.pairs || [{ pair: undefined, price: undefined }])) {
                        out.push({ round_number: s.round_number, coin_pair: p.pair, price: p.price,
                                   reference_block: s.reference_block,
                                   block_timestamp: s.block_timestamp,
                                   proof_head: s.batch === true ? '{"batch"' : '[{"pubk' });
                    }
                }
                return out;
            }
            if (/consensus_proof/i.test(selectList)) {
                return rows.map(s => ({ round_number: s.round_number,
                                        consensus_proof: s.proof !== undefined ? s.proof : null }));
            }
            if (/block_timestamp/i.test(selectList)) {
                return rows.map(s => ({ round_number: s.round_number, block_timestamp: s.block_timestamp }));
            }
            return rows.map(s => ({ round_number: s.round_number }));
        }
        if (/^\s*SELECT/i.test(q)) {
            if (/WHERE\s+round\s*=/i.test(q)) {
                let r = Number(args[0]);
                return db.markers[r] ? [db.markers[r]] : [];
            }
            return Object.keys(db.markers).map(k => db.markers[k]);
        }
        if (/^\s*INSERT/i.test(q)) {
            let r = Number(args[0]);
            if (!db.markers[r]) db.markers[r] = { round: r, txid: null, sent_at: null };
            return { affectedRows: 1 };
        }
        if (/^\s*UPDATE/i.test(q)) {
            let r = Number(args[args.length - 1]);
            if (!db.markers[r]) db.markers[r] = { round: r, txid: null, sent_at: null };
            db.markers[r].txid    = args[0];
            db.markers[r].sent_at = '2026-08-26 12:00:00';
            return { affectedRows: 1 };
        }
        if (/^\s*DELETE/i.test(q)) {
            let deleted = 0;
            if (/round\s+IN\s*\(/i.test(q)) {
                for (let a of args) {
                    if (db.markers[Number(a)]) { delete db.markers[Number(a)]; deleted++; }
                }
                return { affectedRows: deleted };
            }
            let cutoff        = Number(args[0]);
            let confirmedOnly = /sent_at\s+IS\s+NOT\s+NULL/i.test(q);
            for (let k of Object.keys(db.markers)) {
                let row = db.markers[k];
                if (!(Number(row.round) < cutoff)) continue;
                if (confirmedOnly && row.sent_at == null) continue;
                delete db.markers[k];
                deleted++;
            }
            return { affectedRows: deleted };
        }
        return [];
    });
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

describe('OraclePublisher PRICE batch rail', function () {

    let logs;
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...a) => logs.log.push(a.join(' ')));
        sinon.stub(console, 'warn').callsFake((...a) => logs.warn.push(a.join(' ')));
        sinon.stub(console, 'error').callsFake((...a) => logs.error.push(a.join(' ')));
    });

    afterEach(function () {
        sinon.restore();
        for (let p of instances) { try { p.stop(); } catch (e) { /* already stopped */ } }
        instances = [];
        for (let d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* gone */ } }
        tmpDirs = [];
    });

    // ───────────────────────────────────── the durable buffer (D9)

    describe('the separate durable buffer file', function () {

        it('sends a post-stamp finalized round to <queue>.buffer.jsonl and NOT to the publish queue', async function () {
            let h = makePublisher();
            await h.p.start();
            await h.p.onRoundFinalized(roundFixture(0));

            let buffered = readJsonl(h.bufferPath);
            expect(buffered).to.have.length(1);
            expect(buffered[0].round).to.equal(0);
            expect(buffered[0].pairs).to.deep.equal([
                { pair: 'BTC/USD', price: '60000.12' },
                { pair: 'LTC/USD', price: '80.5' }
            ]);
            // The whole point of D9: a buffered round must never be reachable by the
            // publish pass, which broadcasts everything it reads.
            expect(readJsonl(h.queuePath)).to.have.length(0);
            expect(h.broadcasts).to.have.length(0);
        });

        it('buffers on EVERY network, because batching is not gated', async function () {
            // There is no activation stamp: the platform is not live, so there is no
            // replay history for a gate to protect, and a gate nobody remembers to arm
            // is worse than no gate. A round buffers wherever it finalizes.
            for (const network of ['mainnet', 'testnet', 'regtest']) {
                let h = makePublisher({ network });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(readJsonl(h.bufferPath), network).to.have.length(1);
                expect(h.broadcasts, network).to.have.length(0);
            }
        });

        it('buffers even with no network configured, so a hub cannot fall back to the v0 rail', async function () {
            // A standalone hub reads network as '' (it is derived from the p2p config),
            // and while a GATE would have failed closed on that and quietly emitted v0,
            // an ungated rail cannot: one hub emitting a wire its peers no longer expect
            // is the split this removal exists to make unreachable.
            let h = makePublisher({ network: '' });
            await h.p.start();
            await h.p.onRoundFinalized(roundFixture(0));
            expect(readJsonl(h.bufferPath)).to.have.length(1);
            expect(h.broadcasts).to.have.length(0);
        });

        it('buffers on a hub that is NOT the window leader, because leadership is unknown at buffer time', async function () {
            // Three publishers, this hub sorts to a rank that does not lead window 0.
            let h = makePublisher({ publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 3; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(readJsonl(h.bufferPath)).to.have.length(3);
        });

        it('reloads the buffer on restart', async function () {
            let h = makePublisher();
            await h.p.start();
            await h.p.onRoundFinalized(roundFixture(1));
            await h.p.onRoundFinalized(roundFixture(2));

            let second = new OraclePublisher(h.hub);
            instances.push(second);
            await second.start();
            expect(second._buffer.size).to.equal(2);
            expect(second._bufferedRange(0, 5).map(r => r.round)).to.deep.equal([1, 2]);
        });

        it('bounds the buffer at ORACLE_BATCH_BUFFER_MAX_ROUNDS, dropping the oldest', async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_BUFFER_MAX_ROUNDS: 3 } });
            await h.p.start();
            for (let r = 0; r < 5; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(h.p._buffer.size).to.equal(3);
            expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([2, 3, 4]);
            expect(readJsonl(h.bufferPath).map(e => e.round)).to.deep.equal([2, 3, 4]);
        });

        it('prunes a window once an on-chain batch covering it is observed locally (D29)', async function () {
            let db = makeDb({ snapshots: [
                { round_number: 0, block_timestamp: 1800000000, status: 'finalized', batch: true },
                { round_number: 1, block_timestamp: 1800000600, status: 'finalized', batch: true }
            ] });
            let h = makePublisher({ db: db, publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 3; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(h.p._buffer.size).to.equal(3);

            await h.p._pruneObservedWindow(0, 5);
            expect(Array.from(h.p._buffer.keys())).to.deep.equal([2]);
            expect(readJsonl(h.bufferPath).map(e => e.round)).to.deep.equal([2]);
        });

        // Half one. price_snapshots is last-write-wins (ON DUPLICATE KEY
        // UPDATE); this buffer was first-write-wins. One round finalizing twice with
        // different content therefore left the two stores permanently out of step, and
        // since the leader proposes from the buffer while every co-signer re-derives
        // from price_snapshots, the whole window became unsignable forever.
        describe('a round that re-finalizes', function () {

            it('replaces the buffered copy when the content CHANGED, in memory and on disk', async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                // Same round number, the second finalization's timestamp and prices.
                await h.p.onRoundFinalized(roundFixture(7, {
                    time:  1800004800,
                    pairs: [{ coinPair: 'BTC/USD', price: '61111.11' },
                            { coinPair: 'LTC/USD', price: '81.5' }]
                }));

                let buffered = h.p._buffer.get(7);
                expect(buffered.timestamp).to.equal(1800004800);
                expect(buffered.pairs).to.deep.equal([
                    { pair: 'BTC/USD', price: '61111.11' },
                    { pair: 'LTC/USD', price: '81.5' }
                ]);
                // The file is compacted to ONE line for the round, carrying the new copy.
                let onDisk = readJsonl(h.bufferPath);
                expect(onDisk).to.have.length(1);
                expect(onDisk[0].timestamp).to.equal(1800004800);
                expect(logs.warn.join('\n')).to.match(/round 7 re-finalized with different content/);
            });

            it('survives a restart carrying the SECOND copy, not the first', async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                await h.p.onRoundFinalized(roundFixture(7, { time: 1800004800 }));

                let second = new OraclePublisher(h.hub);
                instances.push(second);
                await second.start();
                expect(second._buffer.size).to.equal(1);
                expect(second._buffer.get(7).timestamp).to.equal(1800004800);
            });

            it('is a no-op when the re-finalization is IDENTICAL, so a replay costs no disk', async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                let after = fs.statSync(h.bufferPath).mtimeMs;
                await h.p.onRoundFinalized(roundFixture(7));
                await h.p.onRoundFinalized(roundFixture(7));

                expect(readJsonl(h.bufferPath)).to.have.length(1);
                expect(fs.statSync(h.bufferPath).mtimeMs).to.equal(after);
                expect(logs.warn.join('\n')).to.not.match(/re-finalized with different content/);
            });

            it('treats a re-ordered pair list as identical: the canonical builder sorts pairs anyway', async function () {
                let h = makePublisher();
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(7));
                await h.p.onRoundFinalized(roundFixture(7, {
                    pairs: [{ coinPair: 'LTC/USD', price: '80.5' },
                            { coinPair: 'BTC/USD', price: '60000.12' }]
                }));
                expect(readJsonl(h.bufferPath)).to.have.length(1);
                expect(logs.warn.join('\n')).to.not.match(/re-finalized with different content/);
            });

            // The regression as the federation experienced it: after the second
            // finalization, what the leader PROPOSES has to be what its own
            // price_snapshots holds, or no peer can ever reproduce it.
            it('proposes the re-finalized content to the signing round', async function () {
                let db = makeDb({ snapshots: [] });
                let h = makePublisher({ db: db });
                await h.p.start();
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
                await h.p.onRoundFinalized(roundFixture(5, {
                    time:  1800009999,
                    pairs: [{ coinPair: 'BTC/USD', price: '70000.00' }]
                }));

                await h.p._assembleWindow(0);
                expect(h.signer.calls).to.have.length(1);
                let proposed = h.signer.collectBatchSignatures.firstCall.args[3];
                let last = proposed[proposed.length - 1];
                expect(last.round).to.equal(5);
                expect(last.timestamp).to.equal(1800009999);
                expect(last.pairs).to.deep.equal([{ pair: 'BTC/USD', price: '70000.00' }]);
            });
        });

        // Half two. receiveBatch dedupes per round, so a landed six-round
        // batch typically stamps only the one round this hub was missing; the other
        // five keep their v0 proof. Pruning only the stamped rows left a published
        // window buffered forever, and every later leader re-proposed it.
        it('prunes the WHOLE range a landed batch claims, not just the rows carrying its proof', async function () {
            let proof = JSON.stringify({
                batch: { first_round: 0, last_round: 5, btc_block_height: 800005 },
                sigs: []
            });
            let db = makeDb({ snapshots: [
                // Only round 3 was missing locally, so only round 3 carries the stamp.
                { round_number: 3, block_timestamp: 1800001800, status: 'finalized',
                  batch: true, proof: proof }
            ] });
            let h = makePublisher({ db: db, publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 8; r++) await h.p.onRoundFinalized(roundFixture(r));

            let pruned = await h.p._pruneObservedWindow(0, 5);
            expect(pruned).to.equal(6);
            // Rounds 6 and 7 are outside the batch's claimed range and stay buffered.
            expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([6, 7]);
        });

        // The healing half of this fix. The buffer fix above stops a NEW drift; a hub
        // that already drifted (its buffered round 107 predates the fix) still holds a
        // window no peer can co-sign until assembly reconciles it.
        describe('reconciling the buffered window against price_snapshots', function () {

            // A DB seed row shaped the way makeDb's reconcile branch expands it.
            function snapRow(round, opts) {
                opts = opts || {};
                return {
                    round_number:    round,
                    status:          'finalized',
                    reference_block: opts.anchor !== undefined ? opts.anchor : 800000 + round,
                    block_timestamp: opts.time   !== undefined ? opts.time   : 1800000000 + round * 600,
                    batch:           opts.batch === true,
                    pairs:           opts.pairs || [{ pair: 'BTC/USD', price: '60000.12' },
                                                    { pair: 'LTC/USD', price: '80.5' }]
                };
            }

            it('refreshes a drifted round so the leader proposes what its own DB holds', async function () {
                // The testnet shape: the DB moved round 5 on to a later timestamp and a
                // new price set, and the buffer was left holding the superseded copy.
                let snapshots = [];
                for (let r = 0; r < 6; r++) snapshots.push(snapRow(r));
                snapshots[5] = snapRow(5, { time: 1800009999,
                                            pairs: [{ pair: 'BTC/USD', price: '70000.00' }] });
                let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
                await h.p.start();
                // Buffer the pre-drift content, as the hub did before the DB moved.
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

                await h.p._assembleWindow(0);

                let proposed = h.signer.collectBatchSignatures.firstCall.args[3];
                let last = proposed[proposed.length - 1];
                expect(last.round).to.equal(5);
                expect(last.timestamp).to.equal(1800009999);
                expect(last.pairs).to.deep.equal([{ pair: 'BTC/USD', price: '70000.00' }]);
                expect(logs.warn.join('\n')).to.match(/buffered round 5 disagreed with this hub's own price_snapshots/);
                // The refreshed copy is durable, so the next restart proposes it too.
                expect(readJsonl(h.bufferPath).find(e => e.round === 5).timestamp).to.equal(1800009999);
            });

            it('sheds a round that arrived from a batch already on chain', async function () {
                let snapshots = [];
                for (let r = 0; r < 6; r++) snapshots.push(snapRow(r));
                // Round 2 came back from a landed batch, so its reference_block is the
                // LANDING chain's height, not a BTC anchor.
                snapshots[2] = snapRow(2, { batch: true, anchor: 67856096 });
                let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
                await h.p.start();
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

                expect(await h.p._reconcileBufferedWindow(0, 5)).to.equal(1);
                expect(h.p._buffer.has(2)).to.equal(false);
                // The landing height never reaches the buffer, let alone a proposal.
                for (let e of h.p._buffer.values()) expect(e.btcBlockHeight).to.not.equal(67856096);
                expect(logs.warn.join('\n')).to.match(/dropping buffered round 2 .* already landed on chain/);
            });

            it('leaves an agreeing window completely alone', async function () {
                let snapshots = [];
                for (let r = 0; r < 6; r++) snapshots.push(snapRow(r));
                let h = makePublisher({ db: makeDb({ snapshots: snapshots }) });
                await h.p.start();
                for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
                let before = readJsonl(h.bufferPath);

                expect(await h.p._reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(readJsonl(h.bufferPath)).to.deep.equal(before);
                expect(logs.warn.join('\n')).to.not.match(/disagreed with this hub's own/);
            });

            it('never INVENTS a round: a finalized round with no buffered copy stays the self-check\'s case', async function () {
                let h = makePublisher({ db: makeDb({ snapshots: [snapRow(0), snapRow(3)] }) });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(await h.p._reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(Array.from(h.p._buffer.keys())).to.deep.equal([0]);
            });

            it('fails closed on a half-read round rather than overwriting good content', async function () {
                // No `pairs` on the seed: the row reads back with no pair and no price,
                // which the canonical builder would turn into NaN.
                let h = makePublisher({ db: makeDb({ snapshots: [
                    { round_number: 0, status: 'finalized', block_timestamp: 1800009999 }
                ] }) });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(await h.p._reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(h.p._buffer.get(0).timestamp).to.equal(1800000000);
                expect(h.p._buffer.get(0).pairs).to.have.length(2);
                expect(logs.warn.join('\n')).to.match(/skipping reconcile of buffered round 0/);
            });

            it('proposes the buffer as-is when the DB read throws', async function () {
                let db = makeDb({ snapshots: [] });
                db.doQuery = async (q) => {
                    if (/coin_pair/i.test(q)) throw new Error('connection lost');
                    return [];
                };
                let h = makePublisher({ db: db });
                await h.p.start();
                await h.p.onRoundFinalized(roundFixture(0));

                expect(await h.p._reconcileBufferedWindow(0, 5)).to.equal(0);
                expect(h.p._buffer.get(0).timestamp).to.equal(1800000000);
                expect(logs.warn.join('\n')).to.match(/cannot reconcile the buffered copy of window \[0,5\]/);
            });
        });

        it('falls back to the stamped round alone when the proof is unreadable', async function () {
            let db = makeDb({ snapshots: [
                { round_number: 3, block_timestamp: 1800001800, status: 'finalized',
                  batch: true, proof: '{"batch": truncated' }
            ] });
            let h = makePublisher({ db: db, publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

            expect(await h.p._pruneObservedWindow(0, 5)).to.equal(1);
            expect(Array.from(h.p._buffer.keys()).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 4, 5]);
        });
    });

    // ───────────────────────────────────── the window scheduler

    describe('the window scheduler', function () {

        it('assembles and publishes ONE wire a grace after the window\'s last round closes it', async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
            await waitUntil(() => h.broadcasts.length > 0,
                { label: 'the grace timer to close window 0 and its wire to broadcast' });
            await h.p._windowChain;

            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 5, count: 6 });
            expect(h.broadcasts).to.have.length(1);
            expect(h.broadcasts[0].split('|').slice(0, 2)).to.deep.equal(['PRICE', '0']);
        });

        it('closes a window whose LAST slot was skipped, when a higher window\'s round arrives', async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r of [0, 1, 2, 3, 4]) await h.p.onRoundFinalized(roundFixture(r));  // 5 skipped
            expect(h.signer.calls).to.have.length(0);

            await h.p.onRoundFinalized(roundFixture(6));   // window 1 opens, window 0 is closed
            await waitUntil(() => h.signer.calls.length > 0,
                { label: 'window 0 to close on the higher window\'s arrival and be proposed' });
            await h.p._windowChain;

            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 4, count: 5 });
        });

        it('elects the window leader as windowIndex % publisherCount and defers otherwise', async function () {
            // ME sorts first of the three ('aa..' < 'bb..' < 'cc..'), so rank 0 leads
            // windows 0, 3, 6... and defers 1 and 2.
            let h = makePublisher({ publishers: [ME, PEER1, PEER2] });
            await h.p.start();
            for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p._assembleWindow(1);
            expect(h.signer.calls).to.have.length(0);
            expect(h.p.getStats().isLeader).to.equal(false);

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(1);
            expect(h.p.getStats().isLeader).to.equal(true);
        });

        // Rank-staggered takeover. Before this existed, a window whose leader never
        // broadcast stayed unpublished forever, however healthy the other hubs were.
        describe('takeover of a silent leader', function () {

            // ME is rank 0 of three, so window 1 belongs to PEER1 and ME is one step
            // behind it. `landed` seeds the proof that this hub sees batches land.
            // start() hydrates the buffer from disk, so the rounds are seeded AFTER it.
            async function followerOf(opts) {
                opts = opts || {};
                let snapshots = [];
                if (opts.landed) snapshots.push({ round_number: opts.landed, batch: true, status: 'finalized' });
                for (let r = 0; r < 12; r++) snapshots.push({ round_number: r, status: 'finalized' });
                let h = makePublisher({
                    publishers: [ME, PEER1, PEER2],
                    db:  makeDb({ snapshots: snapshots }),
                    cfg: Object.assign({ ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '2' }, opts.cfg || {})
                });
                await h.p.start();
                for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
                return h;
            }

            it('arms a timer for a window this hub does not lead, staggered by distance from the leader', async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(1);
                expect(h.broadcasts).to.have.length(0);
                expect(h.p._takeoverTimers.has(1)).to.equal(true);
                expect(h.p.getStats().takeoverPending).to.equal(1);
            });

            it('arms NOTHING when no failover window is configured (the default)', async function () {
                let h = await followerOf({ landed: 99, cfg: { ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '0' } });
                await h.p._assembleWindow(1);
                expect(h.p._takeoverTimers.size).to.equal(0);
                expect(h.p.getStats().takeoverArmed).to.equal(false);
            });

            it('publishes the identical window when the leader stayed silent', async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(1);

                let took = await h.p._attemptTakeover(1);
                expect(took).to.equal(true);
                expect(h.broadcasts).to.have.length(1);
                expect(h.p.getStats().takeoverPublished).to.equal(1);
                // The wire is a batch over window 1's rounds, exactly what the leader
                // would have sent: same rounds, same canonical shape.
                let entry = readJsonl(h.queuePath).concat(h.broadcasts);
                expect(String(h.broadcasts[0].wire || h.broadcasts[0])).to.match(/^PRICE\|0\|/);
                expect(entry.length).to.be.greaterThan(0);
            });

            it('declines when the leader already published, and prunes instead', async function () {
                // Window 1 covers rounds 6..11; seeing one of them land is proof.
                let h = await followerOf({ landed: 7 });
                let took = await h.p._attemptTakeover(1);
                expect(took).to.equal(false);
                expect(h.broadcasts).to.have.length(0);
            });

            // The safety property: a hub that has never seen a batch land cannot tell
            // a dark leader from its own deaf feed, and must never pay DOGE on that
            // ambiguity.
            it('declines every takeover when no batch has EVER been observed on this hub', async function () {
                let h = await followerOf();   // no landed row at all
                await h.p.start();
                await h.p._assembleWindow(1);
                let took = await h.p._attemptTakeover(1);
                expect(took).to.equal(false);
                expect(h.broadcasts).to.have.length(0);
                expect(h.p.getStats().takeoverArmed).to.equal(false);
            });

            it('declines when the hub DB cannot answer whether the window is on chain', async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._observationFeedProven();          // prove the feed first
                h.hub.db.doQuery = sinon.stub().rejects(new Error('hub db down'));
                let took = await h.p._attemptTakeover(1);
                expect(took).to.equal(false);
                expect(h.broadcasts).to.have.length(0);
            });

            it('never schedules a takeover of its OWN window', async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(0);                // ME leads window 0
                expect(h.p._takeoverTimers.has(0)).to.equal(false);
            });

            // price_snapshots is a MINED view, so "not on chain" cannot
            // separate a leader that never broadcast from one whose tx is sitting
            // unmined in the DOGE mempool. Stepping in over the second pays the fee
            // twice for a window already in flight, so the follower holds off until the
            // ambiguity cooldown proves that tx never landed.
            describe('the ambiguous-send cooldown', function () {

                // ORACLE_PUBLISH_BLOCK_MS is unset in these fixtures, so the default
                // cooldown is failoverWindowBlocks (2) x APPROX_BTC_BLOCK_MS.
                const COOLDOWN_MS = 2 * 600000;

                it('defers takeover while a batch this hub co-signed may still be in flight', async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    h.p._takeoverTimers.forEach(t => clearTimeout(t));
                    h.p._takeoverTimers.clear();
                    // The leader asked us to co-sign window 1 moments ago, which is the
                    // last thing it needed before broadcasting.
                    h.signer.coSignedAt = sinon.stub().returns(Date.now() - 1000);

                    let took = await h.p._attemptTakeover(1);

                    expect(took).to.equal(false);
                    expect(h.broadcasts).to.have.length(0);
                    expect(h.p.getStats().takeoverDeferred).to.equal(1);
                    expect(h.p.getStats().takeoverAmbiguousCooldownMs).to.equal(COOLDOWN_MS);
                    expect(logs.warn.join('\n')).to.match(/deferring takeover of window 1/);
                    // The signer is asked about the window's ROUND RANGE, not its index.
                    expect(h.signer.coSignedAt.firstCall.args).to.deep.equal([6, 11]);
                });

                it('re-arms the deferred takeover rather than cancelling it', async function () {
                    let h = await followerOf({ landed: 99 });
                    h.signer.coSignedAt = () => Date.now() - 1000;

                    expect(await h.p._attemptTakeover(1)).to.equal(false);
                    // Without the re-arm this window would be dropped by this hub
                    // forever: the timer that fired is already gone.
                    expect(h.p._takeoverTimers.has(1)).to.equal(true);
                    expect(h.p.getStats().takeoverPending).to.equal(1);
                });

                it('takes over once the cooldown has elapsed with the window STILL off chain', async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    // Co-signed a full cooldown ago and still nothing mined: whatever
                    // the leader sent is provably gone.
                    h.signer.coSignedAt = () => Date.now() - COOLDOWN_MS - 1;

                    let took = await h.p._attemptTakeover(1);

                    expect(took).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                    expect(h.p.getStats().takeoverDeferred).to.equal(0);
                });

                it('steps in at once when this hub never co-signed the window', async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    // A leader that never asked for a signature never assembled a batch,
                    // so it cannot have one in flight: that is genuine silence.
                    h.signer.coSignedAt = () => null;

                    expect(await h.p._attemptTakeover(1)).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                });

                it('defers on an ambiguous send of this hub\'s OWN for the same window', async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    h.p._noteAmbiguousWindow(1);

                    expect(await h.p._attemptTakeover(1)).to.equal(false);
                    expect(h.broadcasts).to.have.length(0);
                    expect(h.p.getStats().takeoverDeferred).to.equal(1);
                });

                it('records the window when a batch wire dead-letters on an ambiguous send', async function () {
                    let h = await followerOf({ landed: 99, cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
                    h.p.setBroadcastHook(async () => {
                        let e = new Error('socket hang up');
                        e.code = 'ECONNRESET';
                        throw e;
                    });
                    h.signer.coSignedAt = () => null;

                    // ME leads window 0, so this is a plain leader publish that fails
                    // ambiguously; the takeover armed against the SAME window must then
                    // not re-broadcast over it.
                    await h.p._assembleWindow(0);
                    expect(readJsonl(h.deadPath)).to.have.length(1);
                    expect(h.p._ambiguousWindows.has(0)).to.equal(true);

                    expect(await h.p._attemptTakeover(0)).to.equal(false);
                    expect(h.p.getStats().takeoverDeferred).to.equal(1);
                });

                it('is switched off by a zero cooldown, restoring the prior behaviour', async function () {
                    let h = await followerOf({ landed: 99,
                        cfg: { ORACLE_TAKEOVER_AMBIGUOUS_COOLDOWN_MS: '0' } });
                    await h.p._assembleWindow(1);
                    h.signer.coSignedAt = () => Date.now();

                    expect(h.p.getStats().takeoverAmbiguousCooldownMs).to.equal(0);
                    expect(await h.p._attemptTakeover(1)).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                });

                it('survives a signer with no co-signature memo at all', async function () {
                    let h = await followerOf({ landed: 99 });
                    await h.p._assembleWindow(1);
                    delete h.signer.coSignedAt;

                    expect(await h.p._attemptTakeover(1)).to.equal(true);
                    expect(h.broadcasts).to.have.length(1);
                });

                it('never CONSTRUCTS a signer just to answer the ambiguity question', async function () {
                    let h = await followerOf({ landed: 99 });
                    h.hub.oracleBatchSigner = null;
                    expect(h.p._takeoverAmbiguityAt(1, 6, 11)).to.equal(null);
                    expect(h.p._ownedBatchSigner).to.equal(null);
                });
            });

            it('stop() clears pending takeover timers', async function () {
                let h = await followerOf({ landed: 99 });
                await h.p._assembleWindow(1);
                expect(h.p._takeoverTimers.size).to.equal(1);
                h.p.stop();
                expect(h.p._takeoverTimers.size).to.equal(0);
            });
        });

        it('publishes NOTHING when the signing round misses quorum, and leaves the window re-proposable', async function () {
            let h = makePublisher({ signerOpts: { met: false, timeouts: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(0);
            expect(readJsonl(h.queuePath)).to.have.length(0);
            // Not memoized, so a later attempt on this hub can re-run the round.
            expect(h.p._assembledWindows.has(0)).to.equal(false);
            expect(h.p.getStats().batchSignTimeouts).to.equal(1);
        });
    });

    // ───────────────────────────────────── re-proposing a timed-out window

    // "Re-proposable" was only ever a property of the memo, never a thing that
    // happened: the catch-up sweep ran exactly ONCE per process, a grace after
    // start(), so a window that missed quorum stayed unpublished until an operator
    // restarted the hub. Measured on public testnet 2026-09-02, where window
    // [102,107] was refused by three peers at the 2026-09-01 boot, was never
    // attempted again, and left 744 rounds back to round 21 in the leader's buffer.
    describe('the recurring catch-up sweep', function () {

        // A signer that misses quorum for its first N attempts and then succeeds,
        // which is what a peer coming back up (or a reconciled buffer) looks like.
        function flakySigner(failFirst) {
            let signer = { calls: [], getStats: () => ({ batchSignTimeouts: 0 }), start() {}, stop() {} };
            signer.collectBatchSignatures = sinon.stub().callsFake(async (f, l, a, rounds) => {
                signer.calls.push({ first: f, last: l, anchor: a, rounds: rounds.map(r => r.round) });
                if (signer.calls.length <= failFirst)
                    return { met: false, sigs: sigsOf(1), firstRound: f, lastRound: l };
                return { met: true, sigs: sigsOf(3), firstRound: f, lastRound: l,
                         btcBlockHeight: a, canonical: 'canonical-' + f + '-' + l };
            });
            return signer;
        }

        it('re-proposes a window that missed quorum, with byte-identical content, until it lands', async function () {
            let signer = flakySigner(1);
            let h = makePublisher({ signer: signer, cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 25 } });
            await h.p.start();
            // Window 0 is closed by construction: window 1 holds a higher round.
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            await h.p._assembleWindow(0);
            expect(h.broadcasts, 'the first attempt misses quorum').to.have.length(0);

            await waitUntil(() => h.broadcasts.length === 1, 3000);
            expect(signer.calls).to.have.length(2);
            // The re-proposal is the SAME window over the SAME rounds: a retry that
            // proposed different content would be a second honest batch, not a retry.
            expect(signer.calls[1].first).to.equal(signer.calls[0].first);
            expect(signer.calls[1].last).to.equal(signer.calls[0].last);
            expect(signer.calls[1].rounds).to.deep.equal(signer.calls[0].rounds);
            expect(h.p._assembledWindows.has(0), 'memoized once it publishes').to.equal(true);
        });

        it('stops asking once the window is assembled, so a healthy rail never re-signs', async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 25 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);
            let after = h.signer.calls.length;

            for (let i = 0; i < 6; i++) h.p._sweepBufferCatchup();
            await h.p._windowChain;
            expect(h.signer.calls).to.have.length(after);
            expect(h.broadcasts).to.have.length(1);
        });

        it('leaves the newest window alone: it may still be open', async function () {
            let h = makePublisher();
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            expect(h.p._pendingCatchupWindows()).to.deep.equal([0]);
        });

        it('re-proposes at most four windows per sweep, oldest first, and says how many are waiting', async function () {
            let h = makePublisher({ signerOpts: { met: false } });
            await h.p.start();
            // Ten closed windows plus one still open (window 10 is missing round 65).
            for (let r = 0; r < 65; r++) h.p._buffer.set(r, bufferedFixture(r));

            expect(h.p._pendingCatchupWindows()).to.have.length(10);
            expect(h.p._sweepBufferCatchup()).to.equal(4);
            await h.p._windowChain;

            let asked = h.signer.calls.map(c => c.first);
            expect(asked, 'oldest four windows, in order').to.deep.equal([0, 6, 12, 18]);
            expect(logs.warn.join('\n')).to.match(
                /10 closed window\(s\) are still buffered and unpublished; re-proposing 4 of them this sweep \(oldest first, from window 0\)/);
        });

        it('spends its four slots on windows that still need one, not on windows already assembled', async function () {
            let h = makePublisher({ signerOpts: { met: false } });
            await h.p.start();
            for (let r = 0; r < 65; r++) h.p._buffer.set(r, bufferedFixture(r));
            // Windows 0..5 were followed or published earlier in this process. Counting
            // them against the per-sweep cap would spend every slot on windows that need
            // nothing and never reach the one that timed out.
            for (let w = 0; w <= 5; w++) h.p._noteAssembled(w);

            expect(h.p._pendingCatchupWindows()).to.deep.equal([6, 7, 8, 9]);
            h.p._sweepBufferCatchup();
            await h.p._windowChain;
            expect(h.signer.calls.map(c => c.first)).to.deep.equal([36, 42, 48, 54]);
        });

        it('reports the stuck backlog through getStats, and it falls as windows land', async function () {
            let signer = flakySigner(1);
            let h = makePublisher({ signer: signer });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            h.p._buffer.set(6, bufferedFixture(6));

            await h.p._assembleWindow(0);
            expect(h.p.getStats().batchWindowsAwaitingRetry).to.equal(1);
            expect(h.p.getStats().batchCatchupSweeps).to.equal(0);

            h.p._sweepBufferCatchup();
            await h.p._windowChain;
            expect(h.p.getStats().batchWindowsAwaitingRetry).to.equal(0);
            expect(h.p.getStats().batchCatchupSweeps).to.equal(1);
        });

        it('stop() releases the sweep timer', async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 25 } });
            await h.p.start();
            expect(h.p._catchupSweepTimer).to.not.equal(null);
            h.p.stop();
            expect(h.p._catchupSweepTimer).to.equal(null);
        });
    });

    // ───────────────────────────────────── a window closed while the hub was down

    // The grace timer lives only in memory, so a restart inside the grace dropped it,
    // and the boot catch-up skipped the HIGHEST buffered window on the theory that it
    // might still be open. A window that closed and then lost its timer to a restart
    // was therefore reachable by neither half: observed 2026-08-28, window 4 left
    // unassembled on all five testnet validators after their hubs were recreated.
    describe('a window closed while the hub was down', function () {

        // A second publisher over the SAME hub config, and therefore the same queue and
        // buffer files: what a process restart looks like to this class. The first is
        // stopped so its timers cannot fire into the second one's assertions.
        function restart(h, cfg) {
            h.p.stop();
            Object.assign(h.hub.p2pConfig, cfg || {});
            let second = new OraclePublisher(h.hub);
            second.setBroadcastHook(async (payload) => {
                h.broadcasts.push(payload);
                return { txid: 'tx-' + h.broadcasts.length };
            });
            instances.push(second);
            h.p = second;
            return second;
        }

        it('publishes the highest buffered window when its own last round already closed it', async function () {
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));
            expect(h.broadcasts, 'nothing publishes inside the grace').to.have.length(0);

            let second = restart(h, { ORACLE_BATCH_GRACE_MS: 1 });
            await second.start();
            await waitUntil(() => h.broadcasts.length > 0,
                { label: 'the restarted hub to catch up window 0 and broadcast it' });
            await second._windowChain;

            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 5, count: 6 });
        });

        it('counts the highest buffered window as closed only once its last slot is buffered', async function () {
            let h = makePublisher();
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            expect(h.p._pendingCatchupWindows(), 'window 0 is complete').to.deep.equal([0]);

            h.p._buffer.set(6, bufferedFixture(6));
            expect(h.p._pendingCatchupWindows(), 'window 1 holds one round and may still fill')
                .to.deep.equal([0]);
        });

        it('never pre-empts a grace timer that is still pending', async function () {
            // The grace is what lets a straggler round land in the wire; a sweep that
            // assembled the window early would publish without it.
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) await h.p.onRoundFinalized(roundFixture(r));

            expect(h.p._windows.get(0).timer, 'the live timer owns window 0').to.not.equal(null);
            expect(h.p._pendingCatchupWindows()).to.deep.equal([]);
            expect(h.p._sweepBufferCatchup()).to.equal(0);
            expect(h.signer.calls).to.have.length(0);
        });

        it('re-registers the buffered window a restart dropped, so a higher round still closes it', async function () {
            // Window 0's last slot was skipped, so only a higher round can close it, and
            // that path walks the in-memory window map a restart had emptied.
            let h = makePublisher({ cfg: { ORACLE_BATCH_GRACE_MS: 60000 } });
            await h.p.start();
            for (let r of [0, 1, 2, 3, 4]) await h.p.onRoundFinalized(roundFixture(r));

            let second = restart(h, { ORACLE_BATCH_GRACE_MS: 1 });
            await second.start();
            expect(second._windows.has(0), 'the buffered window is tracked again').to.equal(true);
            expect(second._windows.get(0).timer, 'but not armed: it may still fill').to.equal(null);

            await second.onRoundFinalized(roundFixture(6));
            await waitUntil(() => h.signer.calls.length > 0,
                { label: 'window 1 arriving to close window 0 on the restarted hub' });
            await second._windowChain;

            expect(h.signer.calls[0]).to.include({ first: 0, last: 4, count: 5 });
        });
    });

    // ───────────────────────────────────── the self-check (D27, and the pinned status ambiguity)

    describe('the pre-publish self-check', function () {

        it('refuses a window whose post-stamp finalized round has no buffered copy', async function () {
            let db = makeDb({ snapshots: [
                { round_number: 0, block_timestamp: 1800000000, status: 'finalized' },
                { round_number: 3, block_timestamp: 1800001800, status: 'finalized' }   // never buffered
            ] });
            let h = makePublisher({ db: db });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(0);
            expect(logs.warn.join('\n')).to.match(/finalized round\(s\) 3 with no buffered copy/);
        });

        it('has NO stamp exemption: a finalized round with no buffered copy withholds the batch', async function () {
            // The old rail exempted rounds below the activation stamp, because those went
            // out as v0 and were never buffered, so without the exemption the first
            // straddling window would have seen permanent gaps. No stamp, no straddle, no
            // exemption: every finalized round must be accounted for, whatever its time.
            let h = makePublisher({
                network: 'testnet',
                db: makeDb({ snapshots: [
                    { round_number: 0, block_timestamp: -1,         status: 'finalized' },
                    { round_number: 1, block_timestamp: 1800000600, status: 'finalized' }
                ] })
            });
            await h.p.start();
            h.p._buffer.set(1, bufferedFixture(1));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(0);
            expect(logs.warn.join('\n')).to.match(/finalized round\(s\) 0 with no buffered copy/);
        });

        it('keys on status = finalized ONLY, so a reorg-disputed round cannot stall the window forever', async function () {
            // The signer refuses to sign disputed content, so treating a disputed round
            // as present-but-unbuffered would make the window unpublishable for good.
            let db = makeDb({ snapshots: [
                { round_number: 0, block_timestamp: 1800000000, status: 'finalized' },
                { round_number: 4, block_timestamp: 1800002400, status: 'disputed' },
                { round_number: 5, block_timestamp: 1800003000, status: 'skipped' }
            ] });
            let h = makePublisher({ db: db });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(1);
            expect(h.signer.calls[0]).to.include({ first: 0, last: 0 });
        });

        it('fails closed when price_snapshots cannot be read', async function () {
            let db = makeDb();
            db.doQuery = sinon.stub().callsFake(async (q) => {
                if (/price_snapshots/i.test(q)) throw new Error('table gone');
                return [];
            });
            let h = makePublisher({ db: db });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0));

            await h.p._assembleWindow(0);
            expect(h.signer.calls).to.have.length(0);
            expect(logs.warn.join('\n')).to.match(/withholding the batch \(fail closed\)/);
        });
    });

    // ───────────────────────────────────── splitting (D17) and the flag-day rule (D7)

    describe('splitting', function () {

        it('packs the largest range that fits and splits an overflowing window into several wires', async function () {
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'split' + r) }));
            }
            // The premise: a six-round wire really does overflow at this size.
            let whole = h.p._emitWire(0, 5, 800005, h.p._bufferedRange(0, 5), sigsOf(3));
            expect(whole.bytes).to.be.greaterThan(PRICE_WIRE_MAX_BYTES);

            // Hold the publish pass so the enqueued wires stay readable on disk; a
            // successful pass dequeues them and the split would be invisible here.
            sinon.stub(h.p, '_processQueue').resolves();
            await h.p._assembleWindow(0);

            let entries = readJsonl(h.queuePath);
            expect(entries.length).to.be.greaterThan(1);
            expect(h.p.getStats().batchSplitCount).to.equal(entries.length - 1);
            // Every wire fits, every wire is a contiguous sub-range, and together they
            // cover the window exactly once.
            let covered = [];
            for (let e of entries) {
                expect(Buffer.byteLength(e.wire, 'utf8')).to.be.at.most(PRICE_WIRE_MAX_BYTES);
                covered = covered.concat(e.batch.rounds);
            }
            expect(covered).to.deep.equal([0, 1, 2, 3, 4, 5]);
        });

        it('splits at an armed oracle flag-day boundary inside the window (D7)', async function () {
            // mainnet arms STAKE_WEIGHTED_QUORUM at 961000 and the sig tally at 963000.
            let h = makePublisher({ network: 'mainnet' });
            await h.p.start();
            for (let r = 0; r < 4; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { anchor: 960998 + r }));  // 960998..961001
            }

            await h.p._assembleWindow(0);

            expect(h.signer.calls.map(c => [c.first, c.last])).to.deep.equal([[0, 1], [2, 3]]);
            // Neither proposed range straddles: the signer's receiving-side twin would
            // silently refuse one that did, and nothing would ever publish.
            for (let c of h.signer.calls) {
                let range = h.p._bufferedRange(c.first, c.last);
                expect(h.p._flagDayKey(range[0].btcBlockHeight))
                    .to.equal(h.p._flagDayKey(range[range.length - 1].btcBlockHeight));
            }
        });

        it('re-derives the header anchor for EVERY split, never the whole window\'s', async function () {
            // Both verifiers now reject a batch whose header BTC_BLOCK_HEIGHT is not the
            // last included round's own anchor. A split that kept the window's anchor
            // would put every wire but the last one on chain as invalid, fee and all.
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'anchor' + r) }));
            }
            sinon.stub(h.p, '_processQueue').resolves();
            await h.p._assembleWindow(0);

            let entries = readJsonl(h.queuePath);
            expect(entries.length).to.be.greaterThan(1);
            for (let e of entries) {
                let lastRoundAnchor = 800000 + e.batch.lastRound;
                expect(e.batch.anchor, 'wire [' + e.batch.firstRound + ',' + e.batch.lastRound + ']')
                    .to.equal(lastRoundAnchor);
                // And it is the value actually on the wire, whichever form it rode in.
                expect(bodyOf(e.wire).split('|')[2]).to.equal(String(lastRoundAnchor));
            }
            // The signing round was asked for the same anchor it will be verified under.
            for (let c of h.signer.calls) expect(c.anchor).to.equal(800000 + c.last);
        });

        it('emits only wires the READER accepts: the inflated body is capped at the same 8189', async function () {
            // price_batch_compression.js caps the INFLATED body at PRICE_WIRE_MAX_BYTES
            // (outputCap = min(PRICE_WIRE_MAX_BYTES, ratioCap)), so a compressed wire can
            // sail under the encoder limit and still carry a body every indexer refuses
            // to finish inflating. Sizing on the emitted bytes alone spends a DOGE fee on
            // an action nobody accepts, so every wire is round-tripped through the real
            // reader here rather than merely measured.
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'reader' + r) }));
            }
            sinon.stub(h.p, '_processQueue').resolves();
            await h.p._assembleWindow(0);

            let entries = readJsonl(h.queuePath);
            expect(entries.length).to.be.greaterThan(1);
            for (let e of entries) {
                let body = bodyOf(e.wire);
                expect(body, 'the reader must accept wire [' + e.batch.firstRound + ',' +
                    e.batch.lastRound + ']').to.not.equal(null);
                expect(Buffer.byteLength(body, 'utf8')).to.be.at.most(PRICE_WIRE_MAX_BYTES);
                expect(body.split('|').slice(0, 2))
                    .to.deep.equal([String(e.batch.firstRound), String(e.batch.lastRound)]);
            }
        });

        it('refuses to build a body whose header anchor is not the last round\'s anchor', function () {
            let h = makePublisher();
            let rounds = [bufferedFixture(0), bufferedFixture(1)];   // anchors 800000, 800001
            expect(() => h.p.buildPriceBatchBody(0, 1, 800001, rounds, sigsOf(1))).to.not.throw();
            expect(() => h.p.buildPriceBatchBody(0, 1, 800000, rounds, sigsOf(1)))
                .to.throw(/does not equal the last included round's anchor 800001/);
        });

        it('does not split a window that sits entirely on one side of every flag day', async function () {
            let h = makePublisher({ network: 'mainnet' });
            await h.p.start();
            for (let r = 0; r < 4; r++) h.p._buffer.set(r, bufferedFixture(r, { anchor: 970000 + r }));
            await h.p._assembleWindow(0);
            expect(h.signer.calls.map(c => [c.first, c.last])).to.deep.equal([[0, 3]]);
            expect(h.p.getStats().batchSplitCount).to.equal(0);
        });
    });

    // ───────────────────────────────────── emit-smaller (section 4a)

    describe('emit-smaller', function () {

        it('rides compressed when deflate wins, and the wire inflates back to the same body', function () {
            let h = makePublisher();
            let rounds = [];
            for (let r = 0; r < 6; r++) {
                rounds.push(bufferedFixture(r, { pairs: pairsOf(37, 'real') }));   // 37 real pairs
            }
            let emitted = h.p._emitWire(0, 5, 800005, rounds, sigsOf(3));
            expect(emitted.compressed).to.equal(true);
            let fields = emitted.wire.split('|');
            expect(fields.slice(0, 3)).to.deep.equal(['PRICE', '0', PRICE_BATCH_COMPRESSION_MARKER]);

            let inflated = inflatePriceBatchBody(fields[3]);
            expect(inflated.ok).to.equal(true);
            expect(inflated.body).to.equal(h.p.buildPriceBatchBody(0, 5, 800005, rounds, sigsOf(3)));
        });

        it('rides UNCOMPRESSED when deflate makes the body larger', function () {
            let h = makePublisher();
            // Measured while writing this: any signature-bearing body deflates smaller,
            // because ed25519 hex halves under deflate. The uncompressed branch is for
            // the pathological short, high-entropy body the spec names, so that is what
            // is driven here: one round, one incompressible pair name, no signature set.
            let rounds = [bufferedFixture(0, { pairs: [{ coinPair: 'Q7fKp2ZmXn4Vb8Rt/Ld3Ws9Yj', price: '1' }] })];
            let emitted = h.p._emitWire(0, 0, 800000, rounds, []);
            expect(emitted.compressed).to.equal(false);
            expect(emitted.wire.split('|')[2]).to.not.equal(PRICE_BATCH_COMPRESSION_MARKER);
            expect(emitted.wire).to.equal('PRICE|0|' + h.p.buildPriceBatchBody(0, 0, 800000, rounds, []));
        });

        it('never emits a wire larger than the uncompressed form, whatever the content', function () {
            let h = makePublisher();
            for (let pairCount of [1, 2, 5, 37, 200]) {
                for (let sigCount of [0, 1, 3, 9]) {
                    let rounds = [bufferedFixture(0, { pairs: pairsOf(pairCount, 'inv' + pairCount) })];
                    let plain  = 'PRICE|0|' + h.p.buildPriceBatchBody(0, 0, 800000, rounds, sigsOf(sigCount));
                    let out    = h.p._emitWire(0, 0, 800000, rounds, sigsOf(sigCount));
                    expect(out.bytes, pairCount + ' pairs / ' + sigCount + ' sigs')
                        .to.be.at.most(Buffer.byteLength(plain, 'utf8'));
                }
            }
        });

        it('emits rounds ascending and pairs sorted regardless of caller ordering', function () {
            let h = makePublisher();
            let rounds = [
                bufferedFixture(2, { pairs: [{ coinPair: 'ZZZ/USD', price: '3' }, { coinPair: 'AAA/USD', price: '1' }] }),
                bufferedFixture(1, { pairs: [{ coinPair: 'AAA/USD', price: '2' }] })
            ];
            let body = h.p.buildPriceBatchBody(1, 2, 800002, rounds, sigsOf(1));
            let f = body.split('|');
            expect(f.slice(0, 4)).to.deep.equal(['1', '2', '800002', '2']);
            expect(f[4]).to.equal('1');                    // round 1 first
            expect(f.slice(8, 10)).to.deep.equal(['AAA/USD', '2']);
            expect(f.indexOf('AAA/USD', 10)).to.be.lessThan(f.indexOf('ZZZ/USD'));
        });
    });

    // ───────────────────────────────────── per-round markers (D10)

    describe('at-most-once markers, one row per contained round', function () {

        it('writes a durable marker for EVERY round on the wire, not just FIRST_ROUND', async function () {
            let db = makeDb();
            let h  = makePublisher({ db: db, cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));

            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);
            expect(Object.keys(db.markers).map(Number).sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3, 4, 5]);
            for (let r = 0; r < 6; r++) expect(db.markers[r].sent_at).to.not.equal(null);
        });

        it('keeps the queue entry identity on FIRST_ROUND so the existing Sets and the retention clamp still work', async function () {
            let h = makePublisher();
            await h.p.start();
            for (let r = 6; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
            sinon.stub(h.p, '_processQueue').resolves();   // keep the entry on disk to read
            await h.p._assembleWindow(1);

            let queued = readJsonl(h.queuePath);
            expect(queued).to.have.length(1);
            expect(queued[0].round).to.equal(6);
            expect(queued[0].batch.rounds).to.deep.equal([6, 7, 8, 9, 10, 11]);
        });

        it('SUPPRESSES a re-publish of the same rounds under a DIFFERENT split (the duplicate DOGE spend)', async function () {
            let db = makeDb();
            let h  = makePublisher({ db: db });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);

            // A second leader (or this hub after a restart) re-proposes the SAME rounds
            // under a different split: [0,2] and [3,5]. Neither wire's FIRST_ROUND is 1,
            // 2, 4 or 5, so a marker keyed on FIRST_ROUND alone would find nothing for
            // four of the six rounds and pay a second DOGE fee for them.
            let second = new OraclePublisher(h.hub);
            instances.push(second);
            await second.start();
            let seen = [];
            second.setBroadcastHook(async (p) => { seen.push(p); return { txid: 'dup' }; });
            for (let split of [[0, 2], [3, 5]]) {
                let rounds = [];
                for (let r = split[0]; r <= split[1]; r++) rounds.push(bufferedFixture(r));
                await second._enqueue({
                    round: split[0],
                    batch: { windowIndex: 0, firstRound: split[0], lastRound: split[1],
                             anchor: 800000 + split[1], rounds: rounds.map(r => r.round),
                             sigCount: 3, compressed: false, wireIndex: 0, wireCount: 2 },
                    wire: second._emitWire(split[0], split[1], 800000 + split[1], rounds, sigsOf(3)).wire
                });
            }
            await second._processQueue();

            expect(seen, 'a re-split re-publish must not reach the wire').to.have.length(0);
            // Suppressed on the strength of a marker for a round that is NOT either
            // wire's FIRST_ROUND. Startup hydration loads the durable rows into the
            // in-process guard, so the guard that fires is whichever reads first; both
            // are keyed per contained round.
            expect(logs.warn.join('\n')).to.match(/already broadcast this process lifetime|durable sent marker/);
            expect(readJsonl(h.queuePath), 'both stale wires must be dropped').to.have.length(0);
        });
    });

    // ───────────────────────────────────── clearPublishedMarkers (D28)

    describe('clearPublishedMarkers', function () {

        // The realistic retraction shape: a batch published, then the hub restarted (or
        // simply kept running long enough to re-hydrate), so the durable rows are loaded
        // back into the in-process guard. That is the state in which clearing only ONE
        // of the two halves is observably wrong.
        async function publishThenRehydrate() {
            let db = makeDb();
            let h  = makePublisher({ db: db });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            await h.p._assembleWindow(0);
            expect(h.broadcasts).to.have.length(1);
            expect(Object.keys(db.markers)).to.have.length(6);

            let live = new OraclePublisher(h.hub);
            instances.push(live);
            let seen = [];
            live.setBroadcastHook(async (p) => { seen.push(p); return { txid: 'recovery' }; });
            await live.start();   // hydration arms the in-process guard from the durable rows
            for (let r = 0; r < 6; r++) live._buffer.set(r, bufferedFixture(r));
            return { db, live, seen };
        }

        it('clears BOTH the durable rows and the in-process at-most-once set', async function () {
            let { db, live } = await publishThenRehydrate();
            for (let r = 0; r < 6; r++) {
                expect(live._publishedRounds.has(r), 'hydrated guard for ' + r).to.equal(true);
            }

            let deleted = await live.clearPublishedMarkers([0, 1, 2, 3, 4, 5]);
            expect(deleted).to.equal(6);
            expect(Object.keys(db.markers)).to.have.length(0);
            for (let r = 0; r < 6; r++) {
                expect(live._publishedRounds.has(r), 'in-process guard for ' + r).to.equal(false);
            }
            // The window memo is the third suppressor and must go too.
            expect(live._assembledWindows.has(0)).to.equal(false);
        });

        it('lets the recovery re-publish actually reach the wire after a retraction', async function () {
            let { live, seen } = await publishThenRehydrate();
            await live.clearPublishedMarkers([0, 1, 2, 3, 4, 5]);
            await live._assembleWindow(0);
            expect(seen, 'the recovery re-publish must go out').to.have.length(1);
        });

        it('leaves the re-publish suppressed while the markers stand', async function () {
            let { live, seen } = await publishThenRehydrate();
            live._assembledWindows.delete(0);
            await live._assembleWindow(0);
            expect(seen, 'nothing may re-publish while the markers stand').to.have.length(0);
        });

        it('leaves the quarantine set alone: a retraction does not resolve an unknown on-chain state', async function () {
            let h = makePublisher({ db: makeDb() });
            await h.p.start();
            h.p._quarantinedRounds.add(7);
            await h.p.clearPublishedMarkers([7]);
            expect(h.p._quarantinedRounds.has(7)).to.equal(true);
        });

        it('is a no-op on an empty or unparseable list', async function () {
            let db = makeDb({ markers: { 5: { round: 5, txid: 't', sent_at: 'x' } } });
            let h  = makePublisher({ db: db });
            await h.p.start();
            expect(await h.p.clearPublishedMarkers([])).to.equal(0);
            expect(await h.p.clearPublishedMarkers(['nope', null])).to.equal(0);
            expect(Object.keys(db.markers)).to.have.length(1);
        });
    });

    // ───────────────────────────────────── the loud ceiling (D19, section 8)

    describe('the loud ceiling', function () {

        it('logs CRITICAL, counts, and dead-letters a single round that cannot fit any wire', async function () {
            let h = makePublisher({ signerOpts: { sigCount: 3 } });
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0, { pairs: pairsOf(1200, 'huge') }));
            // The premise, measured rather than assumed: it fits neither bound.
            expect(h.p._wireFits(h.p._emitWire(0, 0, 800000, h.p._bufferedRange(0, 0), sigsOf(3))))
                .to.equal(false);

            await h.p._assembleWindow(0);

            expect(h.p.getStats().batchUnpublishableCount).to.equal(1);
            expect(logs.error.join('\n')).to.match(/OraclePublisher: CRITICAL - PRICE v0 round 0 alone does not fit/);
            expect(logs.error.join('\n')).to.match(/inflated-body cap|encoder payload limit/);
            let dead = readJsonl(h.deadPath);
            expect(dead).to.have.length(1);
            expect(dead[0].round).to.equal(0);
            expect(dead[0].reason).to.match(/exceeds encoder limit/);
            expect(h.broadcasts, 'nothing may publish for an unpublishable round').to.have.length(0);
        });

        it('still publishes the rest of the window around one unpublishable round', async function () {
            let h = makePublisher();
            await h.p.start();
            h.p._buffer.set(0, bufferedFixture(0, { pairs: pairsOf(1200, 'huge') }));
            h.p._buffer.set(1, bufferedFixture(1));
            h.p._buffer.set(2, bufferedFixture(2));

            await h.p._assembleWindow(0);

            expect(h.p.getStats().batchUnpublishableCount).to.equal(1);
            expect(h.broadcasts).to.have.length(1);
            let entry = readJsonl(h.queuePath);
            expect(entry).to.have.length(0);   // published and dequeued
            expect(h.signer.calls[h.signer.calls.length - 1]).to.include({ first: 1, last: 2 });
        });
    });

    // ───────────────────────────────────── stats (section 7)

    describe('getStats', function () {

        it('carries the five batch fields and keeps lastPublishedRound on the LAST round of the wire', async function () {
            let h = makePublisher({ db: makeDb(), signerOpts: { timeouts: 4 } });
            await h.p.start();
            for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
            await h.p._assembleWindow(0);

            let s = h.p.getStats();
            expect(s.batchWindowsPublished).to.equal(1);
            expect(s.lastPublishedWindow).to.equal(0);
            expect(s.batchSplitCount).to.equal(0);
            expect(s.batchUnpublishableCount).to.equal(0);
            expect(s.batchSignTimeouts).to.equal(4);
            // The dashboard's publisher-stall rule reads this field as "the newest round
            // on chain"; FIRST_ROUND would make a healthy rail look an hour behind.
            expect(s.lastPublishedRound).to.equal(5);
        });

        it('counts a split window ONCE in batchWindowsPublished', async function () {
            let h = makePublisher({ db: makeDb() });
            await h.p.start();
            for (let r = 0; r < 6; r++) {
                h.p._buffer.set(r, bufferedFixture(r, { pairs: pairsOf(90, 'stats' + r) }));
            }
            await h.p._assembleWindow(0);
            let s = h.p.getStats();
            expect(s.batchSplitCount).to.be.greaterThan(0);
            expect(s.batchWindowsPublished).to.equal(1);
        });

        it('reports zero sign timeouts without constructing a signer', function () {
            let h = makePublisher({ signer: null });
            expect(h.p.getStats().batchSignTimeouts).to.equal(0);
            expect(h.p._ownedBatchSigner).to.equal(null);
        });
    });

    // ───────────────────────────────────── the two claims section 7 asserts about other code

    describe('claims section 7 makes about the surrounding code', function () {

        it('refuses a two-phase P2SH encoding BEFORE the wallet hook, so an oversized batch costs no fee', async function () {
            let h = makePublisher();
            await h.p.start();
            h.p.broadcastFn   = null;                       // exercise the DEFAULT pipeline
            h.p.dogeAddress   = 'DEXAMPLEaddress0000000000000000000';
            h.p.dogePubkeyHex = hex(66, 'doge-pubkey');
            h.p.walletSignFn  = sinon.stub().resolves('deadbeef');
            h.p.encoder = {
                getUtxos:  sinon.stub().resolves([{ value: 100000000 }]),
                // Phase 1 of a two-transaction encoding, which is what an oversized
                // payload gets back from the encoder.
                createTx:  sinon.stub().resolves({ psbt: 'aabb', encoding: 'P2SH',
                                                   carrierScripts: ['5121aa'] }),
                broadcastTx: sinon.stub().resolves({ txid: 'must-not-happen' })
            };

            let threw = null;
            try { await h.p._defaultBroadcast('PRICE|0|0|5|800005|1|...'); } catch (e) { threw = e; }

            expect(threw, 'the guard must throw').to.not.equal(null);
            expect(threw.message).to.match(/phase 1 of a two-transaction/);
            expect(h.p.walletSignFn.called, 'nothing may be signed').to.equal(false);
            expect(h.p.encoder.broadcastTx.called, 'no fee may be spent').to.equal(false);
        });

        it('satisfies the exact predicate PriceAggregator gates its retraction clear on', function () {
            let h = makePublisher();
            // PriceAggregator.js: canClearMarkers = typeof publisher.clearPublishedMarkers === 'function'
            expect(typeof h.p.clearPublishedMarkers).to.equal('function');
            expect(h.p.clearPublishedMarkers.length).to.equal(1);
        });
    });

    // ───────────────────────────────────── knobs (D24)

    describe('knobs', function () {

        it('defaults the window to the cadence ceiling, keeps 300000 / 4032, and reads ' +
           'grace and buffer overrides from p2pConfig', function () {
            let a = makePublisher({ fleetCadence: true });
            // 1800s bound - 300s grace - 300s landing reserve = 1200s of budget, which
            // is two 600s rounds. NOT the prior 6: that published hourly against a
            // half-hourly staleness gate.
            expect(a.p.batchWindowRounds).to.equal(2);
            expect(a.p.batchWindowRoundsCeiling).to.equal(2);
            expect(a.p.batchGraceMs).to.equal(300000);
            expect(a.p.batchBufferMaxRounds).to.equal(4032);

            let b = makePublisher({ fleetCadence: true,
                                    cfg: { ORACLE_BATCH_GRACE_MS: 1000,
                                           ORACLE_BATCH_BUFFER_MAX_ROUNDS: 50 } });
            expect(b.p.batchGraceMs).to.equal(1000);
            expect(b.p.batchBufferMaxRounds).to.equal(50);
        });

        it('honours a window at or below the ceiling', function () {
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_BATCH_WINDOW_ROUNDS: 1 } });
            expect(h.p.batchWindowRounds).to.equal(1);
            expect(logs.warn.join('\n')).to.not.contain('ORACLE_BATCH_WINDOW_ROUNDS');
        });

        it('clamps a window that would outrun the fee-price staleness bound, and says so', function () {
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_BATCH_WINDOW_ROUNDS: 12 } });
            expect(h.p.batchWindowRounds).to.equal(2);
            let warn = logs.warn.join('\n');
            expect(warn).to.contain('ORACLE_BATCH_WINDOW_ROUNDS=12');
            expect(warn).to.contain('1800s fee-price staleness bound');
            expect(warn).to.contain('clamping to 2');
        });

        it('re-derives the ceiling when the grace or the round interval moves', function () {
            // A shorter grace and a shorter landing reserve free budget for more rounds
            // per wire: at a 300s round interval, (1800 - 60 - 60) / 300 buys 5.
            let h = makePublisher({ fleetCadence: true,
                                    cfg: { ORACLE_ROUND_INTERVAL: 300000,
                                           ORACLE_BATCH_GRACE_MS: 60000,
                                           ORACLE_BATCH_LANDING_RESERVE_MS: 60000 } });
            expect(h.p.batchWindowRoundsCeiling).to.equal(5);
            expect(h.p.batchWindowRounds).to.equal(5);
        });

        it('publishes one round per batch, loudly, when no window fits the bound', function () {
            // An hour-long round interval cannot fit a 1800s bound at any window size.
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_ROUND_INTERVAL: 3600000 } });
            expect(h.p.batchWindowRounds).to.equal(1);
            expect(logs.warn.join('\n')).to.contain('no batch window fits');
        });

        it('reports the cadence against the bound in getStats', function () {
            let h = makePublisher({ fleetCadence: true });
            let s = h.p.getStats();
            expect(s.batchWindowRounds).to.equal(2);
            expect(s.batchWindowRoundsCeiling).to.equal(2);
            expect(s.batchCadenceSeconds).to.equal(1200);
            expect(s.oracleMaxPriceAgeSeconds).to.equal(1800);
            // 2 * 600 + 300 grace + 300 landing reserve. The reserve is budgeted at 300s
            // against a measured ~180s, so the peak an operator actually sees sits below
            // this figure; it must never sit above the bound.
            expect(s.batchWorstCaseSnapshotAgeSeconds).to.equal(1800);
            expect(s.batchWorstCaseSnapshotAgeSeconds).to.be.at.most(s.oracleMaxPriceAgeSeconds);
        });

        it('puts the buffer file beside the queue and the dead-letter file', function () {
            let h = makePublisher();
            expect(h.p.bufferPath).to.equal(h.bufferPath);
            expect(path.dirname(h.p.bufferPath)).to.equal(path.dirname(h.p.deadLetterPath));
        });
    });

    // ───────────────────────────────────── the cadence a chain reader sees

    describe('the cadence a chain reader sees', function () {

        // The verify clause is a live one: PRICE gaps on a fee-bearing chain stay
        // under the staleness bound for a FULL HOUR, and an action picked at a random
        // moment in it still prices. It cannot be run here, but its shape can: drive the
        // real scheduler through two hours of fleet-cadence rounds, take the round ranges
        // off the wires it actually queued, and walk a reader across the hour those wires
        // cover. The arithmetic module is already tested on its own; what this adds is
        // that the SCHEDULER emits the windows that arithmetic assumes. A publisher that
        // derived a 2-round ceiling and then went on batching six rounds a wire would
        // pass every test in `knobs` and fail here, which is the failure that put the
        // half-hourly fee gate behind an hourly rail in the first place.

        const ROUND_S   = 600;    // ORACLE_ROUND_INTERVAL as the fleet runs it
        const GRACE_S   = 300;    // ORACLE_BATCH_GRACE_MS, ditto
        const RESERVE_S = 300;    // ORACLE_BATCH_LANDING_RESERVE_MS, budgeted
        const BOUND_S   = 1800;   // ORACLE_MAX_PRICE_AGE_SECONDS, consensus-pinned

        // roundFixture's own clock, which is one round every ROUND_S.
        function tsOf(round) { return 1800000000 + round * ROUND_S; }

        // When a wire covering [.., lastRound] becomes readable on chain, and what the
        // newest snapshot it carries is dated. Both halves of what a fee-paying action
        // is judged against.
        function landing(lastRound) {
            return { readableAt: tsOf(lastRound) + GRACE_S + RESERVE_S, newest: tsOf(lastRound) };
        }

        // The oldest the newest visible snapshot ever gets, walked second by second
        // across the whole span these landings cover. Second-by-second rather than at the
        // peaks alone because the verify clause is about an arbitrary moment, not a
        // chosen one.
        function peakSnapshotAge(landings) {
            let worst = 0;
            for (let t = landings[0].readableAt; t <= landings[landings.length - 1].readableAt; t++) {
                let newest = null;
                for (let l of landings) { if (l.readableAt <= t) newest = l.newest; }
                worst = Math.max(worst, t - newest);
            }
            return worst;
        }

        it('keeps the newest snapshot inside the fee-price bound for every second of the hour', async function () {
            // The grace is shortened to 1ms so the case does not sleep five real minutes
            // per window; the age arithmetic below still uses the fleet's 300s, which is
            // the conservative direction (a longer grace than the run actually took).
            let h = makePublisher({ fleetCadence: true, cfg: { ORACLE_BATCH_GRACE_MS: 1 } });
            await h.p.start();
            expect(h.p.batchWindowRounds).to.equal(2);

            for (let r = 0; r < 12; r++) await h.p.onRoundFinalized(roundFixture(r));
            await waitUntil(() => h.signer.calls.length >= 6,
                { label: 'six 2-round windows to close and be proposed' });
            await h.p._windowChain;

            // What went on the wire, not what the config said would.
            let wires = h.signer.calls.map(c => [c.first, c.last]);
            expect(wires).to.deep.equal([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]]);
            expect(h.broadcasts).to.have.length(6);

            let landings = h.signer.calls.map(c => landing(c.last));
            // The span walked is longer than the hour the clause asks for.
            expect(landings[landings.length - 1].readableAt - landings[0].readableAt)
                .to.be.at.least(3600);
            // 1200s of window + 300s grace + 300s reserve, less the one second the walk
            // cannot sample: the next landing resets the age at exactly the peak instant,
            // so the sampled maximum sits one second below the open supremum of 1800s.
            expect(peakSnapshotAge(landings)).to.equal(1799);
            expect(peakSnapshotAge(landings)).to.be.at.most(BOUND_S);

            // And the publish gap itself, which is what the explorer shows as the gap
            // between consecutive PRICE actions.
            for (let i = 1; i < landings.length; i++) {
                expect(landings[i].newest - landings[i - 1].newest).to.equal(2 * ROUND_S);
                expect(landings[i].newest - landings[i - 1].newest).to.be.below(BOUND_S);
            }
        });

        it('measures the pre-fix 6-round window failing the same walk', async function () {
            // The regression this case exists to catch, priced with the same arithmetic
            // the passing case uses: an hourly rail leaves the newest snapshot 4200s old
            // against a 1800s gate, so a fee-bearing action fails for most of every hour.
            // Exactly what testnet showed on 2026-09-01.
            let sixRoundWires = [landing(5), landing(11), landing(17)];
            // Same one-second sampling artefact as above, against a supremum of 4200s.
            expect(peakSnapshotAge(sixRoundWires)).to.equal(4199);
            expect(peakSnapshotAge(sixRoundWires)).to.be.above(BOUND_S);
        });
    });
});
