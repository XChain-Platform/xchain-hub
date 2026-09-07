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
 **********************************************************************
 * canonical_price: the fail-closed price-spelling guard the oracle admission
 * gate runs, so what parseFloat admitted and what bcmath later reads cannot be
 * two different numbers.
 ********************************************************************/

'use strict';

const { expect }  = require('chai');
const bcmath      = require('../../src/bcmath.js');
const { canonicalPrice, isCanonicalPrice, PRICE_MAX_CHARS } =
    require('../../src/lib/canonical_price.js');

describe('canonical_price', function () {

    describe('canonicalPrice', function () {

        it('accepts what the honest price sources actually emit, unchanged', function () {
            // Both local sources emit bcmath.bcformat(value, 8): PriceFetcher._median
            // and XchainPriceSource._entry. Anything this rejects, an honest peer's
            // gossiped submission would be dropped for.
            for (const v of ['100000.00000000', '0.00000001', '90', '100001', '0.50000000']) {
                expect(canonicalPrice(v), 'rejected ' + v).to.equal(v);
                expect(isCanonicalPrice(v), 'rejected ' + v).to.equal(true);
            }
            expect(canonicalPrice(bcmath.bcformat('100000', 8))).to.equal('100000.00000000');
        });

        it('accepts a fixed-notation number and returns its decimal spelling', function () {
            expect(canonicalPrice(100)).to.equal('100');
            expect(canonicalPrice(100.5)).to.equal('100.5');
        });

        it('rejects the prefix-parsed spellings parseFloat admits', function () {
            // Each of these is a value parseFloat reads as a positive number while
            // bcmath.bcnum reads it as 0 (or as something else entirely).
            for (const v of ['100junk', '100 ', '100abc', '1.5e3x', '12,5']) {
                expect(canonicalPrice(v), 'accepted ' + v).to.equal(null);
                expect(parseFloat(v) > 0, 'no divergence to test for ' + v).to.equal(true);
            }
        });

        it('rejects every non-string, non-number scalar type', function () {
            for (const v of [null, undefined, true, false, {}, [], ['100'], 10n, () => 100]) {
                expect(canonicalPrice(v), 'accepted ' + String(v)).to.equal(null);
            }
            // parseFloat(['100']) is 100, which is how an array reached a coercing gate.
            expect(parseFloat(['100'])).to.equal(100);
        });

        it('rejects exponent, signed, whitespace and partial spellings', function () {
            for (const v of ['', ' 100', '100 ', '+100', '-1', '.5', '100.', '1e3', '0x64',
                             'NaN', 'Infinity', '1_000']) {
                expect(canonicalPrice(v), 'accepted ' + JSON.stringify(v)).to.equal(null);
            }
            for (const v of [NaN, Infinity, -Infinity, 1e-7, 1e21, -1]) {
                expect(canonicalPrice(v), 'accepted ' + String(v)).to.equal(null);
            }
        });

        it('refuses a spelling wider than the oracle_submissions.price column', function () {
            // VARCHAR(40): a longer value is truncated or refused on write, and a
            // truncated one is a third reading of the same submission.
            const wide = '0'.repeat(PRICE_MAX_CHARS) + '100.5';
            expect(wide.length).to.be.greaterThan(PRICE_MAX_CHARS);
            expect(parseFloat(wide)).to.equal(100.5);   // a coercing gate would admit it
            expect(canonicalPrice(wide)).to.equal(null);
            expect(canonicalPrice('1'.repeat(PRICE_MAX_CHARS))).to.equal('1'.repeat(PRICE_MAX_CHARS));
        });

        it('accepts nothing bcmath would read as a different number', function () {
            // The property the whole guard exists for: for every accepted spelling,
            // the parseFloat reading and the bcmath reading agree.
            for (const v of ['100000.00000000', '0.00000001', '90', '100', '100.5', '7.25']) {
                const canon = canonicalPrice(v);
                expect(canon, 'rejected ' + v).to.not.equal(null);
                expect(bcmath.isNumeric(canon), 'bcmath rejects ' + canon).to.equal(true);
                expect(Number(String(bcmath.bcnum(canon)))).to.equal(parseFloat(canon));
            }
            // And the counter-example, which is the defect: parseFloat says 100,
            // bcmath says 0, so admitting it puts two numbers in the round at once.
            expect(parseFloat('100junk')).to.equal(100);
            expect(String(bcmath.bcnum('100junk'))).to.equal('0');
            expect(canonicalPrice('100junk')).to.equal(null);
        });
    });
});
