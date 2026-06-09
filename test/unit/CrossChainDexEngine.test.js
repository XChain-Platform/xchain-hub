'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const EventEmitter   = require('events');
const { createMockHub } = require('../helpers/mockHub');

// ────────────────────────────────────────────────────────────────────────────
// Load with axios stubbed
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let CrossChainDexEngine;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    CrossChainDexEngine = proxyquire('../../src/CrossChainDexEngine', { axios: axiosStub });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeDexHub(overrides) {
    let hub = createMockHub(overrides);
    hub.db = {
        doQuery: sinon.stub().resolves([]),
        ...(overrides && overrides.db ? overrides.db : {})
    };
    hub.hubDbBroadcaster = overrides && overrides.hubDbBroadcaster !== undefined
        ? overrides.hubDbBroadcaster : null;
    hub.capabilitySnapshot = overrides && overrides.capabilitySnapshot !== undefined
        ? overrides.capabilitySnapshot : null;
    return hub;
}

// A minimal offer object for matching tests
function makeOffer(overrides) {
    return {
        action_index:  1,
        home_coin:     'BTC',
        home_network:  'mainnet',
        give_coin:     'BTC',
        give_tick:     'XCH',
        give_amount:   '100',
        get_coin:      'LTC',
        get_tick:      'XCH',
        get_amount:    '500',
        get_address:   'ltc1abc',
        give_ownership: 0,
        get_ownership:  0,
        ...(overrides || {})
    };
}

