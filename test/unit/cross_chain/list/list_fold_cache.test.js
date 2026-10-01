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

const { listMembersHash } = require('../../../../src/cross_chain/list/canonical.js');
const { createFoldCache, listsDue } = require('../../../../src/cross_chain/list/fold_cache.js');

describe('shared-list fold cache', function () {
    it('folds once for repeated reads of the same numeric sequence and hash', function () {
        const cache = createFoldCache();
        const members = ['a', 'b'];
        const hash = listMembersHash(members);
        let calls = 0;
        const fold = () => {
            calls += 1;
            return members;
        };

        assert.strictEqual(cache.get('DOGE', 7, '2', hash, fold), members);
        assert.strictEqual(cache.get('DOGE', 7, 2, hash, fold), members);
        assert.strictEqual(calls, 1);
        assert.strictEqual(cache.size(), 1);
    });

    it('folds again for a new sequence or membership hash', function () {
        const cache = createFoldCache();
        const first = ['a'];
        const second = ['b'];
        let calls = 0;

        cache.get('DOGE', 7, 1, listMembersHash(first), () => {
            calls += 1;
            return first;
        });
        cache.get('DOGE', 7, 2, listMembersHash(first), () => {
            calls += 1;
            return first;
        });
        cache.get('DOGE', 7, 2, listMembersHash(second), () => {
            calls += 1;
            return second;
        });

        assert.strictEqual(calls, 3);
        assert.strictEqual(cache.size(), 1);
    });
});

describe('shared-list fold cache validation and eviction', function () {
    it('does not cache wrong-hash, null, or throwing folds', function () {
        const cache = createFoldCache();
        const expectedHash = listMembersHash(['expected']);
        const failures = [
            () => ['wrong'],
            () => null,
            () => { throw new Error('unavailable'); }
        ];

        for (const fail of failures) {
            let calls = 0;
            const fold = () => {
                calls += 1;
                return fail();
            };
            assert.strictEqual(cache.get('DOGE', 7, 1, expectedHash, fold), null);
            assert.strictEqual(cache.get('DOGE', 7, 1, expectedHash, fold), null);
            assert.strictEqual(calls, 2);
        }
        assert.strictEqual(cache.size(), 0);
    });

    it('evicts the oldest entry past the configured maximum', function () {
        const cache = createFoldCache(2);
        const calls = { first: 0, second: 0, third: 0 };
        const load = (index, name) => {
            const members = [name];
            return cache.get('DOGE', index, 1, listMembersHash(members), () => {
                calls[name] += 1;
                return members;
            });
        };

        load(1, 'first');
        load(2, 'second');
        load(1, 'first');
        load(3, 'third');
        load(1, 'first');

        assert.deepStrictEqual(calls, { first: 2, second: 1, third: 1 });
        assert.strictEqual(cache.size(), 2);
    });
});

describe('shared-list due filter', function () {
    it('keeps due entries in input order and excludes invalid blocks', function () {
        const entries = [
            { root_index: 1, share_block: '9' },
            { root_index: 2, share_block: 10 },
            { root_index: 3, share_block: 11 },
            { root_index: 4 },
            { root_index: 5, share_block: 'not-a-block' },
            0,
            false,
            ''
        ];

        assert.deepStrictEqual(listsDue(entries, '10'), entries.slice(0, 2));
        assert.deepStrictEqual(listsDue(null, 10), []);
    });
});
