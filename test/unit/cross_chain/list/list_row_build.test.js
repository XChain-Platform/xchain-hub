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

const { deriveListSnapshotId } = require('../../../../src/cross_chain/list/chain.js');
const {
    listOriginBlockFrom,
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

describe('shared-list row origin block', function () {
    it('subtracts the confirmation depth from either supported tip field', function () {
        assert.strictEqual(listOriginBlockFrom({ block_index: 120 }, 6), 114);
        assert.strictEqual(listOriginBlockFrom({ latest_block_index: 120 }, 6), 114);
        assert.strictEqual(listOriginBlockFrom({ block_index: null, latest_block_index: 120 }, 6),
            114);
    });

    it('uses one confirmation for a zero confirmation setting', function () {
        assert.strictEqual(listOriginBlockFrom({ block_index: 120 }, 0), 119);
    });

    it('returns null for unreadable and nonpositive confirmed heights', function () {
        assert.strictEqual(listOriginBlockFrom({ block_index: 6 }, 6), null);
        assert.strictEqual(listOriginBlockFrom(null, 6), null);
        assert.strictEqual(listOriginBlockFrom({}, 6), null);
        assert.strictEqual(listOriginBlockFrom({ block_index: 'not-a-block' }, 6), null);
    });
});

describe('shared-list snapshot row builder', function () {
    function build(version) {
        return buildListSnapshotRow({
            version,
            network: 'regtest',
            homeChain: 'DOGE',
            homeListIndex: '7',
            snapshotBlock: '500'
        });
    }

    function assertCommonRow(row, version) {
        assert.deepStrictEqual(Object.keys(row).sort(), ROW_KEYS);
        assert.strictEqual(row.snapshot_id,
            deriveListSnapshotId('regtest', 'DOGE', '7', version.seq, '500'));
        assert.strictEqual(row.snapshot_block, 500);
        assert.strictEqual(row.network, 'regtest');
        assert.strictEqual(row.home_chain, 'DOGE');
        assert.strictEqual(row.home_list_index, 7);
        assert.strictEqual(row.list_type, Number(version.list_type));
        assert.strictEqual(row.seq, Number(version.seq));
        assert.strictEqual(row.kind, version.kind);
        assert.strictEqual(row.added, JSON.stringify(version.added));
        assert.strictEqual(row.removed, JSON.stringify(version.removed));
        assert.strictEqual(row.members_hash, version.members_hash);
        assert.strictEqual(row.origin_block, Number(version.origin_block));
    }

    it('builds the exact twelve-column row for a full version', function () {
        const version = {
            list_type: '1',
            seq: '1',
            kind: 'full',
            added: ['a', 'b'],
            removed: [],
            members_hash: 'a'.repeat(64),
            origin_block: '114'
        };

        assertCommonRow(build(version), version);
    });

    it('builds the exact twelve-column row for a delta version', function () {
        const version = {
            list_type: 2,
            seq: 2,
            kind: 'delta',
            added: ['c'],
            removed: ['a'],
            members_hash: 'f'.repeat(64),
            origin_block: 120
        };

        assertCommonRow(build(version), version);
    });

    it('throws when the version or either member array is invalid', function () {
        assert.throws(() => buildListSnapshotRow({}), TypeError);
        assert.throws(() => build({ added: [], removed: null }), TypeError);
        assert.throws(() => build({ added: null, removed: [] }), TypeError);
    });
});
