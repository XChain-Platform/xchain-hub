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
// The cross-chain ORDER book either side of order_match_price_cross_activation, the
// row the indexer's local matcher reads for the same test. The taker (later offer)
// sells AAA for BBB; the maker (earlier offer) pays at most 10 BBB per AAA:
//   P1: the taker asks 15 BBB per AAA: no cross.
//   P2: the taker asks 5 BBB per AAA: crosses.
//   P3: the taker asks 10 BBB per AAA: equal limits.
// Below the height (or with no snapshot block) the legacy test stands and matches P1
// but not P2; from it P1 is refused and P2 matches at the taker's ratio, inside the
// maker's limit. The leader judges the era at its resolved snapshot block and the
// follower at the proposed row's snapshot_block.

const assert     = require('assert');
const sinon      = require('sinon');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../../../../helpers/mockHub');
const gateRegistry = require('../../../../../src/consensus/gate_registry');
const offerLists = require('../../../../../src/cross_chain/dex/offer_lists.js');
const { PRICE_CROSS_KEY, ANY_PRICE_ERA, pricesCross } = require('../../../../../src/cross_chain/dex/price_cross.js');

require('mathjs');

const CrossChainDexEngine = proxyquire('../../../../../src/cross_chain/dex_engine', { axios: { post: sinon.stub() } });

// Above any height a chain reaches, below the unarmed sentinel.
const FAR_HEIGHT = 500000000;
const BLOCK = 4242;

function makeEngine() {
    const hub = createMockHub();
    hub.db = { doQuery: sinon.stub().resolves([]) };
    hub.hubDbBroadcaster = null;
    hub.capabilitySnapshot = null;
    return new CrossChainDexEngine(hub);
}

function maker(network) {
    return {
        kind: 'order', action_index: 1, home_coin: 'BTC', home_network: network || 'regtest', block_index: 10,
        give_coin: 'BTC', give_tick: 'BBB', give_amount: '100', give_ownership: 0,
        get_coin: 'DOGE', get_tick: 'AAA', get_amount: '10', get_ownership: 0, get_address: 'Baddr',
        give_decimals: 8,
    };
}

function taker(getAmount, network) {
    return {
        kind: 'order', action_index: 2, home_coin: 'DOGE', home_network: network || 'regtest', block_index: 20,
        give_coin: 'DOGE', give_tick: 'AAA', give_amount: '10', give_ownership: 0,
        get_coin: 'BTC', get_tick: 'BBB', get_amount: getAmount, get_ownership: 0, get_address: 'Daddr',
        give_decimals: 8,
    };
}

const P1 = () => taker('150');
const P2 = () => taker('50');
const P3 = () => taker('100');

// The canonical descriptor's lo side is BTC (the maker) and its fill is what the maker
// gives; hi is DOGE (the taker) and its fill is what the taker gives.
function fills(desc) {
    return desc ? { makerGives: desc.loFill, takerGives: desc.hiFill } : null;
}

function registerPredicateTests() {
    describe('pricesCross', function () {
        it('admits any pair for the discovery pre-check', function () {
            assert.strictEqual(pricesCross('regtest', ANY_PRICE_ERA, '10', '15'), true);
            assert.strictEqual(pricesCross('regtest', ANY_PRICE_ERA, '10', '5'), true);
        });

        it('applies the legacy test with no block, and below the height', function () {
            for (const block of [null, undefined]) {
                assert.strictEqual(pricesCross('regtest', block, '10', '15'), true, 'P1 under the legacy test');
                assert.strictEqual(pricesCross('regtest', block, '10', '5'), false, 'P2 under the legacy test');
            }
            assert.strictEqual(pricesCross('testnet', FAR_HEIGHT, '10', '15'), true, 'testnet is unarmed');
            assert.strictEqual(pricesCross('mainnet', FAR_HEIGHT, '10', '5'), false, 'mainnet is unarmed');
        });

        it('crosses when the ask does not exceed the bid from the height', function () {
            assert.strictEqual(pricesCross('regtest', BLOCK, '10', '15'), false, 'P1');
            assert.strictEqual(pricesCross('regtest', BLOCK, '10', '5'), true, 'P2');
            assert.strictEqual(pricesCross('regtest', BLOCK, '10', '10'), true, 'P3');
        });

        it('reads the row on the bare network entry at the snapshot block', function () {
            const spy = sinon.spy(gateRegistry, 'activeAt');
            pricesCross('regtest', String(BLOCK), '10', '5');
            assert.ok(spy.calledWith(PRICE_CROSS_KEY, 'regtest', null, BLOCK, null));
        });
    });
}

