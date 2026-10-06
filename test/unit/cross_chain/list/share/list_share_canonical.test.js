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
    deriveListSnapshotId,
    listSnapshotCanonical
} = require('../../../../../src/cross_chain/list/canonical.js');

const siblingDocsDir = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'xchain-documentation');
const docsDirs = process.env.XCHAIN_DOCS_DIR
    ? [process.env.XCHAIN_DOCS_DIR, siblingDocsDir]
    : [siblingDocsDir];
const vectorPath = docsDirs
    .map(dir => path.resolve(dir, 'protocol', 'test-vectors', 'list_share.json'))
    .find(candidate => fs.existsSync(candidate));
assert.ok(vectorPath, 'list_share.json was not found in ' + docsDirs.join(' or '));
const vectors = require(vectorPath);

describe('list share snapshot id vectors', function () {
    vectors.snapshotIds.forEach(function (entry) {
        it('derives snapshot id: ' + entry.name, function () {
            assert.strictEqual(
                deriveListSnapshotId(
                    entry.network,
                    entry.homeChain,
                    entry.homeListIndex,
                    entry.seq,
                    entry.snapshotBlock
                ),
                entry.expected
            );
        });
    });
});

describe('list share signed canonical vectors', function () {
    vectors.canonicals.forEach(function (entry) {
        it('builds signed bytes: ' + entry.name, function () {
            const row = {
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
                removed: entry.removed
            };
            // The vectors are the legacy (pre LIST_META) form; their testnet block 160000 sits
            // above the v0.21.3 LIST_META height, so the gate reader is pinned off here.
            assert.strictEqual(listSnapshotCanonical(row, entry.view, () => false), entry.expected);
        });
    });
});

describe('list share signed canonical boundaries', function () {
    it('requires admission bytes and excludes member arrays from signed bytes', function () {
        const entry = vectors.canonicals[1];
        const row = {
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
            added: ['not-signed'],
            removed: ['also-not-signed']
        };
        assert.strictEqual(listSnapshotCanonical(row, entry.view, () => false), entry.expected);
        assert.throws(
            () => listSnapshotCanonical(Object.assign({}, row, { admit_blocks: null }), entry.view, () => false),
            /must carry an admission map/
        );
    });
});
