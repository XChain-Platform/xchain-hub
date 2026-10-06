'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    priceRoundKey,
    splitRoundGroups,
    sameSignedRoundFields
} = require('../../../../src/peers/hub_db/price_round_groups.js');

function row(round, proof, pair, extra = {}) {
    return {
        round_number: round, consensus_proof: proof, coin_pair: pair,
        reference_block: 100, block_timestamp: 5,
        admit_block_btc: 1, admit_block_ltc: null, admit_block_doge: 3, ...extra
    };
}

describe('price round groups', function () {
    it('groups price rows by round number and proof', function () {
        const rows = [row(1, 'a', 'x'), row('2', 'b', 'x'), row(1, 'a', 'y')];
        const { ready, held } = splitRoundGroups([], rows, false);
        expect(ready.map(g => g.map(r => r.coin_pair))).to.deep.equal([['x', 'y'], ['x']]);
        expect(held).to.deep.equal([]);
        expect(priceRoundKey(row('1', 'a', 'x'))).to.equal(priceRoundKey(row(1, 'a', 'y')));
    });

    it('keeps two proofs for one round number apart', function () {
        const { ready } = splitRoundGroups([], [row(1, 'a', 'x'), row(1, 'b', 'x')], false);
        expect(ready).to.have.length(2);
    });

    it('holds back the group that ends a full page', function () {
        const rows = [row(1, 'a', 'x'), row(2, 'b', 'x'), row(2, 'b', 'y')];
        const { ready, held } = splitRoundGroups([], rows, true);
        expect(ready).to.have.length(1);
        expect(ready[0][0].round_number).to.equal(1);
        expect(held.map(r => r.coin_pair)).to.deep.equal(['x', 'y']);
    });

    it('releases a held group with the rows of the next page', function () {
        const first = splitRoundGroups([], [row(1, 'a', 'x'), row(2, 'b', 'x')], true);
        const second = splitRoundGroups(first.held, [row(2, 'b', 'y'), row(3, 'c', 'x')], false);
        expect(second.ready.map(g => g.map(r => r.coin_pair))).to.deep.equal([['x', 'y'], ['x']]);
        expect(second.held).to.deep.equal([]);
    });

    it('holds nothing when the page is short', function () {
        const { ready, held } = splitRoundGroups([], [row(1, 'a', 'x')], false);
        expect(ready).to.have.length(1);
        expect(held).to.deep.equal([]);
        expect(splitRoundGroups([], [], true)).to.deep.equal({ ready: [], held: [] });
        expect(splitRoundGroups(undefined, undefined, false)).to.deep.equal({ ready: [], held: [] });
    });

    it('tells a group whose signed fields disagree', function () {
        expect(sameSignedRoundFields([])).to.equal(false);
        expect(sameSignedRoundFields([row(1, 'a', 'x'), row(1, 'a', 'y')])).to.equal(true);
        const undef = row(1, 'a', 'y');
        delete undef.admit_block_ltc;
        expect(sameSignedRoundFields([row(1, 'a', 'x'), undef])).to.equal(true);
        for (const key of ['reference_block', 'block_timestamp', 'admit_block_btc',
            'admit_block_ltc', 'admit_block_doge', 'consensus_proof']) {
            const other = row(1, 'a', 'y', { [key]: 'changed' });
            expect(sameSignedRoundFields([row(1, 'a', 'x'), other]), key).to.equal(false);
        }
        expect(sameSignedRoundFields([row(1, 'a', 'x'), row(2, 'a', 'x')])).to.equal(false);
    });

    it('leaves its input arrays untouched', function () {
        const carried = [row(1, 'a', 'x')];
        const page = [row(1, 'a', 'y'), row(2, 'b', 'x')];
        const before = JSON.stringify([carried, page]);
        splitRoundGroups(carried, page, true);
        splitRoundGroups(carried, page, false);
        expect(JSON.stringify([carried, page])).to.equal(before);
    });
});
