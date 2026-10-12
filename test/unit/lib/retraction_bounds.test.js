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

const { expect } = require('chai');
const { normalizeRetractionBounds, parseIndex } = require('../../../src/lib/retraction_bounds');

describe('parseIndex', function () {
    it('accepts safe integer numbers and trimmed numeric strings', function () {
        expect(parseIndex(42)).to.equal(42);
        expect(parseIndex(' 42 ')).to.equal(42);
    });

    it('rejects values that cannot represent a safe integer', function () {
        const invalid = ['', '   ', 'not-a-number', NaN,
            Number.MAX_SAFE_INTEGER + 1.5, { value: 7 }];

        for (const value of invalid) expect(parseIndex(value)).to.equal(null);
    });
});

describe('normalizeRetractionBounds', function () {
    it('leaves omitted bounds open and unfenced', function () {
        expect(normalizeRetractionBounds(3, undefined, undefined)).to.deep.equal({
            from: 3, to: null, gen: null, bounded: false, fenced: false
        });
        expect(normalizeRetractionBounds(3, null, null)).to.deep.equal({
            from: 3, to: null, gen: null, bounded: false, fenced: false
        });
    });

    it('normalizes a supplied valid triple', function () {
        expect(normalizeRetractionBounds(' 3 ', ' 8 ', ' 2 ')).to.deep.equal({
            from: 3, to: 8, gen: 2, bounded: true, fenced: true
        });
    });

    it('rejects a negative or unparseable lower bound', function () {
        expect(normalizeRetractionBounds(-1, 8, 2)).to.deep.equal({
            error: 'invalid from_action_index'
        });
        expect(normalizeRetractionBounds('invalid', 8, 2)).to.deep.equal({
            error: 'invalid from_action_index'
        });
    });

    it('rejects an upper bound below the lower bound', function () {
        expect(normalizeRetractionBounds(8, 7, 2)).to.deep.equal({
            error: 'invalid to_action_index'
        });
    });

    it('rejects a negative or unparseable generation', function () {
        expect(normalizeRetractionBounds(3, 8, -1)).to.deep.equal({
            error: 'invalid retraction_generation'
        });
        expect(normalizeRetractionBounds(3, 8, 'invalid')).to.deep.equal({
            error: 'invalid retraction_generation'
        });
    });
});
