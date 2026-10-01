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
    deriveListSnapshotId,
    foldListChain
} = require('../../../../src/cross_chain/list/chain.js');

describe('list chain', function () {
    it('derives the list snapshot id vector', function () {
        assert.strictEqual(deriveListSnapshotId('testnet', 'DOGE', 880001, 1, 160000),
            'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21');
    });

    it('folds a full row followed by strict deltas', function () {
        assert.deepStrictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a', 'b'],
                removed: [],
                members_hash: '63a9f7e2601177f08de4f4d0c02e233962a38b76debccf7e8feaaec8506230ca'
            },
            {
                seq: 2,
                kind: 'delta',
                added: ['c'],
                removed: ['a'],
                members_hash: 'c4588e1a55013d6df7e8e9557cb8adf06f1c3308bfc420ef04b314f581cbf524'
            }
        ]), ['b', 'c']);
    });

    it('rejects an empty chain and sequence gaps', function () {
        assert.strictEqual(foldListChain([]), null);
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a'],
                removed: [],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            },
            {
                seq: 3,
                kind: 'delta',
                added: ['b'],
                removed: [],
                members_hash: '63a9f7e2601177f08de4f4d0c02e233962a38b76debccf7e8feaaec8506230ca'
            }
        ]), null);
    });

    it('rejects invalid row kinds', function () {
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'delta',
                added: ['a'],
                removed: [],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            }
        ]), null);
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a'],
                removed: [],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            },
            {
                seq: 2,
                kind: 'full',
                added: ['b'],
                removed: [],
                members_hash: '63a9f7e2601177f08de4f4d0c02e233962a38b76debccf7e8feaaec8506230ca'
            }
        ]), null);
    });

    it('rejects a noncanonical full row or a full row with removals', function () {
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['b', 'a'],
                removed: [],
                members_hash: 'ab53c19f6f4880cd82e5a5b29cac877f591875be72245a2d8ec7711efc30e01a'
            }
        ]), null);
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a'],
                removed: ['b'],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            }
        ]), null);
    });

    it('rejects a delta refused by the membership canonical', function () {
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a'],
                removed: [],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            },
            {
                seq: 2,
                kind: 'delta',
                added: ['a'],
                removed: [],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            }
        ]), null);
    });

    it('rejects a membership hash mismatch at any step', function () {
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a'],
                removed: [],
                members_hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
            }
        ]), null);
        assert.strictEqual(foldListChain([
            {
                seq: 1,
                kind: 'full',
                added: ['a'],
                removed: [],
                members_hash: 'f7fd2deb118eab3e45e0131a47d3d6f6167ac5f3f3baa4311537b31b1e499883'
            },
            {
                seq: 2,
                kind: 'delta',
                added: ['b'],
                removed: [],
                members_hash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
            }
        ]), null);
    });
});