// A matching pair (BTC offer ↔ LTC offer)
function makePair() {
    let a = makeOffer({
        action_index:  1,
        home_coin:     'BTC',
        home_network:  'mainnet',
        give_coin:     'BTC',
        give_tick:     'XCH',
        give_amount:   '100',
        get_coin:      'LTC',
        get_tick:      'XCH',
        get_amount:    '500',
        get_address:   'ltc1abc'
    });
    let b = makeOffer({
        action_index:  2,
        home_coin:     'LTC',
        home_network:  'mainnet',
        give_coin:     'LTC',
        give_tick:     'XCH',
        give_amount:   '500',
        get_coin:      'BTC',
        get_tick:      'XCH',
        get_amount:    '100',
        get_address:   'bc1xyz'
    });
    return { a, b };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('CrossChainDexEngine', function () {

    beforeEach(function () {
        loadModule();
        // Remove env overrides that could interfere with tests
        delete process.env.XDEX_POLL_MS;
        delete process.env.XDEX_SNAPSHOT_BLOCK;
        delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('initialises matchedOffers as an empty Set', function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            expect(eng.matchedOffers).to.be.instanceOf(Set);
            expect(eng.matchedOffers.size).to.equal(0);
        });

        it('reads per-coin indexer URLs from config', function () {
            let hub = makeDexHub({ p2pConfig: { BTC_INDEXER_URL: 'http://btc/rpc' } });
            let eng = new CrossChainDexEngine(hub);
            expect(eng.indexers.BTC.url).to.equal('http://btc/rpc');
        });

        it('falls back to DEFAULT_POLL_MS when config is absent', function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            expect(eng.pollMs).to.equal(15000);
        });

        it('reads XDEX_POLL_MS from env', function () {
            process.env.XDEX_POLL_MS = '3000';
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            expect(eng.pollMs).to.equal(3000);
        });
    });

    // ── stop ────────────────────────────────────────────────────────────────

    describe('stop()', function () {
        it('clears the poll timer', async function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            eng._pollTimer = setTimeout(() => {}, 100000);
            await eng.stop();
            expect(eng._pollTimer).to.be.null;
        });

        it('stops the consensus engine', async function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            let stopSpy = sinon.stub(eng.consensus, 'stop').resolves();
            await eng.stop();
            expect(stopSpy.calledOnce).to.be.true;
        });
    });

    // ── _rebuildMatchedOffers ────────────────────────────────────────────────

    describe('_rebuildMatchedOffers()', function () {
        it('loads finalized matches and populates matchedOffers', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([
                { a_chain: 'BTC', a_action_index: 10, b_chain: 'LTC', b_action_index: 20 }
            ]);
            let eng = new CrossChainDexEngine(hub);
            await eng._rebuildMatchedOffers();
            expect(eng.matchedOffers.has('BTC:10')).to.be.true;
            expect(eng.matchedOffers.has('LTC:20')).to.be.true;
        });

        it('handles DB error without throwing (table may not exist)', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().rejects(new Error('no such table'));
            let eng = new CrossChainDexEngine(hub);
            await eng._rebuildMatchedOffers(); // must not throw
        });
    });

    // ── _normalizeAmount ─────────────────────────────────────────────────────

    describe('_normalizeAmount()', function () {
        let eng;
        before(function () {
            loadModule();
            eng = new CrossChainDexEngine(makeDexHub());
        });

        it('treats null / undefined / empty string as empty', function () {
            expect(eng._normalizeAmount(null)).to.equal('');
            expect(eng._normalizeAmount(undefined)).to.equal('');
            expect(eng._normalizeAmount('')).to.equal('');
        });

        it('strips leading and trailing zeros', function () {
            expect(eng._normalizeAmount('007.50')).to.equal('7.5');
            expect(eng._normalizeAmount('100.00000000')).to.equal('100');
        });

        it('handles integers without a decimal point', function () {
            expect(eng._normalizeAmount('42')).to.equal('42');
            expect(eng._normalizeAmount('0042')).to.equal('42');
        });

        it('handles pure zero', function () {
            expect(eng._normalizeAmount('0')).to.equal('0');
            expect(eng._normalizeAmount('0.000')).to.equal('0');
        });

        it('preserves significant digits', function () {
            expect(eng._normalizeAmount('0.00000001')).to.equal('0.00000001');
        });
    });

    // ── _amountsEqual ────────────────────────────────────────────────────────

    describe('_amountsEqual()', function () {
        let eng;
        before(function () {
            loadModule();
            eng = new CrossChainDexEngine(makeDexHub());
        });

        it('treats 100 and 100.00000000 as equal', function () {
            expect(eng._amountsEqual('100', '100.00000000')).to.be.true;
        });

        it('treats 0.5 and 0.50 as equal', function () {
            expect(eng._amountsEqual('0.5', '0.50')).to.be.true;
        });

        it('returns false for unequal amounts', function () {
            expect(eng._amountsEqual('100', '101')).to.be.false;
        });

        it('treats null as equal to null (ownership-only offers)', function () {
            expect(eng._amountsEqual(null, null)).to.be.true;
        });
    });

    // ── _isExactMatch ────────────────────────────────────────────────────────

    describe('_isExactMatch()', function () {
        let eng;
        before(function () {
            loadModule();
            eng = new CrossChainDexEngine(makeDexHub());
        });

        it('returns true for a valid cross-chain exact match', function () {
            let { a, b } = makePair();
            expect(eng._isExactMatch(a, b)).to.be.true;
        });

        it('returns false when both offers are on the same chain', function () {
            let a = makeOffer({ home_coin: 'BTC' });
            let b = makeOffer({ home_coin: 'BTC', action_index: 2 });
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('returns false when networks differ', function () {
            let { a, b } = makePair();
            b.home_network = 'testnet';
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('returns false when give_coin/get_coin do not mirror', function () {
            let { a, b } = makePair();
            b.give_coin = 'DOGE'; // mismatch
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('returns false when ticks do not mirror', function () {
            let { a, b } = makePair();
            b.give_tick = 'OTHER';
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('returns false when amounts do not mirror', function () {
            let { a, b } = makePair();
            b.give_amount = '999';
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('returns false when network is empty (never match across undefined networks)', function () {
            let { a, b } = makePair();
            a.home_network = '';
            b.home_network = '';
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('returns false when ownership flags do not mirror', function () {
            let { a, b } = makePair();
            a.give_ownership = 1; // a is giving ownership
            b.get_ownership  = 0; // b expects to receive normal (not ownership)
            expect(eng._isExactMatch(a, b)).to.be.false;
        });

        it('compares amounts by normalized value (100 == 100.00000000)', function () {
            let { a, b } = makePair();
            a.give_amount = '100.00000000';
            b.get_amount  = '100';
            expect(eng._isExactMatch(a, b)).to.be.true;
        });
    });

    // ── _findMatches ─────────────────────────────────────────────────────────

    describe('_findMatches()', function () {
        let eng;
        before(function () {
            loadModule();
            eng = new CrossChainDexEngine(makeDexHub());
        });

        it('finds a valid pair', function () {
            let { a, b } = makePair();
            let matches = eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] });
            expect(matches).to.have.length(1);
        });

        it('returns empty when no matching pairs exist', function () {
            let a = makeOffer({ give_amount: '100', get_amount: '500' });
            let b = makeOffer({ home_coin: 'LTC', give_amount: '999', get_amount: '1' });
            let matches = eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] });
            expect(matches).to.have.length(0);
        });

        it('does not match the same offer twice', function () {
            let { a, b } = makePair();
            // Two copies of the same pair → should only produce 1 match
            let matches = eng._findMatches({ BTC: [a, a], LTC: [b, b], DOGE: [] });
            expect(matches.length).to.be.at.most(1);
        });

        it('orders the pair canonically (a.home_coin <= b.home_coin)', function () {
            let { a, b } = makePair();
            let matches = eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] });
            expect(matches[0].a.home_coin <= matches[0].b.home_coin).to.be.true;
        });
    });

    // ── _deriveMatchId ───────────────────────────────────────────────────────

    describe('_deriveMatchId()', function () {
        let eng;
        before(function () {
            loadModule();
            eng = new CrossChainDexEngine(makeDexHub());
        });

        it('produces a 64-hex string', function () {
            let { a, b } = makePair();
            let id = eng._deriveMatchId(a, b, 100);
            expect(id).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic for the same inputs', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100)).to.equal(eng._deriveMatchId(a, b, 100));
        });

        it('differs when snapshot block changes', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100)).to.not.equal(eng._deriveMatchId(a, b, 101));
        });

        it('differs for different networks at same block (no collision)', function () {
            let { a: a1, b: b1 } = makePair();
            let { a: a2, b: b2 } = makePair();
            a1.home_network = 'mainnet'; b1.home_network = 'mainnet';
            a2.home_network = 'testnet'; b2.home_network = 'testnet';
            expect(eng._deriveMatchId(a1, b1, 100)).to.not.equal(eng._deriveMatchId(a2, b2, 100));
        });
    });

    // ── _canonicalMatch ───────────────────────────────────────────────────────

    describe('_canonicalMatch()', function () {
        let eng;
        before(function () {
            loadModule();
            eng = new CrossChainDexEngine(makeDexHub());
        });

        it('produces a pipe-separated string starting with XMATCH', function () {
            let row = {
                match_id: 'abc', snapshot_block: 100, network: 'mainnet',
                a_chain: 'BTC', a_action_index: 1, a_tick: 'XCH', a_amount: '100', a_ownership: 0, a_payout_addr: 'ltc1',
                b_chain: 'LTC', b_action_index: 2, b_tick: 'XCH', b_amount: '500', b_ownership: 0, b_payout_addr: 'bc1',
                effective_time: 1700000000
            };
            let canon = eng._canonicalMatch(row);
            expect(canon).to.match(/^XMATCH\|/);
            expect(canon.split('|').length).to.be.greaterThan(10);
        });

        it('is deterministic for the same row', function () {
            let row = {
                match_id: 'abc', snapshot_block: 100, network: 'mainnet',
                a_chain: 'BTC', a_action_index: 1, a_tick: null, a_amount: '100', a_ownership: 0, a_payout_addr: 'ltc1',
                b_chain: 'LTC', b_action_index: 2, b_tick: null, b_amount: '500', b_ownership: 0, b_payout_addr: 'bc1',
                effective_time: 1700000000
            };
            expect(eng._canonicalMatch(row)).to.equal(eng._canonicalMatch(row));
        });
    });

    // ── _resolveCapabilityValidators ─────────────────────────────────────────

    describe('_resolveCapabilityValidators()', function () {
        it('returns snapshot validators when capSnapshot provides them', async function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            eng.capSnapshot = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'p1', amount: '9' }] }) };
            let v = await eng._resolveCapabilityValidators('cross_chain', 100);
            expect(v).to.have.length(1);
            expect(v[0].pubkey).to.equal('p1');
        });

        it('seeds this hub\'s pubkey when no snapshot and _seedLocalValidator=true', async function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            eng.capSnapshot = null;
            eng._seedLocalValidator = true;
            let v = await eng._resolveCapabilityValidators('cross_chain', 100);
            expect(v).to.have.length(1);
            expect(v[0].pubkey).to.equal(eng.identity.getPubkeyHex());
        });

        it('returns empty when no snapshot and _seedLocalValidator=false', async function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            eng.capSnapshot = null;
            eng._seedLocalValidator = false;
            let v = await eng._resolveCapabilityValidators('cross_chain', 100);
            expect(v).to.have.length(0);
        });
    });

    // ── validateProposedMatch (independent re-derivation a peer runs pre-sign) ─

    describe('validateProposedMatch()', function () {
        // Build the row _finalizeMatch would produce for a makePair() at a block.
        function rowFor(eng, a, b, block) {
            let lo = (a.home_coin <= b.home_coin) ? a : b;
            let hi = (lo === a) ? b : a;
            return {
                match_id:       eng._deriveMatchId(lo, hi, block),
                snapshot_block: block, network: lo.home_network,
                a_chain: lo.home_coin, a_action_index: lo.action_index, a_tick: lo.give_tick,
                a_amount: lo.give_amount, a_ownership: lo.give_ownership, a_payout_addr: lo.get_address,
                b_chain: hi.home_coin, b_action_index: hi.action_index, b_tick: hi.give_tick,
                b_amount: hi.give_amount, b_ownership: hi.give_ownership, b_payout_addr: hi.get_address,
                effective_time: 1700000000
            };
        }

        it('returns true when both legs re-derive to the same match', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makePair();
            let row = rowFor(eng, a, b, 100);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'BTC' ? a : b);
            expect(await eng.validateProposedMatch(row)).to.be.true;
        });

        it('returns false when a leg is no longer open', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makePair();
            let row = rowFor(eng, a, b, 100);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'BTC' ? a : null);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the offers re-derive a different match_id', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makePair();
            let row = rowFor(eng, a, b, 100);
            row.match_id = 'f'.repeat(64);                  // tampered id
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'BTC' ? a : b);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });
    });

    // ── _resolveSnapshotBlock ────────────────────────────────────────────────

    describe('_resolveSnapshotBlock()', function () {
        it('delegates to hub._resolveBtcLatestBlock', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(500);
            let eng = new CrossChainDexEngine(hub);
            let b = await eng._resolveSnapshotBlock();
            expect(b).to.equal(500);
        });

        it('falls back to XDEX_SNAPSHOT_BLOCK override when BTC tip is null', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = 42;
            let b = await eng._resolveSnapshotBlock();
            expect(b).to.equal(42);
        });

        it('returns null when no BTC tip and no override', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = NaN;
            let b = await eng._resolveSnapshotBlock();
            expect(b).to.be.null;
        });
    });

    // ── retractMatchesForReorg ────────────────────────────────────────────────

    describe('retractMatchesForReorg()', function () {
        it('marks matching rows as retracted and clears matchedOffers', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub();
            // First call returns the affected rows
            hub.db.doQuery.onFirstCall().resolves([
                { match_id: 'mid1', a_chain: 'BTC', a_action_index: 10, b_chain: 'LTC', b_action_index: 20 }
            ]);
            hub.db.doQuery.onSecondCall().resolves([]);

            let eng = new CrossChainDexEngine(hub);
            eng.matchedOffers.add('BTC:10');
            eng.matchedOffers.add('LTC:20');

            await eng.retractMatchesForReorg('BTC', 10);

            expect(eng.matchedOffers.has('BTC:10')).to.be.false;
            expect(eng.matchedOffers.has('LTC:20')).to.be.false;
        });

        it('broadcasts deletion when broadcaster is available', async function () {
            let broadcaster = { broadcastDeletion: sinon.stub(), broadcastRow: sinon.stub() };
            let hub = makeDexHub({ hubDbBroadcaster: broadcaster });
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.onFirstCall().resolves([
                { match_id: 'mid1', a_chain: 'BTC', a_action_index: 5, b_chain: 'LTC', b_action_index: 8 }
            ]);
            hub.db.doQuery.onSecondCall().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng.broadcaster = broadcaster;
            await eng.retractMatchesForReorg('BTC', 5);
            expect(broadcaster.broadcastDeletion.calledOnce).to.be.true;
        });

        it('handles empty result set gracefully', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            await eng.retractMatchesForReorg('BTC', 999);
        });
    });

    // ── _persistCapabilitySnapshot ────────────────────────────────────────────

    describe('_persistCapabilitySnapshot()', function () {
        it('seeds local validator when no snapshot is available and _seedLocalValidator=true', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng._seedLocalValidator = true;
            eng.capSnapshot = null;
            await eng._persistCapabilitySnapshot('cross_chain', 100);
            // Should have called doQuery at least once (INSERT IGNORE)
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('does nothing when no validators and _seedLocalValidator=false', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng._seedLocalValidator = false;
            eng.capSnapshot = { getSnapshot: sinon.stub().resolves({ validators: [] }) };
            await eng._persistCapabilitySnapshot('cross_chain', 100);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('inserts rows from capability snapshot validators', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng.capSnapshot = {
                getSnapshot: sinon.stub().resolves({
                    validators: [{ pubkey: 'pub1', amount: '50000' }]
                })
            };
            await eng._persistCapabilitySnapshot('cross_chain', 100);
            expect(hub.db.doQuery.calledWith(sinon.match(/INSERT IGNORE INTO capability_snapshots/))).to.be.true;
        });
    });

    // ── _nowSeconds ──────────────────────────────────────────────────────────

    describe('_nowSeconds()', function () {
        it('returns a Unix timestamp in seconds (integer)', function () {
            let hub = makeDexHub();
            let eng = new CrossChainDexEngine(hub);
            let now = eng._nowSeconds();
            expect(Number.isInteger(now)).to.be.true;
            expect(now).to.be.closeTo(Math.floor(Date.now() / 1000), 2);
        });
    });

    // ── EventEmitter ──────────────────────────────────────────────────────────

    describe('EventEmitter', function () {
        it('emits match:finalized when a match is inserted', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(100);
            hub.db.doQuery = sinon.stub().resolves([{ id: 1 }]);

            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = 100;
            sinon.stub(eng, '_persistCapabilitySnapshot').resolves();

            let { a, b } = makePair();

            let emitted = false;
            eng.on('match:finalized', () => { emitted = true; });

            await eng._finalizeMatch(a, b);
            await new Promise(r => setImmediate(r));   // let the async match:finalized write run
            expect(emitted).to.be.true;
        });
    });
});
