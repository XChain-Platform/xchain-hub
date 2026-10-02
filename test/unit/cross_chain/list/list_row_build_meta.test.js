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
    buildListSnapshotRow
} = require('../../../../src/cross_chain/list/row_build.js');

const ROW_KEYS = [
    'snapshot_id',
    'snapshot_block',
    'network',
    'home_chain',
    'home_list_index',
    'list_type',
    'seq',
    'kind',
    'added',
    'removed',
    'members_hash',
    'origin_block'
].sort();

function version(fields = {}) {
    return {
        list_type: '1',
        seq: '1',
        kind: 'full',
        added: ['a'],
        removed: [],
        members_hash: 'a'.repeat(64),
        origin_block: '114',
        ...fields
    };
}

function build(fields) {
    return buildListSnapshotRow({
        version: version(fields),
        network: 'regtest',
        homeChain: 'DOGE',
        homeListIndex: '7',
        snapshotBlock: '500'
    });
}

describe('shared-list snapshot row metadata', function () {
    it('keeps the exact current row keys when the metadata hash is absent or null', function () {
        assert.deepStrictEqual(Object.keys(build()).sort(), ROW_KEYS);
        assert.deepStrictEqual(Object.keys(build({ meta_hash: null })).sort(), ROW_KEYS);
    });

    it('copies metadata when the metadata hash is a 64-character string', function () {
        const row = build({
            description: 'Weekly source',
            meta_hash: 'b'.repeat(64)
        });

        assert.deepStrictEqual(Object.keys(row).sort(), [
            ...ROW_KEYS,
            'name',
            'description',
            'meta_hash'
        ].sort());
        assert.strictEqual(row.name, null);
        assert.strictEqual(row.description, 'Weekly source');
        assert.strictEqual(row.meta_hash, 'b'.repeat(64));
    });

    it('copies metadata for an empty-string hash and reads an absent description as null',
        function () {
            const row = build({ name: 'Allowlist', meta_hash: '' });

            assert.strictEqual(row.name, 'Allowlist');
            assert.strictEqual(row.description, null);
            assert.strictEqual(row.meta_hash, '');
        });
});
