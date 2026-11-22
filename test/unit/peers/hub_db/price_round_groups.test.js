'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    isProducerRoundRow,
    groupKey,
    indexGroups,
    groupAgrees,
    priceSnapshotAlreadyHeld,
    holdTrailingGroup,
    ROUND_AGREEMENT_KEYS
} = require('../../../../src/peers/hub_db/price_round_groups.js');

// A finalized producer row: the shape the round's own producer stores.
function row(round, proof, pair, extra = {}) {
    return {
        id: 0, round_number: round, consensus_proof: proof, coin_pair: pair, status: 'finalized',
        reference_chain: 'BTC', source_chain: 'DOGE', source_action_index: null, push_generation: 0,
        reference_block: 100, block_timestamp: 5, validator_count: 3,
        admit_block_btc: 1, admit_block_ltc: null, admit_block_doge: 3, ...extra
    };
}

const proofOf = name => '["' + name + '"]';
const pairsOf = groups => Array.from(groups.values()).map(g => g.map(r => r.coin_pair));

describe('price round groups', function () {
    it('groups price rows by round number and proof', function () {
        const rows = [row(1, proofOf('a'), 'x'), row('2', proofOf('b'), 'x'), row(1, proofOf('a'), 'y')];
        expect(pairsOf(indexGroups(rows))).to.deep.equal([['x', 'y'], ['x']]);
        expect(groupKey(row('1', proofOf('a'), 'x'))).to.equal(groupKey(row(1, proofOf('a'), 'y')));
    });

    it('keeps two proofs for one round number apart', function () {
        expect(indexGroups([row(1, proofOf('a'), 'x'), row(1, proofOf('b'), 'x')]).size).to.equal(2);
    });

    it('holds back the group that ends a full page', function () {
        const rows = [row(1, proofOf('a'), 'x'), row(2, proofOf('b'), 'x'), row(2, proofOf('b'), 'y')];
        const { ready, held } = holdTrailingGroup(rows, true);
        expect(ready).to.have.length(1);
        expect(ready[0].round_number).to.equal(1);
        expect(held.map(r => r.coin_pair)).to.deep.equal(['x', 'y']);
    });

    it('releases a held group with the rows of the next page', function () {
        const first = holdTrailingGroup([row(1, proofOf('a'), 'x'), row(2, proofOf('b'), 'x')], true);
        const next = first.held.concat([row(2, proofOf('b'), 'y'), row(3, proofOf('c'), 'x')]);
        const second = holdTrailingGroup(next, false);
        expect(pairsOf(indexGroups(second.ready))).to.deep.equal([['x', 'y'], ['x']]);
        expect(second.held).to.deep.equal([]);
    });

    it('holds nothing when the page is short', function () {
        const single = holdTrailingGroup([row(1, proofOf('a'), 'x')], false);
        expect(single.ready).to.have.length(1);
        expect(single.held).to.deep.equal([]);
        expect(holdTrailingGroup([], true)).to.deep.equal({ ready: [], held: [] });
        expect(holdTrailingGroup([], false)).to.deep.equal({ ready: [], held: [] });
    });

    it('tells a group whose signed fields disagree', function () {
        const first = row(1, proofOf('a'), 'x');
        expect(groupAgrees(first, [first, row(1, proofOf('a'), 'y')])).to.equal(true);
        const undef = Object.assign(row(1, proofOf('a'), 'y'), { admit_block_ltc: undefined });
        expect(groupAgrees(first, [first, undef])).to.equal(true);
        for (const key of ['reference_block', 'block_timestamp', 'admit_block_btc',
            'admit_block_ltc', 'admit_block_doge', 'consensus_proof', 'validator_count']) {
            const other = row(1, proofOf('a'), 'y', { [key]: 'changed' });
            expect(groupAgrees(first, [first, other]), key).to.equal(false);
        }
        expect(groupAgrees(first, [first, row(2, proofOf('a'), 'y')])).to.equal(false);
        expect(groupAgrees(first, [first, row(1, proofOf('a'), 'x')])).to.equal(false);
        expect(groupAgrees(first, [first, row(1, proofOf('a'), 'y', { source_action_index: 4 })])).to.equal(false);
    });

    it('leaves its input arrays untouched', function () {
        const carried = [row(1, proofOf('a'), 'x')];
        const page = [row(1, proofOf('a'), 'y'), row(2, proofOf('b'), 'x')];
        const before = JSON.stringify([carried, page]);
        holdTrailingGroup(carried.concat(page), true);
        holdTrailingGroup(carried.concat(page), false);
        indexGroups(carried.concat(page));
        expect(JSON.stringify([carried, page])).to.equal(before);
    });
});

