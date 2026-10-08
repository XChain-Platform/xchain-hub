'use strict';

// GENERATED

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const registry = require('../../../../src/consensus/gate_registry.js');
const matchPart = require('../../../../src/cross_chain/dex/match.js');
const validatePart = require('../../../../src/cross_chain/dex/validate.js');
const offerLists = require('../../../../src/cross_chain/dex/offer_lists.js');
const { ALLOWED_CHAINS } = require('../../../../src/cross_chain/dex/constants.js');
const originalActiveAt = registry.activeAt;

function asyncStub(implementation){
    let stub = async (...args) => {
        stub.callCount++;
        stub.calls.push(args);
        return implementation(...args);
    };
    stub.callCount = 0;
    stub.calls = [];
    return stub;
}

function resolves(value){ return asyncStub(async () => value); }
function rejects(error){ return asyncStub(async () => { throw error; }); }

function offer(overrides){
    return Object.assign({
        kind: 'swap',
        action_index: 1,
        home_coin: 'BTC',
        home_network: 'regtest',
        home_block: 100,
        block_index: 90,
        give_coin: 'BTC',
        give_tick: 'A',
        give_amount: '5',
        give_ownership: 0,
        get_coin: 'LTC',
        get_tick: 'B',
        get_amount: '10',
        get_ownership: 0,
        get_address: 'btc-payout',
        source: 'btc-source',
        allow_list: null,
        block_list: null
    }, overrides || {});
}

function pair(aOverrides, bOverrides){
    let a = offer(aOverrides);
    let b = offer(Object.assign({
        action_index: 2,
        home_coin: 'LTC',
        give_coin: 'LTC',
        give_tick: 'B',
        give_amount: '10',
        get_coin: 'BTC',
        get_tick: 'A',
        get_amount: '5',
        get_address: 'ltc-payout',
        source: 'ltc-source'
    }, bOverrides || {}));
    return [a, b];
}

function matchEngine(indexerCall){
    return Object.assign({
        committedFor: () => ({ give: '0', get: '0' }),
        effectiveRemaining: o => ({ give: o.give_amount, get: o.get_amount }),
        offerKey: (coin, actionIndex) => coin + ':' + actionIndex,
        indexerCall
    }, matchPart);
}

function armGate(active){
    registry.activeAt = key =>
        key === offerLists.CROSS_CHAIN_OFFER_LIST_ENFORCEMENT ? active : false;
}

function registerPolicyEnforcementTests(){
    it('keeps the legacy matcher byte path below the hub gate', async function(){
        armGate(false);
        let [a, b] = pair();
        delete a.allow_list;
        delete a.block_list;
        let rpc = rejects(new Error('must not read lists below the gate'));
        let engine = matchEngine(rpc);

        await offerLists.prepareOfferLists(engine, [a, b], 100);

        assert.ok(engine.tryMatch(a, b));
        assert.strictEqual(rpc.callCount, 0);
    });

    it('admits a pair only when both attached allow lists contain the opposite payout', async function(){
        armGate(true);
        let [a, b] = pair({ allow_list: 11 }, { allow_list: '22' });
        let rpc = asyncStub(async (coin, method, params) => {
            assert.strictEqual(method, 'getlistat');
            assert.strictEqual(params.block, 100);
            if(coin === 'BTC' && params.list_index === 11)
                return { type: 0, members: ['ltc-payout'] };
            if(coin === 'LTC' && params.list_index === 22)
                return { type: 0, members: ['btc-payout'] };
            return { error: 'not found' };
        });
        let engine = matchEngine(rpc);

        await offerLists.prepareOfferLists(engine, [a, b], 100);

        assert.ok(engine.tryMatch(a, b));
        assert.strictEqual(rpc.callCount, 2);
    });

    it('denies empty allow lists and matching block-list members', async function(){
        armGate(true);
        let emptyPair = pair({ allow_list: 11 });
        let blockedPair = pair({ block_list: 12 });
        let rpc = asyncStub(async (_coin, _method, params) => ({
            type: 0,
            members: params.list_index === 11 ? [] : ['ltc-payout']
        }));
        let engine = matchEngine(rpc);

        await offerLists.prepareOfferLists(engine, emptyPair, 100);
        await offerLists.prepareOfferLists(engine, blockedPair, 100);

        assert.strictEqual(engine.tryMatch(...emptyPair), null);
        assert.strictEqual(engine.tryMatch(...blockedPair), null);
    });
}

