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
    listMembersHash,
    listDelta,
    applyListDelta
} = require('../../../../src/cross_chain/list/canonical.js');
const {
    LIST_SHARE_MAX_MEMBERS
} = require('../../../../src/cross_chain/list/constants.js');

const siblingDocsDir = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-documentation');
const docsDirs = process.env.XCHAIN_DOCS_DIR
    ? [process.env.XCHAIN_DOCS_DIR, siblingDocsDir]
    : [siblingDocsDir];
const vectorPath = docsDirs
    .map(dir => path.resolve(dir, 'protocol', 'test-vectors', 'list_share.json'))
    .find(candidate => fs.existsSync(candidate));
const vectors = vectorPath ? require(vectorPath) : null;

describe('list share membership vectors', function () {
    before(function () {
        if (!vectors) {
            console.log('Skipping list share membership vectors: list_share.json was not found in ' + docsDirs.join(' or '));
            this.skip();
        }
    });

    it('pins the maximum member count', function () {
        assert.strictEqual(LIST_SHARE_MAX_MEMBERS, 10000);
    });

    (vectors ? vectors.membersHash : []).forEach(function (entry) {
        it('hashes members: ' + entry.name, function () {
            assert.strictEqual(listMembersHash(entry.members), entry.expected);
        });
    });

    (vectors ? vectors.deltas : []).forEach(function (entry) {
        it('computes and applies delta: ' + entry.name, function () {
            assert.deepStrictEqual(listDelta(entry.prev, entry.next), {
                added: entry.added,
                removed: entry.removed
            });
            assert.deepStrictEqual(
                applyListDelta(entry.prev, entry.added, entry.removed),
                entry.next
            );
        });
    });

    (vectors ? vectors.nonStrictDeltas : []).forEach(function (entry) {
        it('rejects non-strict delta: ' + entry.name, function () {
            assert.strictEqual(
                applyListDelta(entry.prev, entry.added, entry.removed),
                null
            );
        });
    });
});
