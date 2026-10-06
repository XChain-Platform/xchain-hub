/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const hub = require('../../../../src/cross_chain/list/meta_text.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const INDEXER_ROOT = process.env.XCHAIN_INDEXER_PATH
    || path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer');
const INDEXER_COPY = path.join(
    INDEXER_ROOT, 'src', 'actions', 'deploy', 'contract_meta', 'meta_text.js'
);

function range(first, last) {
    return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

const BANNED_CODE_POINTS = [
    ...range(0x00, 0x1F),
    ...range(0x7F, 0x9F),
    ...range(0x200B, 0x200F),
    ...range(0x202A, 0x202E),
    0x2060,
    ...range(0x2066, 0x2069),
    0xFEFF
];

const EDGE_CODE_POINTS = [
    0x0A,
    0x20,
    0xA0,
    0x1680,
    ...range(0x2000, 0x200A),
    0x2028,
    0x2029,
    0x202F,
    0x205F,
    0x3000
];

function placements(ch) {
    return [ch, 'a' + ch + 'a', ch + 'a', 'a' + ch];
}

function assertParity(indexer, value, maxBytes, allowLf, label) {
    assert.strictEqual(
        hub.isValidMetaText(value, maxBytes, allowLf),
        indexer.isValidMetaText(value, maxBytes, allowLf),
        label
    );
}

describe('list meta text grammar parity with xchain-indexer', function () {
    let indexer;

    before(function () {
        if (!skipOrFail(this, siblingCheckout(__dirname, INDEXER_COPY), 'the indexer meta text twin guard')) {
            return;
        }
        indexer = require(INDEXER_COPY);
    });

    it('agrees on every banned and edge code point in every placement', function () {
        const codePoints = [...new Set(BANNED_CODE_POINTS.concat(EDGE_CODE_POINTS))];
        const placementNames = ['alone', 'interior', 'leading', 'trailing'];

        for (const codePoint of codePoints) {
            const label = 'U+' + codePoint.toString(16).toUpperCase().padStart(4, '0');
            placements(String.fromCodePoint(codePoint)).forEach(function (value, placement) {
                for (const allowLf of [false, true]) {
                    assertParity(
                        indexer,
                        value,
                        512,
                        allowLf,
                        label + ' ' + placementNames[placement] + ' allowLf=' + allowLf
                    );
                }
            });
        }
    });

    it('agrees at the 64-byte and 512-byte caps', function () {
        for (const cap of [64, 512]) {
            for (const ch of ['a', '\u{1F600}']) {
                const atCap = ch.repeat(cap / Buffer.byteLength(ch, 'utf8'));
                assertParity(indexer, atCap, cap, false, cap + '-byte cap');
                assertParity(indexer, atCap + ch, cap, false, cap + '-byte overflow');
            }
        }
    });

    it('agrees on an interior line feed with allowLf false and true', function () {
        assertParity(indexer, 'a\nb', 512, false, 'interior LF allowLf=false');
        assertParity(indexer, 'a\nb', 512, true, 'interior LF allowLf=true');
    });

    it('agrees on a lone surrogate', function () {
        assertParity(indexer, '\uD800', 64, false, 'lone surrogate');
    });
});
