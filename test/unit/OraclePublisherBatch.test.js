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
            if (/block_timestamp/i.test(q)) {
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
    let hub = {
        p2pConfig: Object.assign({ PUBLISHER_QUEUE_PATH: path.join(dir, 'publisher-queue.jsonl') },
                                 opts.cfg || {}),
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

        it('defaults to 6 / 300000 / 4032 and reads overrides from p2pConfig', function () {
            let a = makePublisher();
            expect(a.p.batchWindowRounds).to.equal(6);
            expect(a.p.batchGraceMs).to.equal(300000);
            expect(a.p.batchBufferMaxRounds).to.equal(4032);

            let b = makePublisher({ cfg: { ORACLE_BATCH_WINDOW_ROUNDS: 12,
                                           ORACLE_BATCH_GRACE_MS: 1000,
                                           ORACLE_BATCH_BUFFER_MAX_ROUNDS: 50 } });
            expect(b.p.batchWindowRounds).to.equal(12);
            expect(b.p.batchGraceMs).to.equal(1000);
            expect(b.p.batchBufferMaxRounds).to.equal(50);
        });

        it('puts the buffer file beside the queue and the dead-letter file', function () {
            let h = makePublisher();
            expect(h.p.bufferPath).to.equal(h.bufferPath);
            expect(path.dirname(h.p.bufferPath)).to.equal(path.dirname(h.p.deadLetterPath));
        });
    });
});
