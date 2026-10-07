'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const assert     = require('assert');
const sinon      = require('sinon');
const proxyquire = require('proxyquire');
const bc         = require('../../../../src/bcmath.js');
const { createMockHub } = require('../../../helpers/mockHub');

require('mathjs');

const CrossChainDexEngine = proxyquire('../../../../src/cross_chain/dex_engine', {
    axios: { post: sinon.stub() }
});

function makeDexHub() {
    const hub = createMockHub();
    hub.db = { doQuery: sinon.stub().resolves([]) };
    hub.hubDbBroadcaster = null;
    hub.capabilitySnapshot = null;
    return hub;
}

function assertPlainAmounts(values) {
    for (const [name, value] of Object.entries(values)) {
        assert.strictEqual(typeof value, 'string', name + ' must be a string');
        assert.doesNotMatch(value, /e[+-]?\d/i, name + ' must use plain-decimal notation');
    }
}

function tinyOrderPair() {
    const common = { kind: 'order', home_network: 'regtest', give_ownership: 0,
        get_ownership: 0, give_decimals: 8 };
    const maker = Object.assign({}, common, {
        action_index: 11, home_coin: 'BTC', block_index: 10,
        give_coin: 'BTC', give_tick: 'BTCT', give_amount: '0.00000002',
        get_coin: 'DOGE', get_tick: 'DOGET', get_amount: '2', get_address: 'Baddr'
    });
    const taker = Object.assign({}, common, {
        action_index: 22, home_coin: 'DOGE', block_index: 20,
        give_coin: 'DOGE', give_tick: 'DOGET', give_amount: '1',
        get_coin: 'BTC', get_tick: 'BTCT', get_amount: '0.00000001', get_address: 'Daddr'
    });
    return { maker, taker };
}

describe('DEX fill amount plain-decimal serialization @regression @tier1', function () {
    let eng;

    beforeEach(function () {
        eng = new CrossChainDexEngine(makeDexHub());
    });

    it('writes sub-1e-7 order fills and signed-row offsets as plain strings', function () {
        const { maker, taker } = tinyOrderPair();
        const desc = eng.tryOrderMatch(maker, taker);
        assert.ok(desc, 'the tiny pair crosses');
        assertPlainAmounts({
            loFill: desc.loFill,
            hiFill: desc.hiFill,
            loFilledBefore: desc.loFilledBefore,
            hiFilledBefore: desc.hiFilledBefore
        });
        assert.strictEqual(desc.loFill, '0.00000001');

        const row = eng.buildMatchRow(desc, 'match-id', 123, 456);
        assertPlainAmounts({
            a_amount: row.a_amount,
            b_amount: row.b_amount,
            a_filled_before: row.a_filled_before,
            b_filled_before: row.b_filled_before
        });
        assert.match(eng.canonicalMatch(row, 0), /\|0\.00000001\|/);
        assert.doesNotMatch(eng.canonicalMatch(row, 0), /\|[^|]*e[+-]?\d[^|]*\|/i);
    });

    it('keeps committed totals, remaining capacity, and the next offset plain', function () {
        const { maker, taker } = tinyOrderPair();
        eng.applyCommit({
            a_chain: maker.home_coin,
            a_action_index: maker.action_index,
            a_amount: bc.bcnum('0.00000001'),
            b_chain: taker.home_coin,
            b_action_index: taker.action_index,
            b_amount: bc.bcnum('1')
        }, +1);

        const committed = eng.committedFor(maker);
        const remaining = eng.effectiveRemaining(maker);
        assertPlainAmounts({
            committedGive: committed.give,
            committedGet: committed.get,
            remainingGive: remaining.give,
            remainingGet: remaining.get,
            remainingCommittedGive: remaining.committedGive
        });
        assert.strictEqual(committed.give, '0.00000001');
        assert.strictEqual(remaining.give, '0.00000001');

        const desc = eng.buildDesc(maker, taker, 'order', 'order',
            bc.bcnum('0.00000001'), bc.bcnum('1'));
        assert.strictEqual(desc.loFilledBefore, '0.00000001');
        assertPlainAmounts({
            loFill: desc.loFill,
            hiFill: desc.hiFill,
            loFilledBefore: desc.loFilledBefore,
            hiFilledBefore: desc.hiFilledBefore
        });
    });
});
