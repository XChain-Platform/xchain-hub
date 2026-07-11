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
const bcmath     = require('../../src/bcmath.js');

describe('bcmath string formatting contract', function () {

    it('bcformat emits zero-padded fixed-decimal output', function () {
        expect(bcmath.bcformat('1.5', 8)).to.equal('1.50000000');
        expect(bcmath.bcformat('0', 4)).to.equal('0.0000');
    });

    it('bcstr emits minimal form, byte-matching the indexer utility.js bcstr', function () {
        // indexer bcstr = bcnum(num).toFixed(): no zero padding.
        expect(bcmath.bcstr('1.5')).to.equal('1.5');
        expect(bcmath.bcstr('1.50000000')).to.equal('1.5');
        expect(bcmath.bcstr('0')).to.equal('0');
        expect(bcmath.bcstr('100')).to.equal('100');
    });

    it('bcgt does exact string comparison past IEEE-754 precision', function () {
        expect(bcmath.bcgt('1.0000000000000000001', '1')).to.equal(true);
        expect(bcmath.bcgt('1', '1')).to.equal(false);
    });
});
