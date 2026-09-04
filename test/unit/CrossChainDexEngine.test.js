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
const { createMockHub } = require('../helpers/mockHub');
const eq             = require('../../src/equivocation_header.js');
const ccr            = require('../../src/cross_chain_royalty_activation.js');

// Warm the mathjs/bcmath require cache once, OUTSIDE any timed hook (mathjs is large and the
// first load on the Parallels share can exceed a 5s hook timeout).
require('mathjs');
require('../../src/bcmath.js');

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

// A minimal SWAP offer (no `kind` → swap path).
// give_decimals is the give-side decimal grid the offer's HOME indexer reports
// (getopencrosschainorders). The ORDER path quantizes its derived fills
// on it and DECLINES the match when it is absent, so every offer fixture carries it,
// exactly as a real book page does.
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
        give_decimals: 8,
        block_index:   10,
        ...(overrides || {})
    };
}

// A matching SWAP pair (BTC offer ↔ LTC offer), exact amounts.
function makePair() {
    let a = makeOffer({
        action_index: 1, home_coin: 'BTC', give_coin: 'BTC', give_tick: 'XCH', give_amount: '100',
        get_coin: 'LTC', get_tick: 'XCH', get_amount: '500', get_address: 'ltc1abc'
    });
    let b = makeOffer({
        action_index: 2, home_coin: 'LTC', give_coin: 'LTC', give_tick: 'XCH', give_amount: '500',
        get_coin: 'BTC', get_tick: 'XCH', get_amount: '100', get_address: 'bc1xyz'
    });
    return { a, b };
}

