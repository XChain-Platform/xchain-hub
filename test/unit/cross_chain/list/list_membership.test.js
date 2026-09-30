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
    isCanonicalOrder,
    listMembersHash,
    listDelta,
    applyListDelta
} = require('../../../../src/cross_chain/list/canonical.js');
const {
    LIST_CANONICAL_INT_FIELDS,
    LIST_SHARE_MAX_MEMBERS
} = require('../../../../src/cross_chain/list/constants.js');

describe('shared-list membership canonicals', function () {
    it('pins the shared-list constants and canonical integer spellings', function () {
        assert.strictEqual(LIST_SHARE_MAX_MEMBERS, 10000);
        assert.deepStrictEqual(LIST_CANONICAL_INT_FIELDS,
            ['snapshot_block', 'home_list_index', 'list_type', 'seq', 'origin_block']);
    });

    it('hashes literal membership vectors in the supplied order', function () {
        assert.strictEqual(listMembersHash([]),
            '84905375bf10144fbd8e34ad160942f3f22f0b41fe14298acf4074de942cd32a');
        assert.strictEqual(listMembersHash(['a', 'b']),
            '63a9f7e2601177f08de4f4d0c02e233962a38b76debccf7e8feaaec8506230ca');
        assert.strictEqual(listMembersHash(['b', 'a']),
            'ab53c19f6f4880cd82e5a5b29cac877f591875be72245a2d8ec7711efc30e01a');
        assert.throws(() => listMembersHash('a'), TypeError);
    });

    it('recognizes strictly ascending UTF-8 byte order', function () {
        assert.strictEqual(isCanonicalOrder([]), true);
        assert.strictEqual(isCanonicalOrder(['a', 'b']), true);
        assert.strictEqual(isCanonicalOrder(['b', 'a']), false);
        assert.strictEqual(isCanonicalOrder(['a', 'a']), false);
        assert.strictEqual(isCanonicalOrder(['\uE000', '\u{10000}']), true);
        assert.strictEqual(isCanonicalOrder(['\u{10000}', '\uE000']), false);
    });

    it('computes additions and removals in canonical order', function () {
        assert.deepStrictEqual(listDelta(['b', 'a'], ['d', 'b', 'c']), {
            added: ['c', 'd'],
            removed: ['a']
        });
        assert.deepStrictEqual(listDelta(['a', 'b'], ['a', 'b']), { added: [], removed: [] });
    });

    it('applies a strict delta and returns canonical membership', function () {
        assert.deepStrictEqual(applyListDelta(['b', 'a'], ['c'], ['a']), ['b', 'c']);
        assert.deepStrictEqual(applyListDelta(['a', 'b'], [], []), ['a', 'b']);
    });

    it('rejects every non-strict delta shape', function () {
        assert.strictEqual(applyListDelta(['a'], ['c', 'b'], []), null);
        assert.strictEqual(applyListDelta(['a', 'b'], [], ['b', 'a']), null);
        assert.strictEqual(applyListDelta(['a', 'b'], ['b'], []), null);
        assert.strictEqual(applyListDelta(['a', 'b'], [], ['z']), null);
        assert.strictEqual(applyListDelta(['a'], ['b'], ['b']), null);
        assert.strictEqual(applyListDelta(['a'], ['b', 'b'], []), null);
        assert.strictEqual(applyListDelta(['a'], 'b', []), null);
    });
});