describe('price round group keys and holding', function () {
    it('recognizes a held price through the database key fold', function () {
        const held = [row(7, proofOf('p'), 'BTC/USD')];
        expect(priceSnapshotAlreadyHeld(held,
            row(7, proofOf('p'), 'btc/usd '))).to.equal(true);
        expect(priceSnapshotAlreadyHeld(held,
            row(8, proofOf('p'), 'BTC/USD'))).to.equal(false);
    });

    it('names one list of signed round fields for the signed-field check and the verifier', function () {
        expect(ROUND_AGREEMENT_KEYS).to.deep.equal(['round_number', 'reference_block', 'block_timestamp',
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'consensus_proof']);
        expect(Object.isFrozen(ROUND_AGREEMENT_KEYS)).to.equal(true);
    });

    it('holds every row of the round that ends a full page, adjacent or not', function () {
        const live = (id, round, pair) => row(round, '[' + round + ']', pair, { id });
        const rows = [live(1, 7, 'x'), live(2, 8, 'x'), live(3, 8, 'y'), live(4, 7, 'y')];
        const { ready, held } = holdTrailingGroup(rows, true);
        expect(held.map(r => r.id)).to.deep.equal([1, 4]);
        expect(ready.map(r => r.id)).to.deep.equal([2, 3]);
        expect(holdTrailingGroup(rows, false)).to.deep.equal({ ready: rows, held: [] });
        expect(holdTrailingGroup([], true)).to.deep.equal({ ready: [], held: [] });
    });
});

describe('price round producer gate in grouping', function () {
    const NON_PRODUCER = {
        'source_chain equal to reference_chain': { source_chain: 'BTC' },
        'a named source action': { source_action_index: 7 },
        'a push generation': { push_generation: 1 },
        'a skipped status': { status: 'skipped' },
        'a batch-form proof': { consensus_proof: '{"batch":{}}' }
    };

    it('keys no row that is not a producer round row', function () {
        expect(isProducerRoundRow(row(1, proofOf('a'), 'x'))).to.equal(true);
        for (const [name, extra] of Object.entries(NON_PRODUCER)) {
            expect(groupKey(row(1, proofOf('a'), 'x', extra)), name).to.equal(null);
        }
    });

    it('leaves a non-producer row out of every group', function () {
        const rows = [row(1, proofOf('a'), 'x'), row(1, proofOf('a'), 'y', { source_action_index: 7 })];
        expect(pairsOf(indexGroups(rows))).to.deep.equal([['x']]);
    });

    it('holds nothing when the row that ends a full page is not a producer row', function () {
        const rows = [row(1, proofOf('a'), 'x'), row(2, proofOf('b'), 'x'),
            row(2, proofOf('b'), 'y', { status: 'skipped' })];
        const { ready, held } = holdTrailingGroup(rows, true);
        expect(ready).to.equal(rows);
        expect(held).to.deep.equal([]);
    });

    it('keeps a non-producer row in ready while the trailing producer round is held', function () {
        const pushed = row(5, proofOf('p'), 'x', { source_chain: 'BTC' });
        const rows = [pushed, row(2, proofOf('b'), 'x'), row(2, proofOf('b'), 'y')];
        const { ready, held } = holdTrailingGroup(rows, true);
        expect(ready).to.deep.equal([pushed]);
        expect(held.map(r => r.coin_pair)).to.deep.equal(['x', 'y']);
    });

    it('refuses a group that carries a non-producer member', function () {
        const first = row(1, proofOf('a'), 'x');
        const member = row(1, proofOf('a'), 'y', { source_action_index: 7 });
        expect(groupAgrees(first, [first, member])).to.equal(false);
    });
});
