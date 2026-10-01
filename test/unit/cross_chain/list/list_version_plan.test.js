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
const { planListVersion } = require('../../../../src/cross_chain/list/version_plan.js');

function read(members, type = 2) {
    return { type, members, hash: listMembersHash(members) };
}

describe('shared-list version plan first and unchanged', function () {
    it('plans the first version as a full copy', function () {
        const current = read(['a', 'b']);
        const result = planListVersion({
            read: current,
            originBlock: 100,
            held: { lastSeq: 0, latest: null, fold: () => null }
        });

        assert.deepStrictEqual(result.version, {
            list_type: 2,
            seq: 1,
            kind: 'full',
            added: ['a', 'b'],
            removed: [],
            members_hash: current.hash,
            origin_block: 100
        });
        assert.notStrictEqual(result.version.added, current.members);
    });

    it('reports an unchanged list without folding the held chain', function () {
        const current = read(['a', 'b']);
        const result = planListVersion({
            read: current,
            originBlock: 100,
            held: {
                lastSeq: 1,
                latest: { members_hash: current.hash, origin_block: 90, list_type: '2' },
                fold: () => { throw new Error('fold must not run'); }
            }
        });

        assert.deepStrictEqual(result, { unchanged: true });
    });
});

describe('shared-list version plan delta and input refusals', function () {
    it('plans a canonical delta with numeric origin-block comparison', function () {
        const previous = ['a', 'b', 'd', 'f'];
        const current = read(['b', 'c', 'e', 'f']);
        const result = planListVersion({
            read: current,
            originBlock: '100',
            held: {
                lastSeq: 4,
                latest: {
                    members_hash: listMembersHash(previous),
                    origin_block: '90',
                    list_type: 2
                },
                fold: () => previous
            }
        });

        assert.deepStrictEqual(result.version, {
            list_type: 2,
            seq: 5,
            kind: 'delta',
            added: ['c', 'e'],
            removed: ['a', 'd'],
            members_hash: current.hash,
            origin_block: '100'
        });
    });

    it('refuses unsupported list types', function () {
        assert.deepStrictEqual(planListVersion({
            read: read(['a'], 3),
            originBlock: 100,
            held: { lastSeq: 0, latest: null, fold: () => null }
        }), { refuse: 'type' });
    });

    it('refuses non-canonical member order before checking its hash', function () {
        assert.deepStrictEqual(planListVersion({
            read: { type: 2, members: ['b', 'a'], hash: 'not-used' },
            originBlock: 100,
            held: { lastSeq: 0, latest: null, fold: () => null }
        }), { refuse: 'order' });
    });

    it('refuses a mismatched membership hash', function () {
        assert.deepStrictEqual(planListVersion({
            read: { type: 2, members: ['a'], hash: 'wrong' },
            originBlock: 100,
            held: { lastSeq: 0, latest: null, fold: () => null }
        }), { refuse: 'hash' });
    });
});

describe('shared-list version plan held-chain refusals', function () {
    it('refuses a changed held list type', function () {
        const current = read(['b']);
        assert.deepStrictEqual(planListVersion({
            read: current,
            originBlock: 100,
            held: {
                lastSeq: 1,
                latest: { members_hash: listMembersHash(['a']), origin_block: 90, list_type: 1 },
                fold: () => ['a']
            }
        }), { refuse: 'list-type' });
    });

    it('refuses a missing or hash-mismatched fold', function () {
        const current = read(['b']);
        const latest = { members_hash: listMembersHash(['a']), origin_block: 90, list_type: 2 };

        assert.deepStrictEqual(planListVersion({
            read: current,
            originBlock: 100,
            held: { lastSeq: 1, latest, fold: () => null }
        }), { refuse: 'fold' });
        assert.deepStrictEqual(planListVersion({
            read: current,
            originBlock: 100,
            held: { lastSeq: 1, latest, fold: () => ['c'] }
        }), { refuse: 'fold' });
    });

    it('refuses a non-increasing origin block', function () {
        const previous = ['a'];
        const current = read(['b']);
        assert.deepStrictEqual(planListVersion({
            read: current,
            originBlock: '90',
            held: {
                lastSeq: 1,
                latest: {
                    members_hash: listMembersHash(previous),
                    origin_block: 90,
                    list_type: 2
                },
                fold: () => previous
            }
        }), { refuse: 'origin-block' });
    });
});

describe('shared-list version plan limits', function () {
    it('declines a list above the member limit', function () {
        const members = Array.from(
            { length: 10001 },
            (unused, index) => `m${String(index).padStart(5, '0')}`
        );

        assert.deepStrictEqual(planListVersion({
            read: read(members),
            originBlock: 100,
            held: { lastSeq: 0, latest: null, fold: () => null }
        }), { decline: 'max-members' });
    });
});
