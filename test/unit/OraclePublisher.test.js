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
            let wire = pub.buildPriceV0Wire(42, 1700000000, prices, sigs);
            let parts = wire.split('|');
            expect(parts[0]).to.equal('PRICE');
            expect(parts[1]).to.equal('0');
            expect(parts[2]).to.equal('42');
            expect(parts[3]).to.equal('1700000000');
            expect(parts[4]).to.equal('2');  // price count
            expect(parts[5]).to.equal('BTC/USD');
            expect(parts[6]).to.equal('100000');
            expect(parts[7]).to.equal('LTC/USD');
            expect(parts[8]).to.equal('80');
            expect(parts[9]).to.equal('1');  // sig count
            expect(parts[10]).to.equal('pk1');
            expect(parts[11]).to.equal('sig1');
        });

        it('handles no signatures gracefully', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let wire = pub.buildPriceV0Wire(1, 0, [{ coinPair: 'BTC/USD', price: '100' }], []);
            expect(wire).to.match(/^PRICE\|0\|1\|0\|1\|BTC\/USD\|100\|0$/);
        });

        it('uses `pair` property as fallback when `coinPair` is absent', function () {
            let hub = makeHub();
            let pub = new OraclePublisher(hub);
            let wire = pub.buildPriceV0Wire(1, 0, [{ pair: 'BTC/USD', price: '100' }], []);
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
            let payload = JSON.parse(pub._buildSignablePayload(42, 1700000000, prices));
            expect(payload.round).to.equal(42);
            expect(payload.timestamp).to.equal(1700000000);
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

        it('falls back to capability registry when snapshot fails', async function () {
            let capSS = { getSnapshot: sinon.stub().rejects(new Error('indexer down')) };
            let capReg = { getActiveValidators: sinon.stub().resolves(['AA'.repeat(32)]) };
            let hub = makeHub({ capabilitySnapshot: capSS, capabilityRegistry: capReg });
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.include('aa'.repeat(32));
        });

        it('falls back to capability registry when snapshot returns no validators', async function () {
            let capSS = { getSnapshot: sinon.stub().resolves(null) };
            let capReg = { getActiveValidators: sinon.stub().resolves(['pk1']) };
            let hub = makeHub({ capabilitySnapshot: capSS, capabilityRegistry: capReg });
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.include('pk1');
        });

        it('returns empty array when registry fails', async function () {
            let capReg = { getActiveValidators: sinon.stub().rejects(new Error('db down')) };
            let hub = makeHub({ capabilityRegistry: capReg });
            let pub = new OraclePublisher(hub);
            let keys = await pub._getActiveOraclePublishPubkeys(100);
            expect(keys).to.deep.equal([]);
        });

        it('returns empty array when no snapshot and no registry', async function () {
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
            await pub.start(); // best-effort — must not throw
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
});