function registerPairTests() {
    describe('tryMatch on the three pairs', function () {
        it('below the height: P1 matches against the maker\'s limit, P2 does not, P3 fills in full', function () {
            sinon.stub(gateRegistry, 'activeAt').callThrough().withArgs(PRICE_CROSS_KEY).returns(false);
            const eng = makeEngine();
            assert.deepStrictEqual(fills(eng.tryMatch(maker(), P1(), BLOCK)), { makerGives: '100', takerGives: '6.66666667' });
            assert.strictEqual(eng.tryMatch(maker(), P2(), BLOCK), null);
            assert.deepStrictEqual(fills(eng.tryMatch(maker(), P3(), BLOCK)), { makerGives: '100', takerGives: '10' });
        });

        it('with no snapshot block: the legacy test, as every caller before the activation saw it', function () {
            const eng = makeEngine();
            assert.ok(eng.tryMatch(maker(), P1()));
            assert.strictEqual(eng.tryMatch(maker(), P2()), null);
        });

        it('from the height: P1 is refused, P2 fills at the taker\'s ratio inside the maker\'s limit, P3 fills in full', function () {
            const eng = makeEngine();
            assert.strictEqual(eng.tryMatch(maker(), P1(), BLOCK), null);
            // The taker gets its ask exactly; the maker pays 50 BBB for 10 AAA, inside 10 per AAA.
            assert.deepStrictEqual(fills(eng.tryMatch(maker(), P2(), BLOCK)), { makerGives: '50', takerGives: '10' });
            assert.deepStrictEqual(fills(eng.tryMatch(maker(), P3(), BLOCK)), { makerGives: '100', takerGives: '10' });
        });

        it('a partial fill from the height settles inside the maker\'s limit', function () {
            const eng = makeEngine();
            const big = Object.assign(maker(), { give_amount: '300', get_amount: '30' });
            assert.deepStrictEqual(fills(eng.tryMatch(big, P2(), BLOCK)), { makerGives: '50', takerGives: '10' });
            const bigTaker = Object.assign(taker('150'), { give_amount: '30' });
            assert.deepStrictEqual(fills(eng.tryMatch(maker(), bigTaker, BLOCK)), { makerGives: '50', takerGives: '10' });
        });

        it('findMatches judges the era at the block it is handed', function () {
            const eng = makeEngine();
            const book = (t) => ({ BTC: [maker()], DOGE: [t] });
            assert.strictEqual(eng.findMatches(book(P1()), BLOCK).length, 0);
            assert.strictEqual(eng.findMatches(book(P2()), BLOCK).length, 1);
            assert.strictEqual(eng.findMatches(book(P1()), ANY_PRICE_ERA).length, 1, 'the pre-check admits it');
            assert.strictEqual(eng.findMatches(book(P2()), ANY_PRICE_ERA).length, 1, 'the pre-check admits it');
        });
    });
}

function stubDiscovery(eng, t) {
    eng._committedReady = true;
    eng.loadOfferBook = async (coin, books) => { books[coin] = coin === 'BTC' ? [maker()] : (coin === 'DOGE' ? [t] : []); };
    eng.resolveSnapshotBlock = async () => BLOCK;
    sinon.stub(offerLists, 'prepareOfferLists').resolves();
    eng.finalizeMatchAtSnapshot = sinon.stub().resolves();
    return sinon.spy(eng, 'findMatches');
}

function registerRoundTests() {
    describe('the leader and the follower', function () {
        it('the leader pre-checks in either era, then matches at its snapshot block', async function () {
            const eng = makeEngine();
            const spy = stubDiscovery(eng, P2());
            await eng.discoverAndMatch();
            assert.strictEqual(spy.firstCall.args[1], ANY_PRICE_ERA);
            assert.strictEqual(spy.secondCall.args[1], BLOCK);
            sinon.assert.calledOnce(eng.finalizeMatchAtSnapshot);
        });

        it('the leader proposes nothing for a pair that does not cross at its snapshot block', async function () {
            const eng = makeEngine();
            stubDiscovery(eng, P1());
            await eng.discoverAndMatch();
            sinon.assert.notCalled(eng.finalizeMatchAtSnapshot);
        });

        it('the follower re-derives the match at the proposed row\'s snapshot_block', async function () {
            const eng = makeEngine();
            eng.proposedMatchInBounds = () => true;
            eng.findOpenOffer = async (coin) => (coin === 'BTC' ? maker() : P2());
            sinon.stub(offerLists, 'prepareOfferLists').resolves();
            const spy = sinon.spy(eng, 'tryMatch');
            await eng.validateProposedMatch({ a_chain: 'BTC', a_action_index: 1, b_chain: 'DOGE', b_action_index: 2,
                network: 'regtest', snapshot_block: String(BLOCK) });
            assert.strictEqual(spy.firstCall.args[2], BLOCK);
        });
    });
}

describe('CrossChainDexEngine: order_match_price_cross_activation', function () {
    afterEach(function () { sinon.restore(); });

    registerPredicateTests();
    registerPairTests();
    registerRoundTests();
});
