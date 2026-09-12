'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The FULLNODE block's comment must cite no filename that exists in no public
// repo, and must say the tier is deliberately pre-activation. This
// behaviourally checks the canonical hub source: every doc
// the comment cites must actually resolve on disk, the bare stale filename must
// be gone, and the pre-activation framing must be present in the source text
// (not just asserted by a human reading it once). Byte-identity of the vendored
// copies in node/indexer/decoder is covered separately by each consumer's own
// coins-conformance.test.js.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SRC_TEXT  = fs.readFileSync(path.join(__dirname, 'BTC.js'), 'utf8');

// Pull just the FULLNODE block's leading comment so the assertions are scoped
// to the block this item is about, not incidental text elsewhere in the file.
function fullnodeCommentBlock(text) {
    const idx = text.indexOf('FULLNODE: {');
    assert.notStrictEqual(idx, -1, 'FULLNODE block not found in BTC.js');
    const before = text.slice(0, idx);
    const lines = before.split('\n');
    const commentLines = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line === '' || line.startsWith('//')) {
            if (line !== '') commentLines.unshift(line);
        } else {
            break;
        }
    }
    return commentLines.join('\n');
}

describe('FULLNODE canonical comment', function () {
    const block = fullnodeCommentBlock(SRC_TEXT);

    it('does not cite the stale bare NODEPROOF.md filename', function () {
        assert.ok(!/(?<!\/)\bNODEPROOF\.md\b/.test(block),
            `expected no bare "NODEPROOF.md" citation, got:\n${block}`);
    });

    it('cites doc paths that resolve inside xchain-documentation', function () {
        const docPaths = [...block.matchAll(/xchain-documentation\/[^\s,]+\.md/g)].map(m => m[0]);
        assert.ok(docPaths.length >= 2, `expected at least 2 doc citations, got ${docPaths.length}`);
        for (const rel of docPaths) {
            const abs = path.join(REPO_ROOT, rel);
            assert.ok(fs.existsSync(abs), `cited doc does not exist on disk: ${rel}`);
        }
    });

    it('states the tier is deliberately pre-activation', function () {
        assert.ok(/pre-activation/i.test(block),
            `expected the comment to say the tier is pre-activation, got:\n${block}`);
    });
});