function registerPolicyRejectionTests(){
    it('fails closed on omitted fields, malformed ids, wrong list types and read failures', async function(){
        armGate(true);
        let cases = [
            pair(),
            pair({ allow_list: '01' }),
            pair({ allow_list: 11 }),
            pair({ allow_list: 12 })
        ];
        delete cases[0][0].allow_list;
        let rpc = asyncStub(async (_coin, _method, params) => {
            if(params.list_index === 11) return { type: 1, members: ['ltc-payout'] };
            throw new Error('unavailable');
        });
        let engine = matchEngine(rpc);

        for(let offers of cases){
            await offerLists.prepareOfferLists(engine, offers, 100);
            assert.strictEqual(engine.tryMatch(...offers), null);
        }
    });

    it('continues past a denied first candidate to the next price-time candidate', async function(){
        armGate(true);
        let [a, denied] = pair({ allow_list: 11 });
        let allowed = offer(Object.assign({}, denied, {
            action_index: 3,
            get_address: 'allowed-payout'
        }));
        let rpc = resolves({ type: 0, members: ['allowed-payout'] });
        let engine = matchEngine(rpc);
        let books = { BTC: [a], LTC: [denied, allowed], DOGE: [] };

        await offerLists.prepareOfferLists(engine, [a, denied, allowed], 100);
        let matches = engine.findMatches(books);

        assert.strictEqual(matches.length, 1);
        assert.strictEqual(matches[0].hi.action_index, 3);
    });
}

function registerLeaderEnforcementTests(){
    it('the leader proposes nothing when an active list cannot be resolved', async function(){
        armGate(true);
        let offers = pair({ allow_list: 11 });
        let finalize = resolves();
        let engine = matchEngine(rejects(new Error('list rpc down')));
        Object.assign(engine, {
            _matching: false,
            _committedReady: true,
            rebuildCommitted: resolves(true),
            resolveSnapshotBlock: resolves(100),
            finalizeMatch: finalize,
            loadOfferBook: async (coin, books) => {
                books[coin] = offers.filter(o => o.home_coin === coin);
            }
        });

        await engine.discoverAndMatch();

        assert.strictEqual(finalize.callCount, 0);
        assert.strictEqual(engine._matching, false);
        assert.deepStrictEqual(ALLOWED_CHAINS.filter(coin => offers.some(o => o.home_coin === coin)), ['BTC', 'LTC']);
    });

    it('pins finalization to the snapshot that governed list enforcement', async function(){
        armGate(true);
        let offers = pair();
        let heights = [100, 101];
        let resolver = asyncStub(async () => heights.shift());
        let finalizedAt = null;
        let engine = matchEngine(rejects(new Error('no attached lists')));
        Object.assign(engine, {
            _matching: false,
            _committedReady: true,
            rebuildCommitted: resolves(true),
            resolveSnapshotBlock: resolver,
            finalizeMatch: async desc => {
                assert.ok(desc);
                finalizedAt = await engine.resolveSnapshotBlock();
            },
            loadOfferBook: async (coin, books) => {
                books[coin] = offers.filter(o => o.home_coin === coin);
            }
        });

        await engine.discoverAndMatch();

        assert.strictEqual(finalizedAt, 100);
        assert.strictEqual(resolver.callCount, 1);
        assert.strictEqual(await engine.resolveSnapshotBlock(), 101);
    });
}

function registerFollowerEnforcementTests(){
    it('the follower refuses a proposal when its independent list read fails', async function(){
        armGate(true);
        let [a, b] = pair({ allow_list: 11 });
        let engine = Object.assign(matchEngine(rejects(new Error('list rpc down'))), validatePart, {
            proposedMatchInBounds: () => true,
            findOpenOffer: async coin => coin === 'BTC' ? a : b
        });
        let row = {
            network: 'regtest',
            snapshot_block: 100,
            a_chain: 'BTC',
            a_action_index: 1,
            b_chain: 'LTC',
            b_action_index: 2
        };

        assert.strictEqual(await engine.validateProposedMatch(row), false);
    });
}

describe('cross-chain DEX offer-list enforcement', function(){
    afterEach(function(){ registry.activeAt = originalActiveAt; });
    registerPolicyEnforcementTests();
    registerPolicyRejectionTests();
    registerLeaderEnforcementTests();
    registerFollowerEnforcementTests();
});
