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

const registry = require('../../../../src/consensus/gate_registry.js');
const {
    listMetaHash,
    listSnapshotCanonical
} = require('../../../../src/cross_chain/list/canonical.js');

const siblingDocsDir = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-documentation');
const docsDirs = process.env.XCHAIN_DOCS_DIR
    ? [process.env.XCHAIN_DOCS_DIR, siblingDocsDir]
    : [siblingDocsDir];
const vectorPath = docsDirs
    .map(dir => path.resolve(dir, 'protocol', 'test-vectors', 'list_share.json'))
    .find(candidate => fs.existsSync(candidate));
assert.ok(vectorPath, 'list_share.json was not found in ' + docsDirs.join(' or '));
const vectors = require(vectorPath);

function vectorRow(entry) {
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
        meta_hash: entry.meta_hash,
        network: entry.network,
        admit_blocks: entry.admission
    };
}

describe('list meta hash vectors', function () {
    vectors.metaHashes.forEach(function (entry) {
        it('hashes metadata: ' + entry.label, function () {
            assert.strictEqual(listMetaHash(entry.name, entry.description), entry.expected);
        });
    });
});

describe('list meta signed canonical vectors', function () {
    vectors.metaCanonicals.forEach(function (entry) {
        it('builds gated signed bytes: ' + entry.name, function () {
            const originalActiveAt = registry.activeAt;
            const calls = [];
            registry.activeAt = function (...args) {
                calls.push(args);
                return true;
            };
            try {
                assert.strictEqual(
                    listSnapshotCanonical(vectorRow(entry), entry.view),
                    entry.expected
                );
            } finally {
                registry.activeAt = originalActiveAt;
            }
            assert.deepStrictEqual(calls, [[
                'list_meta_activation.LIST_META_ACTIVATION',
                entry.network,
                'BTC',
                entry.snapshot_block,
                null
            ]]);
        });
    });

    vectors.canonicals.forEach(function (entry) {
        it('keeps pre-gate signed bytes: ' + entry.name, function () {
            assert.strictEqual(
                listSnapshotCanonical(vectorRow(entry), entry.view),
                entry.expected
            );
        });
    });
});