// A crossing ORDER pair where B is smaller, so A partially fills.
//   A (LTC): give 100 LTCT, get 50 DOGT   (0.5 DOGT per LTCT)
//   B (DOGE): give 20 DOGT, get 40 LTCT   (same price; smaller)
// Expected fill: B gives 20 DOGT / gets 40 LTCT; A gives 40 LTCT / gets 20 DOGT.
function makeOrderPair() {
    let a = {
        kind: 'order', action_index: 1, home_coin: 'LTC', home_network: 'regtest', block_index: 10,
        give_coin: 'LTC', give_tick: 'LTCT', give_amount: '100', give_ownership: 0,
        get_coin: 'DOGE', get_tick: 'DOGT', get_amount: '50', get_ownership: 0, get_address: 'Laddr',
        give_decimals: 8
    };
    let b = {
        kind: 'order', action_index: 7, home_coin: 'DOGE', home_network: 'regtest', block_index: 20,
        give_coin: 'DOGE', give_tick: 'DOGT', give_amount: '20', give_ownership: 0,
        get_coin: 'LTC', get_tick: 'LTCT', get_amount: '40', get_ownership: 0, get_address: 'Daddr',
        give_decimals: 8
    };
    return { a, b };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('CrossChainDexEngine', function () {

    beforeEach(function () {
        loadModule();
        delete process.env.XDEX_POLL_MS;
        delete process.env.XDEX_SNAPSHOT_BLOCK;
        delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('initialises the committed ledger as an empty Map', function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            expect(eng.committed).to.be.instanceOf(Map);
            expect(eng.committed.size).to.equal(0);
            expect(eng._inflight).to.be.instanceOf(Set);
        });

        it('reads per-coin indexer URLs from config', function () {
            let eng = new CrossChainDexEngine(makeDexHub({ p2pConfig: { BTC_INDEXER_URL: 'http://btc/rpc' } }));
            expect(eng.indexers.BTC.url).to.equal('http://btc/rpc');
        });

        it('falls back to DEFAULT_POLL_MS when config is absent', function () {
            expect(new CrossChainDexEngine(makeDexHub()).pollMs).to.equal(15000);
        });

        it('reads XDEX_POLL_MS from env', function () {
            process.env.XDEX_POLL_MS = '3000';
            expect(new CrossChainDexEngine(makeDexHub()).pollMs).to.equal(3000);
        });
    });

    // ── _rebuildCommitted / committed ledger ─────────────────────────────────

    describe('_rebuildCommitted()', function () {
        it('sums finalized-match fills into both legs', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([
                { a_chain: 'DOGE', a_action_index: 7, a_amount: '20', b_chain: 'LTC', b_action_index: 1, b_amount: '40' }
            ]);
            let eng = new CrossChainDexEngine(hub);
            await eng._rebuildCommitted();
            // DOGE:7 gave 20 / received 40 ; LTC:1 gave 40 / received 20
            expect(eng.committed.get('DOGE:7')).to.deep.equal({ give: '20', get: '40' });
            expect(eng.committed.get('LTC:1')).to.deep.equal({ give: '40', get: '20' });
        });

        it('handles DB error without throwing (table may not exist)', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().rejects(new Error('no such table'));
            let eng = new CrossChainDexEngine(hub);
            await eng._rebuildCommitted(); // must not throw
        });
    });

    describe('_effectiveRemaining()', function () {
        it('returns full amounts when nothing is committed', function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a } = makeOrderPair();
            let r = eng._effectiveRemaining(a);
            expect(r.give).to.equal('100');
            expect(r.get).to.equal('50');
        });

        it('subtracts committed fills and never goes below zero', function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a } = makeOrderPair();
            eng.committed.set('LTC:1', { give: '40', get: '20' });
            let r = eng._effectiveRemaining(a);
            expect(r.give).to.equal('60');
            expect(r.get).to.equal('30');
        });

        it('treats an ownership side as a unit (amount 1)', function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let off = { home_coin: 'LTC', action_index: 9, give_ownership: 1, give_amount: '1', get_amount: '5', get_ownership: 0 };
            expect(eng._effectiveRemaining(off).give).to.equal('1');
        });
    });

    // ── _findMatches (SWAP path, Phase A behaviour preserved) ─────────────────

    describe('_findMatches(): SWAP', function () {
        let eng;
        before(function () { loadModule(); eng = new CrossChainDexEngine(makeDexHub()); });

        it('finds a valid exact pair', function () {
            let { a, b } = makePair();
            let m = eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] });
            expect(m).to.have.length(1);
            expect(m[0].loKind).to.equal('swap');
        });

        it('returns empty when no matching pairs exist', function () {
            let a = makeOffer({ give_amount: '100', get_amount: '500' });
            let b = makeOffer({ home_coin: 'LTC', give_amount: '999', get_amount: '1' });
            expect(eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] })).to.have.length(0);
        });

        it('does not match the same offer twice in a round', function () {
            let { a, b } = makePair();
            expect(eng._findMatches({ BTC: [a, a], LTC: [b, b], DOGE: [] }).length).to.be.at.most(1);
        });

        it('orders the pair canonically (lo.home_coin <= hi.home_coin)', function () {
            let { a, b } = makePair();
            let m = eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] });
            expect(m[0].lo.home_coin <= m[0].hi.home_coin).to.be.true;
        });

        it('skips a swap already fully committed', function () {
            let { a, b } = makePair();
            eng.committed.set('BTC:1', { give: '100', get: '500' });  // a fully matched
            expect(eng._findMatches({ BTC: [a], LTC: [b], DOGE: [] })).to.have.length(0);
            eng.committed.clear();
        });
    });

    // ── _findMatches / _tryOrderMatch (ORDER path, partial fills) ─────────────

    describe('_tryOrderMatch(): partial fills', function () {
        let eng;
        beforeEach(function () { eng = new CrossChainDexEngine(makeDexHub()); });

        it('produces the bottleneck-clamped fill (smaller side fully filled)', function () {
            let { a, b } = makeOrderPair();
            let d = eng._tryMatch(a, b);
            expect(d).to.not.be.null;
            expect(d.loKind).to.equal('order');
            // lo = DOGE (canonical-lower) gives 20 DOGT, hi = LTC gives 40 LTCT
            expect(d.lo.home_coin).to.equal('DOGE');
            expect(d.loFill).to.equal('20');
            expect(d.hiFill).to.equal('40');
            expect(d.loFilledBefore).to.equal('0');
            expect(d.hiFilledBefore).to.equal('0');
        });

        it('advances filled_before on a sequential fill and yields a distinct match_id', function () {
            let { a, b } = makeOrderPair();
            let d1 = eng._tryMatch(a, b);
            // simulate finalize: commit d1's fill to the ledger
            eng._applyCommit({ a_chain: d1.lo.home_coin, a_action_index: d1.lo.action_index, a_amount: d1.loFill,
                               b_chain: d1.hi.home_coin, b_action_index: d1.hi.action_index, b_amount: d1.hiFill }, +1);
            // a second DOGE order fills more of A
            let c = Object.assign({}, b, { action_index: 9, block_index: 21, get_address: 'Daddr2' });
            let d2 = eng._tryMatch(a, c);
            expect(d2.hiFilledBefore).to.equal('40');   // A already filled 40 LTCT
            let id1 = eng._deriveMatchId(d1.lo, d1.hi, 100, d1.loFilledBefore, d1.hiFilledBefore);
            let id2 = eng._deriveMatchId(d2.lo, d2.hi, 100, d2.loFilledBefore, d2.hiFilledBefore);
            expect(id1).to.not.equal(id2);
        });

        it('applies the price-cross guard exactly as the local matcher (order_match.js:118)', function () {
            // maker = A (earlier): GET_PRICE = give/get = 100/50 = 2. taker = B (later).
            // The guard skips when maker.GET_PRICE > taker.GIVE_PRICE. With B wanting 30 LTCT
            // for 20 DOGT, taker.GIVE_PRICE = get/give = 30/20 = 1.5 < 2 → skipped (null).
            let { a, b } = makeOrderPair();
            b.get_amount = '30';
            expect(eng._tryMatch(a, b)).to.be.null;
            // At the boundary (equal price, makeOrderPair's 40 → GIVE_PRICE 2) it matches.
            let { a: a2, b: b2 } = makeOrderPair();
            expect(eng._tryMatch(a2, b2)).to.not.be.null;
        });

        it('does not over-fill once an order is fully committed', function () {
            let { a, b } = makeOrderPair();
            eng.committed.set('LTC:1', { give: '100', get: '50' });  // A fully filled
            expect(eng._tryMatch(a, b)).to.be.null;
        });

        it('does not cross-match a SWAP against an ORDER (carry-forward): kind, not terms, is the bar', function () {
            // ORDER on LTC: give 100 LTCT, get 50 DOGT (makeOrderPair's A, home_network 'regtest').
            let { a: order } = makeOrderPair();
            // A DOGE counterparty with terms that DO cross the order (identical to makeOrderPair's B,
            // which test 237 proves matches as order×order). CRITICAL: it must share the order's
            // network (otherwise _tryMatch short-circuits on the network guard (line 245) and a null
            // would be a FALSE proof (the carry-forward branch at line 258 never runs).
            let terms = { home_coin: 'DOGE', home_network: 'regtest', block_index: 20, action_index: 7,
                give_coin: 'DOGE', give_tick: 'DOGT', give_amount: '20',
                get_coin: 'LTC', get_tick: 'LTCT', get_amount: '40', get_address: 'Daddr',
                give_ownership: 0, get_ownership: 0,
                // Required for the order×order control to reach the fill math at all: the
                // ORDER path declines a match whose give-side grid it cannot establish.
                give_decimals: 8 };
            let swap  = Object.assign({}, terms, { kind: 'swap' });
            let ordr2 = Object.assign({}, terms, { kind: 'order' });

            // SWAP↔ORDER carries forward in BOTH orderings (the only difference from the controls is kind).
            expect(eng._tryMatch(order, swap), 'order×swap should carry forward').to.be.null;
            expect(eng._tryMatch(swap, order), 'swap×order should carry forward').to.be.null;

            // Positive controls: the SAME crossing terms DO match when both sides are the same kind,
            // proving the null above is the SWAP↔ORDER boundary, not term incompatibility or the
            // network guard. order×order fills; swap×swap (an exact same-network pair) finalises.
            expect(eng._tryMatch(order, ordr2), 'order×order control should match').to.not.be.null;
            let { a: swapA, b: swapB } = makePair();
            expect(eng._tryMatch(swapA, swapB), 'swap×swap control should match').to.not.be.null;
        });
    });

    // ── _deriveMatchId ───────────────────────────────────────────────────────

    describe('_deriveMatchId()', function () {
        let eng;
        before(function () { loadModule(); eng = new CrossChainDexEngine(makeDexHub()); });

        it('produces a 64-hex string', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100, '0', '0')).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic for the same inputs', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100, '0', '0')).to.equal(eng._deriveMatchId(a, b, 100, '0', '0'));
        });

        it('differs when snapshot block changes', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100, '0', '0')).to.not.equal(eng._deriveMatchId(a, b, 101, '0', '0'));
        });

        it('differs when a filled-before offset changes (sequential fills)', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100, '0', '0')).to.not.equal(eng._deriveMatchId(a, b, 100, '40', '0'));
        });

        it('treats 0 and 0.00000000 offsets as the same id', function () {
            let { a, b } = makePair();
            expect(eng._deriveMatchId(a, b, 100, '0', '0')).to.equal(eng._deriveMatchId(a, b, 100, '0.00000000', '0'));
        });

        it('differs for different networks at same block (no collision)', function () {
            let { a: a1, b: b1 } = makePair();
            let { a: a2, b: b2 } = makePair();
            a2.home_network = 'testnet'; b2.home_network = 'testnet';
            expect(eng._deriveMatchId(a1, b1, 100, '0', '0')).to.not.equal(eng._deriveMatchId(a2, b2, 100, '0', '0'));
        });
    });

    // ── _canonicalMatch (byte-lockstep with the indexer verifier) ─────────────

    describe('_canonicalMatch()', function () {
        let eng;
        before(function () { loadModule(); eng = new CrossChainDexEngine(makeDexHub()); });

        function sampleRow() {
            return {
                match_id: 'abc', snapshot_block: 100, network: 'regtest',
                a_chain: 'DOGE', a_action_index: 7, a_kind: 'order', a_tick: 'DOGT', a_amount: '20', a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Laddr',
                b_chain: 'LTC', b_action_index: 1, b_kind: 'order', b_tick: 'LTCT', b_amount: '40', b_filled_before: '40', b_ownership: 0, b_payout_addr: 'Daddr',
                effective_time: 1700000000
            };
        }

        // The indexer's cross_settle._canonical is kept here byte-for-byte so a drift breaks CI.
        // EQUIV active in regtest (WI-2 bump 2): TAG=XDEX, ROUND_ID=match_id, VIEW=finalizing_view (default 0).
        function indexerCanonical(m) {
            let raw = [
                'XMATCH', m.match_id, String(m.snapshot_block),
                m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
                m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
                String(m.effective_time), m.network || '',
                m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
                m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
            ].join('|');
            // Royalty legs ride the signed match at/above CROSS_CHAIN_ROYALTY (regtest genesis).
            if (ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
                raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
            if (eq.isEquivHeaderActive(m.snapshot_block, m.network))
                return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
            return raw;
        }

        it('wraps the XMATCH content in the EQUIV header and appends the fill + royalty fields after network', function () {
            let canon = eng._canonicalMatch(sampleRow());
            expect(canon).to.match(/^EQUIV\|XDEX\|abc\|0\|\|XMATCH\|/);   // gated (regtest); header then content
            expect(canon.endsWith('|regtest|order|0|order|40||')).to.be.true;   // trailing '||' = empty royalty legs
        });

        it('byte-matches the indexer cross_settle._canonical', function () {
            let row = sampleRow();
            expect(eng._canonicalMatch(row)).to.equal(indexerCanonical(row));
        });

        it('signs non-null royalty legs into the canonical bytes (strip changes the bytes)', function () {
            let row = sampleRow();
            row.a_payout_legs = JSON.stringify([{ to: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM', bps: 500 }]);
            expect(eng._canonicalMatch(row)).to.equal(indexerCanonical(row));
            expect(eng._canonicalMatch(row)).to.not.equal(eng._canonicalMatch(sampleRow()));
        });

        it('defaults kind/filled_before for a legacy (swap) row', function () {
            let row = sampleRow();
            delete row.a_kind; delete row.a_filled_before; delete row.b_kind; delete row.b_filled_before;
            expect(eng._canonicalMatch(row)).to.equal(indexerCanonical(row));
            expect(eng._canonicalMatch(row).endsWith('|swap|0|swap|0||')).to.be.true;
        });
    });

    // ── _normalizeAmount / _amountsEqual / _isExactMatch (unchanged) ──────────

    describe('_normalizeAmount() / _amountsEqual()', function () {
        let eng;
        before(function () { loadModule(); eng = new CrossChainDexEngine(makeDexHub()); });

        it('strips leading and trailing zeros', function () {
            expect(eng._normalizeAmount('007.50')).to.equal('7.5');
            expect(eng._normalizeAmount('100.00000000')).to.equal('100');
        });
        it('treats null / empty as empty', function () {
            expect(eng._normalizeAmount(null)).to.equal('');
            expect(eng._normalizeAmount('')).to.equal('');
        });
        it('treats 100 and 100.00000000 as equal', function () {
            expect(eng._amountsEqual('100', '100.00000000')).to.be.true;
        });
        it('returns false for unequal amounts', function () {
            expect(eng._amountsEqual('100', '101')).to.be.false;
        });
    });

    describe('_isExactMatch()', function () {
        let eng;
        before(function () { loadModule(); eng = new CrossChainDexEngine(makeDexHub()); });

        it('returns true for a valid cross-chain exact match', function () {
            let { a, b } = makePair();
            expect(eng._isExactMatch(a, b)).to.be.true;
        });
        it('returns false on same chain / differing network / non-mirrored amounts', function () {
            let { a, b } = makePair();
            expect(eng._isExactMatch(a, makeOffer({ home_coin: 'BTC', action_index: 2 }))).to.be.false;
            let p2 = makePair(); p2.b.home_network = 'testnet';
            expect(eng._isExactMatch(p2.a, p2.b)).to.be.false;
            let p3 = makePair(); p3.b.give_amount = '999';
            expect(eng._isExactMatch(p3.a, p3.b)).to.be.false;
        });
    });

    // ── validateProposedMatch ─────────────────────────────────────────────────

    describe('validateProposedMatch()', function () {
        // Build the row _finalizeMatch would produce for an ORDER pair.
        function orderRow(eng, a, b, block) {
            let d = eng._tryMatch(a, b);
            return {
                match_id:       eng._deriveMatchId(d.lo, d.hi, block, d.loFilledBefore, d.hiFilledBefore),
                snapshot_block: block, network: d.network,
                a_chain: d.lo.home_coin, a_action_index: d.lo.action_index, a_kind: d.loKind, a_tick: d.lo.give_tick,
                a_amount: d.loFill, a_filled_before: d.loFilledBefore, a_ownership: d.lo.give_ownership, a_payout_addr: d.lo.get_address,
                a_payout_legs: d.lo.payout_legs || null,
                b_chain: d.hi.home_coin, b_action_index: d.hi.action_index, b_kind: d.hiKind, b_tick: d.hi.give_tick,
                b_amount: d.hiFill, b_filled_before: d.hiFilledBefore, b_ownership: d.hi.give_ownership, b_payout_addr: d.hi.get_address,
                b_payout_legs: d.hi.payout_legs || null,
                // Honest leaders stamp _nowSeconds() plus a forward propagation margin sized to
                // the slower leg; validateProposedMatch bounds it ASYMMETRICALLY against the
                // follower's clock. A far-future stamp would lock both escrows, and a stamp at
                // or behind now would make the match settleable before it had reached both
                // chains' indexers (#4202). So: the engine's own clock plus a margin, never a
                // fixed timestamp.
                effective_time: eng._nowSeconds() + 600
            };
        }

        it('returns true when the fill re-derives identically', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.true;
        });

        it('returns false when a leg is no longer open', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : null);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the proposed fill amount differs from our re-derivation', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            row.a_amount = '19';   // tampered fill
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the proposed match_id is tampered', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            row.match_id = 'f'.repeat(64);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        // Cross-chain royalty legs: the canonical is built from the PROPOSED row, so the
        // follower must confirm the row's legs against its own indexer's view of each order.
        const LEGS = JSON.stringify([{ to: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM', bps: 500 }]);

        it('returns true when the proposed royalty legs match our own view', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            a.payout_legs = LEGS;
            let row = orderRow(eng, a, b, 100);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.true;
        });

        it('returns false when the leader STRIPS the royalty legs', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            a.payout_legs = LEGS;
            let row = orderRow(eng, a, b, 100);
            // a is home_coin LTC → canonical-HIGHER vs DOGE ('DOGE' < 'LTC'), so a's legs
            // ride the B side of the row
            row.b_payout_legs = null;
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the leader REWRITES the royalty legs', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            a.payout_legs = LEGS;
            let row = orderRow(eng, a, b, 100);
            row.b_payout_legs = JSON.stringify([{ to: 'attacker', bps: 500 }]);
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the row claims legs our own view does not have', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            row.b_payout_legs = LEGS;
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the leader stamps a far-future effective_time (escrow-lock griefing, XDEX-ETIME-1)', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            // Everything else re-derives identically; only the leader's effective_time is
            // pushed far into the future. Without the bound the follower would sign it and
            // the finalized match would never settle, locking both escrows.
            row.effective_time = eng._nowSeconds() + 30 * 24 * 3600;   // +30 days
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when effective_time is non-numeric', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);
            row.effective_time = 'not-a-time';
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        // #4202, the other half of the effective_time bound. The window used to be
        // symmetric, so a match stamped AT the leader's clock second passed. Such a match
        // is settleable on both legs the moment it is mirrored, so the indexer that
        // already holds the row settles a block ahead of one still receiving it and the
        // two legs' settlement action indexes diverge. _finalizeMatch stamped exactly
        // that (bare _nowSeconds()) before this fix, so the guard and the producer
        // margin land together.
        it('returns false when the match is effective on arrival (no propagation window)', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            for (const delta of [0, -30, 5]) {
                let row = orderRow(eng, a, b, 100);
                row.effective_time = eng._nowSeconds() + delta;
                expect(await eng.validateProposedMatch(row),
                    'co-signed a match effective at now' + (delta >= 0 ? '+' : '') + delta).to.be.false;
            }
        });

        it('_finalizeMatch stamps a forward margin sized to the slower leg, never the bare clock second', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(100);
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 1 });
            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = 100;
            eng._seedLocalValidator = true;
            sinon.stub(eng, '_persistCapabilitySnapshot').resolves(1);
            let proposed = null;
            sinon.stub(eng.consensus, 'propose').callsFake(async (id, payload) => { proposed = payload.row; });

            let { a, b } = makeOrderPair();
            const now = eng._nowSeconds();
            let desc = eng._tryMatch(a, b);
            await eng._finalizeMatch(desc);
            expect(proposed, 'no row was proposed').to.not.equal(null);
            // 4 blocks of the SLOWER leg: both chains must hold the mirrored row before
            // either reaches its eligible block.
            const NOMINAL = { BTC: 600, LTC: 150, DOGE: 60 };
            const want = Math.min(3000, 4 * Math.max(NOMINAL[desc.lo.home_coin], NOMINAL[desc.hi.home_coin]));
            expect(want, 'fixture pair carries no margin to assert').to.be.greaterThan(0);
            expect(proposed.effective_time - now).to.equal(want);
        });

        // #4204. The indexer's settlement pass rebuilds the signed canonical from the
        // mirrored BIGINT row, so a leader-supplied '041' for an action index passes
        // every Number()-based re-derivation here yet finalizes a match no settling
        // indexer can verify - leaving both escrows locked with nothing to retry.
        it('returns false for a noncanonical integer spelling on a signed field', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);

            // The canonical spelling of the same value, as a number or a string, passes.
            let ok = orderRow(eng, a, b, 100);
            ok.a_action_index = String(Number(ok.a_action_index));
            expect(await eng.validateProposedMatch(ok)).to.be.true;

            for (const field of ['a_action_index', 'b_action_index', 'snapshot_block', 'effective_time']) {
                let row = orderRow(eng, a, b, 100);
                row[field] = '0' + String(Number(row[field]));
                expect(await eng.validateProposedMatch(row),
                    'signed a match with a leading-zero ' + field).to.be.false;
            }
            let nulled = orderRow(eng, a, b, 100);
            nulled.a_ownership = null;   // signs the literal 'null', persists as 0
            expect(await eng.validateProposedMatch(nulled)).to.be.false;
        });

        // ── XDEX-GEN-FORGE-1: the per-leg source-reorg fence (a_/b_push_generation) is not
        // in the signed canonical or match_id, so a follower must re-derive it from its own
        // offer view or a Byzantine leader can stamp an inflated generation no honest
        // retraction can ever fence (a match on a rolled-back order that is never retracted).
        it('returns true when the proposed push_generation matches our own offer view', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            // a=LTC (row b-leg / desc.hi), b=DOGE (row a-leg / desc.lo) since 'DOGE' < 'LTC'.
            b.push_generation = 3; a.push_generation = 5;
            let row = orderRow(eng, a, b, 100);
            row.a_push_generation = 3; row.b_push_generation = 5;
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.true;
        });

        it('returns false when the leader inflates a_push_generation (forged reorg fence)', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            b.push_generation = 3; a.push_generation = 5;
            let row = orderRow(eng, a, b, 100);
            // Everything re-derives identically; only the fence is inflated to a value no
            // honest retraction_generation can reach, escaping retraction forever.
            row.a_push_generation = 9007199254740992;   // 2^53
            row.b_push_generation = 5;
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('returns false when the leader inflates b_push_generation', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            b.push_generation = 3; a.push_generation = 5;
            let row = orderRow(eng, a, b, 100);
            row.a_push_generation = 3;
            row.b_push_generation = 42;                 // does not match a.push_generation (5)
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.false;
        });

        it('treats absent generations as 0 on both sides (legacy indexer parity)', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let { a, b } = makeOrderPair();
            let row = orderRow(eng, a, b, 100);   // no push_generation set anywhere → 0 === 0
            sinon.stub(eng, '_findOpenOffer').callsFake(async (coin) => coin === 'DOGE' ? b : a);
            expect(await eng.validateProposedMatch(row)).to.be.true;
        });
    });

    // ── retractMatchesForReorg ────────────────────────────────────────────────

    describe('retractMatchesForReorg()', function () {
        it('marks rows retracted and restores committed capacity', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.onFirstCall().resolves([
                { match_id: 'mid1', a_chain: 'DOGE', a_action_index: 7, a_amount: '20', b_chain: 'LTC', b_action_index: 1, b_amount: '40' }
            ]);
            hub.db.doQuery.resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng._applyCommit({ a_chain: 'DOGE', a_action_index: 7, a_amount: '20', b_chain: 'LTC', b_action_index: 1, b_amount: '40' }, +1);
            await eng.retractMatchesForReorg('DOGE', 7);
            expect(eng.committed.get('LTC:1')).to.deep.equal({ give: '0', get: '0' });
            expect(eng.committed.get('DOGE:7')).to.deep.equal({ give: '0', get: '0' });
        });

        it('broadcasts deletion when broadcaster is available', async function () {
            let broadcaster = { broadcastDeletion: sinon.stub(), broadcastRow: sinon.stub() };
            let hub = makeDexHub({ hubDbBroadcaster: broadcaster });
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.onFirstCall().resolves([
                { match_id: 'mid1', a_chain: 'BTC', a_action_index: 5, a_amount: '1', b_chain: 'LTC', b_action_index: 8, b_amount: '2' }
            ]);
            hub.db.doQuery.resolves([]);
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

        it('bounds both legs to a closed range and carries to_action_index on the broadcast (item 5296)', async function () {
            let broadcaster = { broadcastDeletion: sinon.stub(), broadcastRow: sinon.stub() };
            let hub = makeDexHub({ hubDbBroadcaster: broadcaster });
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.onFirstCall().resolves([
                { match_id: 'mid1', a_chain: 'BTC', a_action_index: 5, a_amount: '1', b_chain: 'LTC', b_action_index: 8, b_amount: '2' }
            ]);
            hub.db.doQuery.resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng.broadcaster = broadcaster;

            await eng.retractMatchesForReorg('BTC', 5, 75);

            // The SELECT must carry the bound on BOTH legs with the ceiling param.
            let selectCall = hub.db.doQuery.getCall(0);
            expect(selectCall.args[0]).to.match(/a_action_index >= \? AND a_action_index <= \?/);
            expect(selectCall.args[0]).to.match(/b_action_index >= \? AND b_action_index <= \?/);
            expect(selectCall.args[1]).to.deep.equal(['BTC', 5, 75, 'BTC', 5, 75]);
            expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include(
                { table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 5, to_action_index: 75 });
        });

        it('gen-fences each leg by its OWN generation column and carries retraction_generation (item 5308)', async function () {
            let broadcaster = { broadcastDeletion: sinon.stub(), broadcastRow: sinon.stub() };
            let hub = makeDexHub({ hubDbBroadcaster: broadcaster });
            hub.db.doQuery = sinon.stub();
            hub.db.doQuery.onFirstCall().resolves([
                { match_id: 'mid1', a_chain: 'BTC', a_action_index: 5, a_amount: '1', b_chain: 'LTC', b_action_index: 8, b_amount: '2' }
            ]);
            hub.db.doQuery.resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng.broadcaster = broadcaster;

            await eng.retractMatchesForReorg('BTC', 5, 75, 9);

            // Per-leg fence: a-leg uses a_push_generation, b-leg uses b_push_generation.
            let selectCall = hub.db.doQuery.getCall(0);
            expect(selectCall.args[0]).to.match(/a_action_index <= \? AND a_push_generation <= \?/);
            expect(selectCall.args[0]).to.match(/b_action_index <= \? AND b_push_generation <= \?/);
            // params: [chain, from, to, gen] per leg, concatenated for the two legs.
            expect(selectCall.args[1]).to.deep.equal(['BTC', 5, 75, 9, 'BTC', 5, 75, 9]);
            expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include(
                { table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 5, to_action_index: 75, retraction_generation: 9 });
        });

        // a supplied-but-malformed bound must ABORT before the SELECT. Fail-open
        // here widened a fenced rollback into an open-ended retraction that also restored
        // capacity via _applyCommit(-1) and broadcast the widened event to peers.
        it('aborts on a supplied-but-malformed bound instead of widening the retraction', async function () {
            for (const args of [['BTC', 'abc'], ['BTC', 5, 'abc'], ['BTC', 5, 75, 'abc'], ['BTC', 5, 1]]) {
                let broadcaster = { broadcastDeletion: sinon.stub(), broadcastRow: sinon.stub() };
                let hub = makeDexHub({ hubDbBroadcaster: broadcaster });
                hub.db.doQuery = sinon.stub().resolves([]);
                let eng = new CrossChainDexEngine(hub);
                eng.broadcaster = broadcaster;
                let threw = false;
                try { await eng.retractMatchesForReorg(...args); } catch (e) { threw = /^invalid /.test(e.message); }
                expect(threw).to.equal(true, 'expected abort for ' + JSON.stringify(args));
                expect(hub.db.doQuery.called).to.equal(false);
                expect(broadcaster.broadcastDeletion.called).to.equal(false);
            }
        });

        // The absent-bound contract (older indexers omit to/generation) must survive the guard.
        it('still treats an ABSENT bound as open-ended and unfenced', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            await eng.retractMatchesForReorg('BTC', 5, null, undefined);
            let selectCall = hub.db.doQuery.getCall(0);
            expect(selectCall.args[0]).to.not.match(/<= \?/);
            expect(selectCall.args[1]).to.deep.equal(['BTC', 5, 'BTC', 5]);
        });
    });

    // ── _resolveCapabilityValidators ─────────────────────────────────────────

    describe('_resolveCapabilityValidators()', function () {
        it('returns snapshot validators when capSnapshot provides them', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng.capSnapshot = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'p1', amount: '9' }] }) };
            let v = await eng._resolveCapabilityValidators('cross_chain', 100);
            expect(v).to.have.length(1);
            expect(v[0].pubkey).to.equal('p1');
        });

        it('seeds this hub\'s pubkey when no snapshot and _seedLocalValidator=true', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng.capSnapshot = null; eng._seedLocalValidator = true;
            let v = await eng._resolveCapabilityValidators('cross_chain', 100);
            expect(v).to.have.length(1);
            expect(v[0].pubkey).to.equal(eng.identity.getPubkeyHex());
        });

        it('returns empty when no snapshot and _seedLocalValidator=false', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng.capSnapshot = null; eng._seedLocalValidator = false;
            expect(await eng._resolveCapabilityValidators('cross_chain', 100)).to.have.length(0);
        });
    });

    // ── _resolveSnapshotBlock ────────────────────────────────────────────────

    describe('_resolveSnapshotBlock()', function () {
        it('delegates to hub._resolveBtcLatestBlock', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(500);
            expect(await new CrossChainDexEngine(hub)._resolveSnapshotBlock()).to.equal(500);
        });

        it('falls back to XDEX_SNAPSHOT_BLOCK override when BTC tip is null', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = 42;
            expect(await eng._resolveSnapshotBlock()).to.equal(42);
        });

        it('returns null when no BTC tip and no override', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = NaN;
            expect(await eng._resolveSnapshotBlock()).to.be.null;
        });
    });

    // ── _persistCapabilitySnapshot ────────────────────────────────────────────

    describe('_persistCapabilitySnapshot()', function () {
        it('inserts rows from capability snapshot validators', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng.capSnapshot = { getSnapshot: sinon.stub().resolves({ validators: [{ pubkey: 'pub1', amount: '50000' }] }) };
            await eng._persistCapabilitySnapshot('cross_chain', 100);
            expect(hub.db.doQuery.calledWith(sinon.match(/INSERT IGNORE INTO capability_snapshots/))).to.be.true;
        });

        it('_writeFinalizedMatch persists the snapshot on EVERY hub, not just the leader', async function () {
            // Bug-C analog: indexers verify match signatures against
            // capability_snapshots in whichever hub DB they mirror, and a
            // follower's DB may be the only one they read (leader-only
            // persistence (quorum-0 inline + _broadcastPropose) left follower
            // DBs without it.
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 1 });
            let eng = new CrossChainDexEngine(hub);
            let persist = sinon.stub(eng, '_persistCapabilitySnapshot').resolves(1);
            let row = {
                match_id: 'm'.repeat(64), snapshot_block: 150, network: 'regtest',
                a_chain: 'LTC', a_action_index: 1, a_kind: 'swap', a_tick: 'XCH', a_amount: '100',
                a_filled_before: '0', a_ownership: 0, a_payout_addr: 'La',
                b_chain: 'DOGE', b_action_index: 2, b_kind: 'swap', b_tick: 'XCH', b_amount: '500',
                b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Db',
                effective_time: 1700000000
            };
            await eng._writeFinalizedMatch({ row, signatures: [{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }] });
            expect(persist.calledWith('cross_chain', 150)).to.be.true;
        });

        it('does nothing when no validators and _seedLocalValidator=false', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            eng._seedLocalValidator = false;
            eng.capSnapshot = { getSnapshot: sinon.stub().resolves({ validators: [] }) };
            let n = await eng._persistCapabilitySnapshot('cross_chain', 100);
            expect(hub.db.doQuery.called).to.be.false;
            expect(n).to.equal(0);
        });

        // SWQ-TRUNC-MIRROR. The .truncated marker is a JS array property and
        // capability_snapshots has no column for it, so mirroring a capped set hands the
        // off-BTC verifiers a partial stake denominator they read back as COMPLETE and
        // finalize against, while this hub's own meetsStakeThreshold rejects it. Persist
        // must fail closed instead: no rows, no mirror stream, and the 0 return that the
        // _writeFinalizedMatch caller already treats as "defer this match".
        it('refuses to persist or mirror a TRUNCATED set', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            let capped = [{ pubkey: 'pub1', source: 'srcA', weight: '50000', amount: '50000' }];
            capped.truncated = true;
            sinon.stub(eng, '_resolveCapabilityValidators').resolves(capped);

            let n = await eng._persistCapabilitySnapshot('cross_chain', 100);
            expect(n, 'zero rows is the caller\'s fail-closed signal').to.equal(0);
            expect(hub.db.doQuery.called, 'no capability_snapshots row may be written').to.be.false;
        });

        it('still persists an untruncated set (the guard is not a blanket refusal)', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves([]);
            let eng = new CrossChainDexEngine(hub);
            let full = [{ pubkey: 'pub1', source: 'srcA', weight: '50000', amount: '50000' }];
            full.truncated = false;
            sinon.stub(eng, '_resolveCapabilityValidators').resolves(full);

            let n = await eng._persistCapabilitySnapshot('cross_chain', 100);
            expect(n).to.equal(1);
            expect(hub.db.doQuery.calledWith(sinon.match(/INSERT IGNORE INTO capability_snapshots/))).to.be.true;
        });
    });

    // ── item 2385: _writeFinalizedMatch must fail closed on a snapshot-persist
    // failure so no finalized/mirrored/ledger-applied match can outlive a snapshot
    // its signatures cannot be verified against. ────────────────────────────────
    describe('_writeFinalizedMatch(): fail-closed snapshot persist', function () {
        function finalizeRow() {
            return {
                match_id: 'f'.repeat(64), snapshot_block: 150, network: 'regtest',
                a_chain: 'LTC', a_action_index: 1, a_kind: 'swap', a_tick: 'XCH', a_amount: '100',
                a_filled_before: '0', a_ownership: 0, a_payout_addr: 'La',
                b_chain: 'DOGE', b_action_index: 2, b_kind: 'swap', b_tick: 'XCH', b_amount: '500',
                b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Db',
                effective_time: 1700000000
            };
        }

        it('skips insert/commit and defers when the snapshot persist throws', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 1 });
            let eng = new CrossChainDexEngine(hub);
            sinon.stub(eng, '_persistCapabilitySnapshot').rejects(new Error('db down'));
            let insert  = sinon.stub(eng, '_insertMatchRow').resolves(true);
            let commit  = sinon.stub(eng, '_applyCommit');
            let forget  = sinon.stub(eng.consensus, 'forgetFinalized');
            let row = finalizeRow();
            eng._inflight.add(row.match_id);

            await eng._writeFinalizedMatch({ row, signatures: [{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }] });

            expect(insert.called, 'must NOT insert the match row').to.be.false;
            expect(commit.called, 'must NOT apply the committed-ledger fill').to.be.false;
            expect(forget.calledWith(row.match_id), 'must forget the finalized id for re-propose').to.be.true;
            expect(eng._inflight.has(row.match_id), 'must clear the in-flight reservation').to.be.false;
        });

        it('skips insert/commit and defers when the snapshot persist writes zero rows', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 1 });
            let eng = new CrossChainDexEngine(hub);
            // Degraded/null snapshot => zero validators resolved => zero rows persisted.
            sinon.stub(eng, '_persistCapabilitySnapshot').resolves(0);
            let insert  = sinon.stub(eng, '_insertMatchRow').resolves(true);
            let commit  = sinon.stub(eng, '_applyCommit');
            let forget  = sinon.stub(eng.consensus, 'forgetFinalized');
            let row = finalizeRow();
            eng._inflight.add(row.match_id);

            await eng._writeFinalizedMatch({ row, signatures: [{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }] });

            expect(insert.called, 'must NOT insert the match row').to.be.false;
            expect(commit.called, 'must NOT apply the committed-ledger fill').to.be.false;
            expect(forget.calledWith(row.match_id), 'must forget the finalized id for re-propose').to.be.true;
            expect(eng._inflight.has(row.match_id)).to.be.false;
        });

        it('inserts + commits when the snapshot persisted at least one row', async function () {
            let hub = makeDexHub();
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 1 });
            let eng = new CrossChainDexEngine(hub);
            sinon.stub(eng, '_persistCapabilitySnapshot').resolves(3);
            let insert  = sinon.stub(eng, '_insertMatchRow').resolves(true);
            let commit  = sinon.stub(eng, '_applyCommit');
            let row = finalizeRow();
            eng._inflight.add(row.match_id);

            await eng._writeFinalizedMatch({ row, signatures: [{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }] });

            expect(insert.calledOnce, 'must insert the match row').to.be.true;
            expect(commit.calledWith(row, +1), 'must apply the committed-ledger fill').to.be.true;
        });
    });

    // ── XDEX-MINCONF-BYPASS-1: the discovery/leader path (and the single-node fast path
    // that never calls the follower check) must enforce the confirmation-depth floor too. ──
    describe('_discoverAndMatch(): confirmation-depth floor', function () {
        it('drops offers shallower than minConfirmations on the discovery path', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng.minConfirmations = { BTC: 6, LTC: 6, DOGE: 6 }; // per-coin map
            eng.indexers.BTC.url = 'http://btc';   // pass the per-coin URL guard
            // latest tip 20: block 11 is 10 deep (kept), block 19 is 2 deep (dropped at floor 6).
            sinon.stub(eng, '_indexerCall').resolves({
                network: 'regtest', latest_block_index: 20,
                orders: [ { action_index: 1, block_index: 11 }, { action_index: 2, block_index: 19 } ]
            });
            let captured;
            sinon.stub(eng, '_findMatches').callsFake((obc) => { captured = obc; return []; });
            await eng._discoverAndMatch();
            let seen = (captured.BTC || []).map(o => o.action_index);
            expect(seen).to.include(1);
            expect(seen).to.not.include(2);
        });

        it('keeps every offer at an explicit floor of 1 (regtest-style venue pin)', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng.minConfirmations = { BTC: 1, LTC: 1, DOGE: 1 }; // XDEX_MIN_CONFIRMATIONS=1 venue pin (defaults are now per-coin 6/12/60)
            eng.indexers.BTC.url = 'http://btc';
            sinon.stub(eng, '_indexerCall').resolves({
                network: 'regtest', latest_block_index: 20,
                orders: [ { action_index: 1, block_index: 20 }, { action_index: 2, block_index: 11 } ]
            });
            let captured;
            sinon.stub(eng, '_findMatches').callsFake((obc) => { captured = obc; return []; });
            await eng._discoverAndMatch();
            expect((captured.BTC || []).map(o => o.action_index)).to.have.members([1, 2]);
        });
    });

    // ── XCC-2: the discovery path must page the whole open book via the keyset cursor,
    // not a one-shot limit:500, or a chain with >500 open cross-chain offers silently
    // drops the newest (never discovered, never matched). ──
    describe('_fetchOpenOffers(): keyset cursor paging (XCC-2)', function () {
        it('follows next_cursor across truncated pages and accumulates the full book', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let call = sinon.stub(eng, '_indexerCall');
            // Page 1: truncated, next_cursor 2. Page 2: truncated, next_cursor 4. Page 3: tail.
            call.onCall(0).resolves({ network: 'regtest', latest_block_index: 100, truncated: true,  next_cursor: 2,
                                      orders: [{ action_index: 1, block_index: 1 }, { action_index: 2, block_index: 1 }] });
            call.onCall(1).resolves({ network: 'regtest', latest_block_index: 101, truncated: true,  next_cursor: 4,
                                      orders: [{ action_index: 3, block_index: 1 }, { action_index: 4, block_index: 1 }] });
            call.onCall(2).resolves({ network: 'regtest', latest_block_index: 102, truncated: false, next_cursor: 5,
                                      orders: [{ action_index: 5, block_index: 1 }] });
            let res = await eng._fetchOpenOffers('BTC', { limit: 2 });
            expect(res.orders.map(o => o.action_index)).to.deep.equal([1, 2, 3, 4, 5]);
            // network + latest pinned to the FIRST page for a consistent confirmation-depth tip.
            expect(res.network).to.equal('regtest');
            expect(res.latest_block_index).to.equal(100);
            expect(call.callCount).to.equal(3);
            // The cursor is threaded from each page's next_cursor.
            expect(call.getCall(1).args[2]).to.deep.equal({ limit: 2, after_action_index: 2 });
            expect(call.getCall(2).args[2]).to.deep.equal({ limit: 2, after_action_index: 4 });
        });

        it('makes a single call when the first page is not truncated (backward compatible)', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let call = sinon.stub(eng, '_indexerCall').resolves({
                network: 'regtest', latest_block_index: 20,
                orders: [{ action_index: 1, block_index: 11 }]   // no `truncated` field = pre-XCC-2 indexer
            });
            let res = await eng._fetchOpenOffers('BTC', { limit: 500 });
            expect(call.callCount).to.equal(1);
            expect(res.orders.map(o => o.action_index)).to.deep.equal([1]);
        });

        it('falls back to the batch max action_index when the indexer omits next_cursor', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            let call = sinon.stub(eng, '_indexerCall');
            call.onCall(0).resolves({ network: 'regtest', latest_block_index: 9, truncated: true,
                                      orders: [{ action_index: 3, block_index: 1 }, { action_index: 8, block_index: 1 }] });
            call.onCall(1).resolves({ network: 'regtest', latest_block_index: 9, truncated: false,
                                      orders: [{ action_index: 12, block_index: 1 }] });
            let res = await eng._fetchOpenOffers('BTC', { limit: 2 });
            expect(res.orders.map(o => o.action_index)).to.deep.equal([3, 8, 12]);
            expect(call.getCall(1).args[2]).to.deep.equal({ limit: 2, after_action_index: 8 });
        });

        it('breaks (never spins) when a truncated page fails to advance the cursor', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            // Always truncated with a non-advancing cursor: the guard must stop after page 2.
            let call = sinon.stub(eng, '_indexerCall').resolves({
                network: 'regtest', latest_block_index: 5, truncated: true, next_cursor: 4,
                orders: [{ action_index: 4, block_index: 1 }]
            });
            let res = await eng._fetchOpenOffers('BTC', { limit: 1 });
            // page 0 sets after=4; page 1 returns next_cursor 4 (<= 4) → break. Two calls, no spin.
            expect(call.callCount).to.equal(2);
            expect(res.orders.length).to.be.greaterThan(0);
        });

        it('_discoverAndMatch pages the book and matches an offer beyond the first page', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng.minConfirmations = { BTC: 1, LTC: 1, DOGE: 1 };
            eng.indexers.BTC.url = 'http://btc';
            let call = sinon.stub(eng, '_indexerCall');
            call.onCall(0).resolves({ network: 'regtest', latest_block_index: 50, truncated: true, next_cursor: 1,
                                      orders: [{ action_index: 1, block_index: 10 }] });
            call.onCall(1).resolves({ network: 'regtest', latest_block_index: 55, truncated: false, next_cursor: 2,
                                      orders: [{ action_index: 2, block_index: 10 }] });
            let captured;
            sinon.stub(eng, '_findMatches').callsFake((obc) => { captured = obc; return []; });
            await eng._discoverAndMatch();
            // Both pages' offers reach the matcher; the confirmation-depth tip is the first page's.
            expect((captured.BTC || []).map(o => o.action_index)).to.have.members([1, 2]);
        });
    });

    // ── The confirmation floor is per-coin, defaulting to the chain-registry
    // attestation depths the sibling CrossChainCallEngine already uses. ──
    describe('minConfirmations per-coin resolution', function () {
        const CLEAR = ['XDEX_MIN_CONFIRMATIONS', 'XDEX_MIN_CONFIRMATIONS_BTC', 'XDEX_MIN_CONFIRMATIONS_DOGE'];
        let saved = {};
        beforeEach(function () { for (let k of CLEAR) { saved[k] = process.env[k]; delete process.env[k]; } });
        afterEach(function () { for (let k of CLEAR) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; } });

        it('defaults to the per-chain registry depths (BTC 6 / LTC 12 / DOGE 60)', function () {
            const coins = require('../../src/coins');
            let eng = new CrossChainDexEngine(makeDexHub());
            expect(eng.minConfirmations.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
            expect(eng.minConfirmations.LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
            expect(eng.minConfirmations.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
        });

        it('flat XDEX_MIN_CONFIRMATIONS pins every coin (regtest venue knob)', function () {
            process.env.XDEX_MIN_CONFIRMATIONS = '1';
            let eng = new CrossChainDexEngine(makeDexHub());
            expect(eng.minConfirmations).to.deep.equal({ BTC: 1, LTC: 1, DOGE: 1 });
        });

        it('per-coin XDEX_MIN_CONFIRMATIONS_<COIN> beats the flat knob', function () {
            process.env.XDEX_MIN_CONFIRMATIONS = '1';
            process.env.XDEX_MIN_CONFIRMATIONS_DOGE = '30';
            let eng = new CrossChainDexEngine(makeDexHub());
            expect(eng.minConfirmations.DOGE).to.equal(30);
            expect(eng.minConfirmations.BTC).to.equal(1);
        });

        // XDEX-CONF-1 / CF-1: an override may only RAISE the depth on mainnet and testnet,
        // because a lowered one lets this hub co-sign an escrow the federation calls reorg-able.
        for (const net of ['mainnet', 'testnet']) {
            it('clamps a lowered override back up to the per-coin floor on ' + net, function () {
                const coins = require('../../src/coins');
                process.env.XDEX_MIN_CONFIRMATIONS = '1';
                process.env.XDEX_MIN_CONFIRMATIONS_DOGE = '2';
                let hub = makeDexHub();
                hub.network = net;
                let warn = sinon.stub(console, 'warn');
                let eng;
                try { eng = new CrossChainDexEngine(hub); } finally { warn.restore(); }
                expect(eng.minConfirmations.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
                expect(eng.minConfirmations.LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
                expect(eng.minConfirmations.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
                expect(warn.callCount).to.equal(3);
            });

            it('still honours an override that RAISES the depth on ' + net, function () {
                const coins = require('../../src/coins');
                process.env.XDEX_MIN_CONFIRMATIONS_BTC = String(coins.DEFAULT_CONFIRMATIONS.BTC + 5);
                let hub = makeDexHub();
                hub.network = net;
                let eng = new CrossChainDexEngine(hub);
                expect(eng.minConfirmations.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC + 5);
            });
        }

        it('leaves the regtest venue pin of 1 untouched', function () {
            process.env.XDEX_MIN_CONFIRMATIONS = '1';
            let hub = makeDexHub();
            hub.network = 'regtest';
            let eng = new CrossChainDexEngine(hub);
            expect(eng.minConfirmations).to.deep.equal({ BTC: 1, LTC: 1, DOGE: 1 });
        });
    });

    // ── XDEX-REFORM-STRAND-1: a crossing retracted then re-formed at the same snapshot_block
    // re-derives the same (unique) match_id, so INSERT IGNORE would strand it on the stale
    // 'retracted' row; _insertMatchRow revives it, without ever double-counting a real dup. ──
    describe('_insertMatchRow(): retracted-row revive', function () {
        const reviveRow = () => ({
            match_id: 'm'.repeat(64), validator_signatures: '[]', finalizing_view: 0, effective_time: 1700000000,
            a_chain: 'DOGE', a_action_index: 7, a_kind: 'order', a_tick: 'DOGT', a_amount: '20', a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Da', a_payout_legs: null,
            b_chain: 'LTC', b_action_index: 1, b_kind: 'order', b_tick: 'LTCT', b_amount: '40', b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Lb', b_payout_legs: null,
            a_push_generation: 0, b_push_generation: 0
        });

        it('revives a retracted row to finalized when INSERT IGNORE no-ops', async function () {
            let hub = makeDexHub();
            let q = sinon.stub();
            q.onCall(0).resolves({ affectedRows: 0 });   // INSERT IGNORE hits the retained retracted row
            q.onCall(1).resolves({ affectedRows: 1 });   // UPDATE ... WHERE status='retracted' revives it
            q.resolves([]);                              // broadcast re-read
            hub.db.doQuery = q;
            let eng = new CrossChainDexEngine(hub);
            let inserted = await eng._insertMatchRow(reviveRow());
            expect(inserted).to.be.true;
            let updateSql = q.getCall(1).args[0];
            expect(updateSql).to.match(/UPDATE cross_chain_matches SET status = 'finalized'/);
            expect(updateSql).to.match(/status = 'retracted'/);
        });

        it('stays a no-op when the existing row is already finalized (no double-count)', async function () {
            let hub = makeDexHub();
            let q = sinon.stub();
            q.onCall(0).resolves({ affectedRows: 0 });   // genuine duplicate finalize
            q.onCall(1).resolves({ affectedRows: 0 });   // revive matches nothing (row is 'finalized', not 'retracted')
            q.resolves([]);
            hub.db.doQuery = q;
            let eng = new CrossChainDexEngine(hub);
            let inserted = await eng._insertMatchRow(reviveRow());
            expect(inserted).to.be.false;
        });
    });

    // ── stop() ────────────────────────────────────────────────────────────────

    describe('stop()', function () {
        it('clears the poll timer and stops consensus', async function () {
            let eng = new CrossChainDexEngine(makeDexHub());
            eng._pollTimer = setTimeout(() => {}, 100000);
            let stopSpy = sinon.stub(eng.consensus, 'stop').resolves();
            await eng.stop();
            expect(eng._pollTimer).to.be.null;
            expect(stopSpy.calledOnce).to.be.true;
        });
    });

    // ── EventEmitter ──────────────────────────────────────────────────────────

    describe('EventEmitter', function () {
        it('emits match:finalized when a match is inserted', async function () {
            let hub = makeDexHub();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(100);
            // _insertMatchRow reads affectedRows then re-reads the row; consensus single-node finalizes inline.
            hub.db.doQuery = sinon.stub().resolves({ affectedRows: 1 });
            let eng = new CrossChainDexEngine(hub);
            eng._snapshotBlockOverride = 100;
            eng._seedLocalValidator = true;
            sinon.stub(eng, '_persistCapabilitySnapshot').resolves(1);

            let { a, b } = makeOrderPair();
            let desc = eng._tryMatch(a, b);

            let emitted = false;
            eng.on('match:finalized', () => { emitted = true; });
            await eng._finalizeMatch(desc);
            await new Promise(r => setImmediate(r));
            expect(emitted).to.be.true;
        });
    });

    // ── L4 determinism: match canonicalization (spec §6) ──────────────────────
    // Two hubs must derive a byte-identical canonical (→ match_id / settlement
    // digest) for the same cross-chain match, or settlement forks. _canonicalMatch
    // reads fields by name and String()-coerces, so its output must be invariant
    // to object key order and field value TYPE, and stable for absent optional
    // fields. "Same input → same output" holds regardless of the equiv-header
    // branch, so these are independent of the concurrently-evolving equiv path.
    describe('L4 determinism: match canonicalization', function () {
        const baseMatch = () => ({
            match_id: 'm1', snapshot_block: 800000, network: 'mainnet',
            a_chain: 'BTC', a_action_index: 5, a_tick: 'XCH', a_amount: '100', a_ownership: 0, a_payout_addr: 'bc1a', a_kind: 'swap', a_filled_before: '0',
            b_chain: 'LTC', b_action_index: 9, b_tick: 'XCH', b_amount: '500', b_ownership: 0, b_payout_addr: 'ltc1b', b_kind: 'swap', b_filled_before: '0',
            effective_time: 1700000000
        });

        it('two independent engines produce the identical canonical for the same match', function () {
            const e1 = new CrossChainDexEngine(makeDexHub());
            const e2 = new CrossChainDexEngine(makeDexHub());
            expect(e1._canonicalMatch(baseMatch(), 0)).to.equal(e2._canonicalMatch(baseMatch(), 0));
        });

        it('is invariant to object key order', function () {
            const eng = new CrossChainDexEngine(makeDexHub());
            const r = baseMatch();
            const shuffled = {};
            for (const k of Object.keys(r).reverse()) shuffled[k] = r[k];
            expect(eng._canonicalMatch(shuffled, 0)).to.equal(eng._canonicalMatch(r, 0));
        });

        it('is invariant to numeric field TYPE (String-coerced)', function () {
            const eng = new CrossChainDexEngine(makeDexHub());
            const v1 = { ...baseMatch(), a_action_index: 5,   a_amount: '100', snapshot_block: 800000 };
            const v2 = { ...baseMatch(), a_action_index: '5', a_amount: 100,   snapshot_block: '800000' };
            expect(eng._canonicalMatch(v1, 0)).to.equal(eng._canonicalMatch(v2, 0));
        });

        it('treats an absent optional tick as empty consistently (null vs undefined)', function () {
            const eng = new CrossChainDexEngine(makeDexHub());
            const withNull  = { ...baseMatch(), a_tick: null };
            const withUndef = { ...baseMatch() }; delete withUndef.a_tick;
            expect(eng._canonicalMatch(withNull, 0)).to.equal(eng._canonicalMatch(withUndef, 0));
        });
    });
});
