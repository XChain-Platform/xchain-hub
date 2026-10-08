'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

const assert = require('assert');
const {
    attachedListIds,
    resolvedMembers,
    offerListVerdict
} = require('../../../../src/cross_chain/dex/offer_lists.js');

const admitted = { admitted: true, reason: null };
const list = (members, extra = {}) => Object.assign({
    type: 2,
    members,
    hash: 'hash',
    name: null,
    description: null,
    meta_hash: 'meta-hash'
}, extra);

describe('DEX offer list rules', function () {
    it('returns attached list ids in allow-then-block order', function () {
        assert.deepStrictEqual(attachedListIds({ allow_list: '7', block_list: 9 }), [
            { field: 'allow_list', id: 7 },
            { field: 'block_list', id: 9 }
        ]);
        assert.deepStrictEqual(attachedListIds({ allow_list: null, block_list: 0 }), []);
        assert.deepStrictEqual(attachedListIds({ allow_list: undefined, block_list: '0' }), []);
        assert.deepStrictEqual(attachedListIds(null), []);
        assert.deepStrictEqual(attachedListIds('offer'), []);
    });

    it('copies members only from resolved address lists', function () {
        let answer = list(['A', 'B']);
        let members = resolvedMembers(answer);
        assert.deepStrictEqual(members, ['A', 'B']);
        assert.notStrictEqual(members, answer.members);
        assert.strictEqual(resolvedMembers({ error: 'list not found' }), null);
        assert.strictEqual(resolvedMembers({ error: 'list reference rejected' }), null);
        assert.strictEqual(resolvedMembers(list(['A'], { error: undefined })), null);
        assert.strictEqual(resolvedMembers({ type: 1, members: ['A'] }), null);
    });

    it('rejects missing or malformed resolved members', function () {
        assert.strictEqual(resolvedMembers(list([])), null);
        assert.strictEqual(resolvedMembers(list([''])), null);
        assert.strictEqual(resolvedMembers(list(['A', 7])), null);
        assert.strictEqual(resolvedMembers({ type: 2 }), null);
        assert.strictEqual(resolvedMembers(undefined), null);
        assert.strictEqual(resolvedMembers(null), null);
    });

    it('ignores the taker and answers when both lists are detached', function () {
        assert.deepStrictEqual(offerListVerdict({ allow_list: null, block_list: null }, {}, 'A'), admitted);
        assert.deepStrictEqual(offerListVerdict({ allow_list: 0 }, undefined, undefined), admitted);
        assert.deepStrictEqual(offerListVerdict(undefined, undefined, undefined), admitted);
    });

    it('admits only takers on an attached allow list', function () {
        assert.deepStrictEqual(offerListVerdict(
            { allow_list: 7 }, { allow: list(['A']) }, 'A'), admitted);
        assert.deepStrictEqual(offerListVerdict(
            { allow_list: 7 }, { allow: list(['B']) }, 'A'),
        { admitted: false, reason: 'taker not on allow list' });
        assert.deepStrictEqual(offerListVerdict({ allow_list: 7 }, {}, 'A'),
            { admitted: false, reason: 'allow list unresolved' });
        assert.deepStrictEqual(offerListVerdict(
            { allow_list: 7 }, { allow: list([]) }, 'A'),
        { admitted: false, reason: 'allow list unresolved' });
    });

    it('refuses only takers on an attached block list', function () {
        assert.deepStrictEqual(offerListVerdict(
            { block_list: 9 }, { block: list(['A']) }, 'A'),
        { admitted: false, reason: 'taker on block list' });
        assert.deepStrictEqual(offerListVerdict(
            { block_list: 9 }, { block: list(['B']) }, 'A'), admitted);
        assert.deepStrictEqual(offerListVerdict(
            { block_list: 9 }, { block: { error: 'list not found' } }, 'A'),
        { admitted: false, reason: 'block list unresolved' });
    });

    it('checks allow before block and lets block override admission', function () {
        let offer = { allow_list: 7, block_list: 9 };
        assert.deepStrictEqual(offerListVerdict(offer, {}, 'A'),
            { admitted: false, reason: 'allow list unresolved' });
        assert.deepStrictEqual(offerListVerdict(
            offer, { allow: list(['A']), block: list(['A']) }, 'A'),
        { admitted: false, reason: 'taker on block list' });
        assert.deepStrictEqual(offerListVerdict(
            offer, { allow: list(['A']), block: list(['B']) }, 'A'), admitted);
    });

    it('checks a required taker before resolving attached lists', function () {
        assert.deepStrictEqual(offerListVerdict({ allow_list: 7 }, {}, ''),
            { admitted: false, reason: 'taker address missing' });
        assert.deepStrictEqual(offerListVerdict({ block_list: 9 }, {}, null),
            { admitted: false, reason: 'taker address missing' });
    });

    it('does not mutate offers, answers, or list member arrays', function () {
        let offer = { allow_list: 7, block_list: 9 };
        let answers = { allow: list(['A']), block: list(['B']) };
        let before = JSON.stringify([offer, answers]);
        assert.deepStrictEqual(offerListVerdict(offer, answers, 'A'), admitted);
        assert.strictEqual(JSON.stringify([offer, answers]), before);
    });
});
