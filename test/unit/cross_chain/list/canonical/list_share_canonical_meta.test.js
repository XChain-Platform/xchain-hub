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
const fs = require('fs');
const path = require('path');

const {
    listSnapshotCanonical
} = require('../../../../../src/cross_chain/list/canonical.js');

const siblingDocsDir = path.join(
    __dirname, '..', '..', '..', '..', '..', '..', 'xchain-documentation'
);
const docsDirs = process.env.XCHAIN_DOCS_DIR
    ? [process.env.XCHAIN_DOCS_DIR, siblingDocsDir]
    : [siblingDocsDir];
const vectorPath = docsDirs
    .map(dir => path.resolve(dir, 'protocol', 'test-vectors', 'list_share.json'))
    .find(candidate => fs.existsSync(candidate));
assert.ok(vectorPath, 'list_share.json was not found in ' + docsDirs.join(' or '));
const vectors = require(vectorPath);

function rowFromVector(entry) {
    return {
        snapshot_id: entry.snapshot_id,
        snapshot_block: entry.snapshot_block,
        home_chain: entry.home_chain,
        home_list_index: entry.home_list_index,
        list_type: entry.list_type,
        seq: entry.seq,
        kind: entry.kind,
        origin_block: entry.origin_block,
        members_hash: entry.members_hash,
        network: entry.network,
        admit_blocks: entry.admission,
        added: entry.added,
        removed: entry.removed,
        meta_hash: entry.meta_hash
    };
}

describe('list share metadata signed canonical vectors', function () {
    vectors.metaCanonicals.forEach(function (entry) {
        it('builds gated signed bytes: ' + entry.name, function () {
            const row = rowFromVector(entry);
            assert.strictEqual(
                listSnapshotCanonical(row, entry.view, () => true),
                entry.expected
            );
        });
    });

    it('appends an empty field when gated metadata is absent', function () {
        const entry = vectors.metaCanonicals.find(vector => vector.meta_hash === '');
        assert.ok(entry, 'missing canonical vector without metadata');
        assert.ok(listSnapshotCanonical(rowFromVector(entry), entry.view, () => true).endsWith('|'));
    });
});

describe('list share legacy signed canonical vectors', function () {
    vectors.canonicals.forEach(function (entry) {
        it('preserves signed bytes without an active metadata gate: ' + entry.name, function () {
            const row = rowFromVector(entry);
            assert.strictEqual(
                listSnapshotCanonical(row, entry.view, () => false),
                entry.expected
            );
            // Testnet block 160000 sits above the v0.21.3 LIST_META height, so the
            // registry default now takes the metadata form.
            assert.strictEqual(listSnapshotCanonical(row, entry.view), listSnapshotCanonical(row, entry.view, () => true));
        });
    });
});

describe('list share metadata gate reader', function () {
    it('receives snapshot block and network', function () {
        const entry = vectors.metaCanonicals[0];
        const calls = [];
        const reader = function (...args) {
            calls.push(args);
            return true;
        };

        listSnapshotCanonical(rowFromVector(entry), entry.view, reader);

        assert.deepStrictEqual(calls, [[entry.snapshot_block, entry.network]]);
    });
});
