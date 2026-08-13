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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const path           = require('path');
const os             = require('os');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

// Stub out fs and EncoderClient so no real files are written
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
    OraclePublisher = proxyquire('../../src/OraclePublisher', {
        fs: fsMock,
        './EncoderClient': function () { return null; }  // encoder=null by default
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

// A minimal in-memory stand-in for hub.db (the MariaDB wrapper's doQuery). Models
// the oracle_published_rounds table so the durable at-most-once path can be driven
// without a real database. Pre-seed `markers` to simulate rows surviving a restart.
function makeDb(seed) {
    let markers = Object.assign({}, seed || {});   // round -> { round, txid, sent_at }
    let db = {
        markers,
        doQuery: sinon.stub().callsFake(async function (q, args) {
            if (/^\s*SELECT/i.test(q)) {
                if (/WHERE\s+round/i.test(q)) {
                    let r = Number(args[0]);
                    return markers[r] ? [markers[r]] : [];
                }
                return Object.keys(markers).map(k => markers[k]);   // full-table hydrate scan
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
            // Retention DELETE. Applies exactly the predicates present in the SQL text
            // rather than the ones the caller meant to write, so a production query that
            // drops `sent_at IS NOT NULL` really does erase the quarantine rows here and
            // the retention tests fail instead of passing on a stub's good manners.
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

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('OraclePublisher', function () {

    beforeEach(function () {
        loadModule();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('reads DOGE_ADDRESS from p2pConfig', function () {
            let hub = makeHub({ p2pConfig: { DOGE_ADDRESS: 'D123abc' } });
            let pub = new OraclePublisher(hub);
            expect(pub.dogeAddress).to.equal('D123abc');
        });

        it('uses defaults for numeric fields', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            expect(pub.maxAttempts).to.equal(5);
            expect(pub.lowBalanceThreshold).to.equal(10);
        });

        it('reads PUBLISHER_MAX_ATTEMPTS from config', function () {
            let hub = makeHub({ p2pConfig: { PUBLISHER_MAX_ATTEMPTS: '3' } });
            let pub = new OraclePublisher(hub);
            expect(pub.maxAttempts).to.equal(3);
        });
    });

    // ── setBroadcastHook / setWalletSignHook / setBalanceHook ──────────────

    describe('hooks', function () {
        it('stores broadcastFn via setBroadcastHook', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let fn  = sinon.stub();
            pub.setBroadcastHook(fn);
            expect(pub.broadcastFn).to.equal(fn);
        });

        it('stores walletSignFn via setWalletSignHook', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let fn  = sinon.stub();
            pub.setWalletSignHook(fn);
            expect(pub.walletSignFn).to.equal(fn);
        });

        it('stores getBalanceFn via setBalanceHook', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let fn  = sinon.stub();
            pub.setBalanceHook(fn);
            expect(pub.getBalanceFn).to.equal(fn);
        });
    });

    // ── buildPriceV0Wire ─────────────────────────────────────────────────────

    describe('buildPriceV0Wire()', function () {
        it('builds a correct pipe-delimited PRICE v0 wire string', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let prices = [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '80' }
            ];
            let sigs = [{ pubkey: 'pk1', sig: 'sig1' }];
            // PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|... (#4232: height on the wire)
            let wire = pub.buildPriceV0Wire(42, 1700000000, prices, sigs, 850010);
            let parts = wire.split('|');
            expect(parts[0]).to.equal('PRICE');
            expect(parts[1]).to.equal('0');
            expect(parts[2]).to.equal('42');
            expect(parts[3]).to.equal('1700000000');
            expect(parts[4]).to.equal('850010');  // BTC block height (round anchor)
            expect(parts[5]).to.equal('2');  // price count
            expect(parts[6]).to.equal('BTC/USD');
            expect(parts[7]).to.equal('100000');
            expect(parts[8]).to.equal('LTC/USD');
            expect(parts[9]).to.equal('80');
            expect(parts[10]).to.equal('1');  // sig count
            expect(parts[11]).to.equal('pk1');
            expect(parts[12]).to.equal('sig1');
        });

        it('handles no signatures gracefully', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let wire = pub.buildPriceV0Wire(1, 0, [{ coinPair: 'BTC/USD', price: '100' }], [], 850010);
            expect(wire).to.match(/^PRICE\|0\|1\|0\|850010\|1\|BTC\/USD\|100\|0$/);
        });

        it('uses `pair` property as fallback when `coinPair` is absent', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let wire = pub.buildPriceV0Wire(1, 0, [{ pair: 'BTC/USD', price: '100' }], [], 850010);
            expect(wire).to.include('BTC/USD');
        });
    });

    // ── _buildSignablePayload ────────────────────────────────────────────────

    describe('_buildSignablePayload()', function () {
        it('produces a JSON string with sorted pairs', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let prices = [
                { coinPair: 'LTC/USD', price: '80' },
                { coinPair: 'BTC/USD', price: '100000' }
            ];
            let payload = JSON.parse(pub._buildSignablePayload(42, 1700000000, prices, 850010));
            expect(payload.round).to.equal(42);
            expect(payload.timestamp).to.equal(1700000000);
            expect(payload.btc_block_height).to.equal(850010);  // #4232: round BTC anchor in signed payload
            // Pairs must be sorted alphabetically
            expect(payload.pairs[0].pair).to.equal('BTC/USD');
            expect(payload.pairs[1].pair).to.equal('LTC/USD');
        });

        it('produces deterministic output for same inputs', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let prices = [{ coinPair: 'BTC/USD', price: '50000' }];
            let p1 = pub._buildSignablePayload(1, 100, prices);
            let p2 = pub._buildSignablePayload(1, 100, prices);
            expect(p1).to.equal(p2);
        });
    });

    // ── _buildLocalSigOnly ───────────────────────────────────────────────────

    describe('_buildLocalSigOnly()', function () {
        it('returns empty array when no identity', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.identity = null;
            let sigs = pub._buildLocalSigOnly({ round: 1, btcBlockTime: 0, prices: [] });
            expect(sigs).to.deep.equal([]);
        });

        it('builds a single-validator sig with pubkey and sig fields', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let sigs = pub._buildLocalSigOnly({
                round: 1, btcBlockTime: 1700000000,
                prices: [{ coinPair: 'BTC/USD', price: '100000' }]
            });
            expect(sigs).to.have.length(1);
            expect(sigs[0]).to.have.property('pubkey');
            expect(sigs[0]).to.have.property('sig');
        });

        it('returns empty array when _buildSignablePayload throws', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            // Make identity.sign throw
            pub.identity.sign = sinon.stub().throws(new Error('sign failed'));
            let sigs = pub._buildLocalSigOnly({ round: 1, btcBlockTime: 0, prices: [] });
            expect(sigs).to.deep.equal([]);
        });
    });

    // ── _readQueue ────────────────────────────────────────────────────────────

    describe('_readQueue()', function () {
        it('returns empty array when queue file does not exist', function () {
            fsMock.readFileSync.throws(new Error('ENOENT'));
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            expect(pub._readQueue()).to.deep.equal([]);
        });

        it('parses valid JSONL entries', function () {
            let e1 = { round: 1, prices: [] };
            let e2 = { round: 2, prices: [] };
            fsMock.readFileSync.returns(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let entries = pub._readQueue();
            expect(entries).to.have.length(2);
            expect(entries[0].round).to.equal(1);
        });

        it('skips invalid JSON lines', function () {
            fsMock.readFileSync.returns('INVALID_JSON\n' + JSON.stringify({ round: 1 }) + '\n');
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let entries = pub._readQueue();
            expect(entries).to.have.length(1);
        });

        it('skips blank lines', function () {
            fsMock.readFileSync.returns('\n\n' + JSON.stringify({ round: 1 }) + '\n\n');
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let entries = pub._readQueue();
            expect(entries).to.have.length(1);
        });
    });

    // ── _rewriteQueue ─────────────────────────────────────────────────────────

    describe('_rewriteQueue()', function () {
        it('writes JSON lines for each entry', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let entries = [{ round: 1 }, { round: 2 }];
            pub._rewriteQueue(entries);
            expect(fsMock.writeSync.called).to.be.true;
            let written = fsMock.writeSync.firstCall.args[1];
            expect(written).to.include('{"round":1}');
            expect(written).to.include('{"round":2}');
        });

        it('writes empty string for empty entries', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub._rewriteQueue([]);
            let written = fsMock.writeSync.firstCall.args[1];
            expect(written).to.equal('');
        });

        it('handles fs error gracefully without throwing', function () {
            fsMock.openSync.throws(new Error('disk full'));
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub._rewriteQueue([{ round: 1 }]); // must not throw
        });
    });

    // ── _getActiveOraclePublishPubkeys ────────────────────────────────────────

    describe('_getActiveOraclePublishPubkeys()', function () {
        it('returns empty array when hub is null', async function () {
            let pub  = new OraclePublisher(makeHub());
            pub.hub  = null;
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.deep.equal([]);
        });

        it('uses capability snapshot when available', async function () {
            let capSS = {
                getSnapshot: sinon.stub().resolves({
                    validators: [{ pubkey: 'CC'.repeat(32) }, { pubkey: 'BB'.repeat(32) }]
                })
            };
            let hub = makeHub({ capabilitySnapshot: capSS });
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            // Sorted ascending
            expect(keys[0]).to.equal('bb'.repeat(32));
            expect(keys[1]).to.equal('cc'.repeat(32));
        });

        it('fails closed (empty) when the snapshot call throws, never the per-hub registry', async function () {
            // The block-unpinned gossip-driven registry fallback was removed: two hubs
            // resolving different election sets double-anchor / duplicate PRICE v0.
            let capSS = { getSnapshot: sinon.stub().rejects(new Error('indexer down')) };
            let capReg = { getActiveValidators: sinon.stub().resolves(['AA'.repeat(32)]) };
            let hub = makeHub({ capabilitySnapshot: capSS, capabilityRegistry: capReg });
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.deep.equal([]);
            expect(capReg.getActiveValidators.called).to.equal(false);
        });

        it('fails closed (empty) when the snapshot resolves no validators, never the registry', async function () {
            let capSS = { getSnapshot: sinon.stub().resolves(null) };
            let capReg = { getActiveValidators: sinon.stub().resolves(['pk1']) };
            let hub = makeHub({ capabilitySnapshot: capSS, capabilityRegistry: capReg });
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.deep.equal([]);
            expect(capReg.getActiveValidators.called).to.equal(false);
        });

        it('fails closed (empty) with no snapshot configured', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.deep.equal([]);
        });
    });

    // ── _getMyRank ────────────────────────────────────────────────────────────

    describe('_getMyRank()', function () {
        it('returns null when no identity', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.identity = null;
            let rank = await pub._getMyRank(100);
            expect(rank).to.be.null;
        });

        it('returns rank index when pubkey is in the list', async function () {
            let myPk = 'bb'.repeat(32);
            let capSS = {
                getSnapshot: sinon.stub().resolves({
                    validators: [{ pubkey: 'aa'.repeat(32) }, { pubkey: myPk }]
                })
            };
            let hub = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = sinon.stub().returns(makeIdentity(myPk));
            let pub = new OraclePublisher(hub);
            let rank = await pub._getMyRank(100);
            expect(rank).to.equal(1); // sorted: aa...=0, bb...=1
        });

        it('returns null when pubkey is not in the validator list', async function () {
            let capSS = {
                getSnapshot: sinon.stub().resolves({
                    validators: [{ pubkey: 'cc'.repeat(32) }]
                })
            };
            let hub = makeHub({ capabilitySnapshot: capSS });
            hub.getIdentity = sinon.stub().returns(makeIdentity('dd'.repeat(32)));
            let pub = new OraclePublisher(hub);
            let rank = await pub._getMyRank(100);
            expect(rank).to.be.null;
        });
    });

    // ── _checkBalance ─────────────────────────────────────────────────────────

    describe('_checkBalance()', function () {
        it('returns null when no getBalanceFn and no encoder', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let bal = await pub._checkBalance();
            expect(bal).to.be.null;
        });

        it('calls getBalanceFn when set', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.getBalanceFn = sinon.stub().resolves(42.5);
            let bal = await pub._checkBalance();
            expect(bal).to.equal(42.5);
        });

        it('returns null when getBalanceFn throws', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.getBalanceFn = sinon.stub().rejects(new Error('rpc error'));
            let bal = await pub._checkBalance();
            expect(bal).to.be.null;
        });

        it('sums UTXOs from encoder when getBalanceFn is not set', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.dogeAddress = 'D123';
            pub.encoder = {
                getUtxos: sinon.stub().resolves([{ value: 5.0 }, { value: 3.5 }])
            };
            let bal = await pub._checkBalance();
            expect(bal).to.equal(8.5);
        });

        it('handles encoder getUtxos failure by returning null', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.dogeAddress = 'D123';
            pub.encoder = {
                getUtxos: sinon.stub().rejects(new Error('encoder error'))
            };
            let bal = await pub._checkBalance();
            expect(bal).to.be.null;
        });

        it('handles non-array UTXO result gracefully', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            pub.dogeAddress = 'D123';
            pub.encoder = { getUtxos: sinon.stub().resolves(null) };
            let bal = await pub._checkBalance();
            expect(bal).to.be.null;
        });
    });

    // ── _processQueue ─────────────────────────────────────────────────────────

    describe('_processQueue()', function () {
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
    // Regression for the swallowed _rewriteQueue failure that let an already-
    // published round stay on the durable queue and be re-broadcast on the next
    // tick, spending real DOGE twice for the same PRICE v0 round.
    describe('_processQueue() at-most-once under rewrite failure', function () {
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
    describe('_processQueue() durable at-most-once', function () {
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
    describe('start() durable-marker hydration', function () {
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

    // ── start ────────────────────────────────────────────────────────────────

    describe('start()', function () {
        it('creates queue directory and subscribes to oracle finalization', async function () {
            let EventEmitter = require('events');
            let fakeConsensus = new EventEmitter();
            let hub = makeHub({ oracleConsensus: fakeConsensus });
            let pub = new OraclePublisher(hub);
            fsMock.existsSync.returns(false);
            await pub.start();
            // The oracle consensus event handler should be registered
            expect(fakeConsensus.listenerCount('round:finalized')).to.equal(1);
        });

        it('does not throw when queue file creation fails', async function () {
            fsMock.existsSync.returns(false);
            fsMock.writeFileSync.throws(new Error('read-only fs'));
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            await pub.start();  // must not throw
        });
    });

    // ── onRoundFinalized ──────────────────────────────────────────────────────

    describe('onRoundFinalized()', function () {
        it('returns early when _getMyRank returns null (not a publisher)', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            sinon.stub(pub, '_getMyRank').resolves(null);
            let enqueueSpy = sinon.spy(pub, '_enqueue');
            await pub.onRoundFinalized({ round: 1, btcBlockHeight: 100, prices: [], signatures: [] });
            expect(enqueueSpy.called).to.be.false;
        });

        it('returns early when publisherCount is 0', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            sinon.stub(pub, '_getMyRank').resolves(0);
            sinon.stub(pub, '_getActiveOraclePublishCount').resolves(0);
            let enqueueSpy = sinon.spy(pub, '_enqueue');
            await pub.onRoundFinalized({ round: 1, btcBlockHeight: 100, prices: [] });
            expect(enqueueSpy.called).to.be.false;
        });

        it('returns early when not the designated leader', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            // rank=1, count=3, round=0: leaderRank=0%3=0 ≠ rank=1
            sinon.stub(pub, '_getMyRank').resolves(1);
            sinon.stub(pub, '_getActiveOraclePublishCount').resolves(3);
            let enqueueSpy = sinon.spy(pub, '_enqueue');
            await pub.onRoundFinalized({ round: 0, btcBlockHeight: 100, prices: [] });
            expect(enqueueSpy.called).to.be.false;
        });

        it('enqueues when this hub is the leader', async function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            // rank=0, count=3, round=3: leaderRank=3%3=0 === rank=0
            sinon.stub(pub, '_getMyRank').resolves(0);
            sinon.stub(pub, '_getActiveOraclePublishCount').resolves(3);
            let enqueueStub = sinon.stub(pub, '_enqueue').resolves();
            let processStub = sinon.stub(pub, '_processQueue').resolves();
            await pub.onRoundFinalized({ round: 3, btcBlockHeight: 100, btcBlockTime: 0, prices: [], signatures: [{ pubkey: 'pk', sig: 'sig' }] });
            expect(enqueueStub.calledOnce).to.be.true;
            expect(processStub.calledOnce).to.be.true;
        });
    });

    // ── _defaultBroadcast() pipeline ────────────────────────────────────────
    describe('_defaultBroadcast()', function () {
        // Build a publisher with a fully-wired encoder + hooks, then let each test
        // knock out one prerequisite to exercise the corresponding guard.
        function wiredPub() {
            let pub = new OraclePublisher(makeHub());
            pub.encoder = {
                getUtxos:    sinon.stub().resolves([{ txid: 'a', vout: 0, value: 100000 }]),
                createTx:    sinon.stub().resolves({ psbt: 'psbthex' }),
                broadcastTx: sinon.stub().resolves({ txid: 'TXID' })
            };
            pub.walletSignFn  = sinon.stub().resolves('signedtxhex');
            pub.dogeAddress   = 'DwhateverAddress';
            pub.dogePubkeyHex = '02' + 'a'.repeat(64);
            return pub;
        }
        async function expectThrow(pub, frag) {
            try { await pub._defaultBroadcast('payload'); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include(frag); }
        }

        it('throws when the encoder is not configured', async function () {
            let pub = wiredPub(); pub.encoder = null;
            await expectThrow(pub, 'no encoder configured');
        });
        it('throws when no wallet sign hook is configured', async function () {
            let pub = wiredPub(); pub.walletSignFn = null;
            await expectThrow(pub, 'no wallet sign hook');
        });
        it('throws when DOGE_ADDRESS is unset', async function () {
            let pub = wiredPub(); pub.dogeAddress = null;
            await expectThrow(pub, 'no DOGE_ADDRESS');
        });
        it('throws when DOGE_PUBKEY_HEX is unset', async function () {
            let pub = wiredPub(); pub.dogePubkeyHex = null;
            await expectThrow(pub, 'no DOGE_PUBKEY_HEX');
        });
        it('throws when no UTXOs are available', async function () {
            let pub = wiredPub(); pub.encoder.getUtxos = sinon.stub().resolves([]);
            await expectThrow(pub, 'no UTXOs available');
        });
        it('throws when the encoder returns no PSBT', async function () {
            let pub = wiredPub(); pub.encoder.createTx = sinon.stub().resolves({});
            await expectThrow(pub, 'no PSBT');
        });
        it('throws when the wallet hook returns invalid tx hex', async function () {
            let pub = wiredPub(); pub.walletSignFn = sinon.stub().resolves(null);
            await expectThrow(pub, 'invalid tx hex');
        });
        it('signs, broadcasts, and returns the txid on success', async function () {
            let pub = wiredPub();
            let result = await pub._defaultBroadcast('the-payload');
            expect(result).to.deep.equal({ txid: 'TXID' });
            expect(pub.encoder.createTx.getCall(0).args[0].data).to.equal('the-payload');
            expect(pub.walletSignFn.calledWith('psbthex')).to.be.true;
            expect(pub.encoder.broadcastTx.calledWith('signedtxhex')).to.be.true;
        });
        it('falls back to { txid: null } when broadcast returns nothing', async function () {
            let pub = wiredPub(); pub.encoder.broadcastTx = sinon.stub().resolves(null);
            let result = await pub._defaultBroadcast('p');
            expect(result).to.deep.equal({ txid: null });
        });
    });

    // ── start() ─────────────────────────────────────────────────────────────
    describe('start()', function () {
        it('creates the queue dir, touches the file, and subscribes to round:finalized', async function () {
            let oc = { on: sinon.stub() };
            let pub = new OraclePublisher(makeHub({ oracleConsensus: oc }));
            fsMock.existsSync.returns(false); // force the writeFileSync touch
            await pub.start();
            expect(fsMock.mkdirSync.called).to.be.true;
            expect(fsMock.writeFileSync.called).to.be.true;
            expect(oc.on.calledWith('round:finalized')).to.be.true;
        });

        it('tolerates mkdir/touch failures without throwing', async function () {
            let pub = new OraclePublisher(makeHub());
            fsMock.mkdirSync = sinon.stub().throws(new Error('eperm'));
            fsMock.existsSync.returns(false);
            fsMock.writeFileSync = sinon.stub().throws(new Error('eacces'));
            await pub.start(); // best-effort, must not throw
        });
    });

    // ── _enqueue() ──────────────────────────────────────────────────────────
    describe('_enqueue()', function () {
        it('appends an fsync-durable JSON line with attempt metadata', async function () {
            let pub = new OraclePublisher(makeHub());
            await pub._enqueue({ round: 5, prices: [], sigs: [] });
            expect(fsMock.openSync.called).to.be.true;
            expect(fsMock.writeSync.called).to.be.true;
            expect(fsMock.fsyncSync.called).to.be.true;
            expect(fsMock.closeSync.called).to.be.true;
            let entry = JSON.parse(fsMock.writeSync.getCall(0).args[1].trim());
            expect(entry.round).to.equal(5);
            expect(entry.attempts).to.equal(0);
            expect(entry).to.have.property('enqueuedAt');
        });

        it('fails loud when the queue write throws', async function () {
            let pub = new OraclePublisher(makeHub());
            fsMock.openSync = sinon.stub().throws(new Error('disk full'));
            try { await pub._enqueue({ round: 5 }); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('disk full'); }
        });
    });

    // ── item 2677: operator kill switch ────────────────────────────────────────
    describe('ORACLE_PUBLISH_ENABLED kill switch (item 2677)', function () {
        afterEach(function () { delete process.env.ORACLE_PUBLISH_ENABLED; });

        it('defaults to enabled', function () {
            expect(new OraclePublisher(makeHub()).enabled).to.be.true;
        });

        it('onRoundFinalized enqueues nothing when disabled', async function () {
            process.env.ORACLE_PUBLISH_ENABLED = 'false';
            let pub = new OraclePublisher(makeHub());
            let enqueue = sinon.stub(pub, '_enqueue');
            let proc    = sinon.stub(pub, '_processQueue');
            await pub.onRoundFinalized({ round: 1, btcBlockHeight: 100, btcBlockTime: 0, prices: [] });
            expect(enqueue.called).to.be.false;
            expect(proc.called).to.be.false;
        });

        it('_processQueue broadcasts nothing when disabled', async function () {
            process.env.ORACLE_PUBLISH_ENABLED = 'false';
            let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
            let pub = new OraclePublisher(makeHub());
            let broadcastStub = sinon.stub().resolves({ txid: 'x' });
            pub.broadcastFn  = broadcastStub;
            pub.getBalanceFn = sinon.stub().resolves(50);
            await pub._processQueue();
            expect(broadcastStub.called).to.be.false;
        });
    });

    // ── item 2676: hard balance floor gate + per-window spend ceiling ──────────
    describe('spend gating (item 2676)', function () {
        afterEach(function () {
            delete process.env.ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW;
            delete process.env.ORACLE_PUBLISH_SPEND_WINDOW_MS;
        });

        it('skips the whole publish pass when balance is below the floor', async function () {
            let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
            let pub = new OraclePublisher(makeHub());
            let broadcastStub = sinon.stub().resolves({ txid: 'x' });
            pub.broadcastFn  = broadcastStub;
            pub.getBalanceFn = sinon.stub().resolves(3);   // below default floor 10
            await pub._processQueue();
            expect(broadcastStub.called).to.be.false;
        });

        it('skips the whole publish pass when balance is unreadable (fail-closed)', async function () {
            let entry = { round: 5, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
            let pub = new OraclePublisher(makeHub());
            let broadcastStub = sinon.stub().resolves({ txid: 'x' });
            pub.broadcastFn  = broadcastStub;
            pub.getBalanceFn = sinon.stub().rejects(new Error('rpc down'));  // -> null
            await pub._processQueue();
            expect(broadcastStub.called).to.be.false;
        });

        it('stops broadcasting once the per-window ceiling is reached, keeping rounds queued', async function () {
            process.env.ORACLE_PUBLISH_MAX_PUBLISHES_PER_WINDOW = '1';
            let e1 = { round: 1, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            let e2 = { round: 2, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            fsMock.readFileSync.returns(JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n');
            let pub = new OraclePublisher(makeHub());
            let broadcastStub = sinon.stub().resolves({ txid: 'x' });
            pub.broadcastFn  = broadcastStub;
            pub.getBalanceFn = sinon.stub().resolves(50);
            await pub._processQueue();
            expect(broadcastStub.calledOnce).to.be.true;   // only round 1 sent
            // round 2 stays on the durable queue for the next window
            let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
            expect(rewritten).to.include('"round":2');
            expect(rewritten).to.not.include('"round":1');
        });
    });

    // ── item 2675: ambiguous send is never blind-retried ───────────────────────
    describe('ambiguous send handling (item 2675)', function () {
        it('dead-letters an ambiguous send instead of re-queuing it for re-broadcast', async function () {
            let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
            let pub = new OraclePublisher(makeHub());
            let timeout = new Error('socket hang up'); timeout.code = 'ETIMEDOUT';
            let broadcastStub = sinon.stub().rejects(timeout);
            pub.broadcastFn  = broadcastStub;
            pub.getBalanceFn = sinon.stub().resolves(50);
            let dead = sinon.stub(pub, '_deadLetter');
            await pub._processQueue();
            expect(broadcastStub.calledOnce).to.be.true;
            expect(dead.calledOnce, 'ambiguous send must be dead-lettered').to.be.true;
            // the round must NOT remain on the live queue (no auto re-broadcast)
            let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
            expect(rewritten).to.not.include('"round":9');
        });

        it('still retries a definitive (never-sent) error normally', async function () {
            let entry = { round: 9, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 };
            fsMock.readFileSync.returns(JSON.stringify(entry) + '\n');
            let pub = new OraclePublisher(makeHub());
            let refused = new Error('connect ECONNREFUSED'); refused.code = 'ECONNREFUSED';
            pub.broadcastFn  = sinon.stub().rejects(refused);
            pub.getBalanceFn = sinon.stub().resolves(50);
            let dead = sinon.stub(pub, '_deadLetter');
            await pub._processQueue();
            expect(dead.called, 'definitive error must not dead-letter').to.be.false;
            // round retained with attempts incremented
            let rewritten = fsMock.writeSync.getCall(fsMock.writeSync.callCount - 1).args[1];
            expect(rewritten).to.include('"round":9');
        });
    });

    // ── snapshot dark-path logging (item 2391) ─────────────────────────────────
    describe('capability-snapshot dark logging (item 2391)', function () {
        it('logs a warn when the snapshot resolves to null (silent dark path)', async function () {
            let warn = sinon.stub(console, 'warn');
            let capSS = { getSnapshot: sinon.stub().resolves(null) };
            let pub = new OraclePublisher(makeHub({ capabilitySnapshot: capSS }));
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.deep.equal([]);          // fail-closed unchanged
            expect(warn.called).to.be.true;
            expect(pub._snapshotDark).to.be.true;
        });

        it('logs a warn when the snapshot call throws', async function () {
            let warn = sinon.stub(console, 'warn');
            let capSS = { getSnapshot: sinon.stub().rejects(new Error('indexer down')) };
            let pub = new OraclePublisher(makeHub({ capabilitySnapshot: capSS }));
            await pub._getActiveOraclePublishPubkeys(100);
            expect(warn.calledWithMatch(/indexer down/)).to.be.true;
        });

        it('is transition-only: a persistent fault logs once, then resets on recovery', async function () {
            let warn = sinon.stub(console, 'warn');
            let capSS = { getSnapshot: sinon.stub().resolves(null) };
            let pub = new OraclePublisher(makeHub({ capabilitySnapshot: capSS }));
            await pub._getActiveOraclePublishPubkeys(100);
            await pub._getActiveOraclePublishPubkeys(100);
            expect(warn.callCount).to.equal(1);       // second dark round is quiet
            // Recovery clears the guard so a subsequent dark spell logs again.
            capSS.getSnapshot.resolves({ validators: [{ pubkey: 'aa'.repeat(32) }] });
            await pub._getActiveOraclePublishPubkeys(100);
            expect(pub._snapshotDark).to.be.false;
            capSS.getSnapshot.resolves(null);
            await pub._getActiveOraclePublishPubkeys(100);
            expect(warn.callCount).to.equal(2);
        });
    });

    // ── oversized-wire drop observability (item 2402) ──────────────────────────
    describe('oversized PRICE v0 wire drop (item 2402)', function () {
        function bigPrices() {
            // Enough pairs to push the encoded wire past PRICE_WIRE_MAX_BYTES (8189).
            let out = [];
            for (let i = 0; i < 800; i++) out.push({ coinPair: 'PAIR' + i + '/USD', price: '123456' });
            return out;
        }

        it('counts the drop, dead-letters it, and does not enqueue', async function () {
            sinon.stub(console, 'error');
            let pub = new OraclePublisher(makeHub());
            sinon.stub(pub, '_getMyRank').resolves(0);
            sinon.stub(pub, '_getActiveOraclePublishCount').resolves(3);
            let enqueueSpy = sinon.spy(pub, '_enqueue');
            let dead = sinon.stub(pub, '_deadLetter');
            await pub.onRoundFinalized({ round: 3, btcBlockHeight: 100, btcBlockTime: 0,
                prices: bigPrices(), signatures: [{ pubkey: 'pk', sig: 'sig' }] });
            expect(pub.oversizedDrops).to.equal(1);
            expect(dead.calledOnce).to.be.true;
            expect(dead.firstCall.args[0]).to.include({ round: 3 });
            expect(dead.firstCall.args[1]).to.match(/exceeds encoder limit/);
            expect(enqueueSpy.called).to.be.false;
        });

        it('surfaces oversizedDrops via getStats()', function () {
            let pub = new OraclePublisher(makeHub());
            pub.oversizedDrops = 2;
            expect(pub.getStats().oversizedDrops).to.equal(2);
        });
    });

    // ── oracle_published_rounds retention (XC-1364) ────────────────────────────
    // The durable marker table gained one row per published round and never lost
    // one, so a money-bearing broadcast path grew a table without bound. Retention
    // may only ever touch CONFIRMED rows: a sent_at NULL row is the quarantine
    // marker for a round whose on-chain state is unknown and which an operator
    // reconciles by hand, and no round still on the publish queue may be pruned
    // (the marker is what stops a restart re-broadcasting it).
    describe('oracle_published_rounds retention (XC-1364)', function () {

        const ENV_KEY = 'ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS';

        afterEach(function () {
            delete process.env[ENV_KEY];
        });

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

            let deleted = await pub._prunePublishedRounds(1000);   // cutoff 900

            expect(deleted).to.equal(2);                    // only the confirmed rounds 10 and 12
            expect(db.markers[10]).to.be.undefined;
            expect(db.markers[12]).to.be.undefined;
            expect(db.markers[11], 'quarantined intent-only row must survive forever').to.not.be.undefined;
            expect(db.markers[99000], 'row inside the window must survive').to.not.be.undefined;
            expect(pub.publishedRoundsPruned).to.equal(2);
        });

        it('issues a DELETE that carries the sent_at IS NOT NULL filter', async function () {
            let db  = makeDb(seedMarkers());
            let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));

            await pub._prunePublishedRounds(1000);

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
            expect(await off._prunePublishedRounds(1000000)).to.equal(0);
            expect(dbOff.doQuery.called).to.be.false;

            let noDb = new OraclePublisher(makeHub({ p2pConfig: { [ENV_KEY]: '10' } }));
            expect(await noDb._prunePublishedRounds(1000000)).to.equal(0);

            // Young chain: the window has not been filled yet, so nothing is old enough.
            let dbYoung = makeDb(seedMarkers());
            let young   = new OraclePublisher(makeHub({ db: dbYoung, p2pConfig: { [ENV_KEY]: '12960' } }));
            expect(await young._prunePublishedRounds(50)).to.equal(0);
            expect(dbYoung.doQuery.called).to.be.false;
        });

        it('never prunes a marker for a round still sitting on the durable queue', async function () {
            // Round 10 is beyond the retention window but has NOT drained off the
            // queue. Pruning its marker would let a restart re-broadcast it and spend
            // DOGE twice, so the cutoff clamps below it.
            fsMock.readFileSync.returns(
                JSON.stringify({ round: 10, btcBlockTime: 0, prices: [], sigs: [], attempts: 0 }) + '\n');
            let db  = makeDb(seedMarkers());
            let pub = new OraclePublisher(makeHub({ db: db, p2pConfig: { [ENV_KEY]: '100' } }));

            let deleted = await pub._prunePublishedRounds(1000);

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
});
