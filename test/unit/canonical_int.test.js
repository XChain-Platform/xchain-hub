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
 * canonical_int: the fail-closed spelling guard three consensus engines run
 * before signing a leader's row (#4204).
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { isCanonicalInt, allCanonicalInts } = require('../../src/lib/canonical_int.js');

describe('canonical_int', function () {

    describe('isCanonicalInt', function () {

        it('accepts the spelling every verifier re-derives, as a number or a string', function () {
            for (const v of [0, 1, 41, -7, 50000, Number.MAX_SAFE_INTEGER]) {
                expect(isCanonicalInt(v), 'rejected number ' + v).to.equal(true);
                expect(isCanonicalInt(String(v)), 'rejected string ' + v).to.equal(true);
            }
            // A BIGINT-sized value only a string can carry losslessly.
            expect(isCanonicalInt('18446744073709551615')).to.equal(true);
        });

        it('rejects every equivalent spelling a BIGINT round-trip would normalize away', function () {
            // These all satisfy Number(a) === Number(b) against the canonical form, which
            // is exactly why the Number()-based follower checks let them through.
            for (const v of ['041', '0041', '+41', ' 41', '41 ', '4.1e1', '41.0', '0x29', '-0', '-007', '4_1', '']) {
                expect(isCanonicalInt(v), 'accepted noncanonical spelling ' + JSON.stringify(v)).to.equal(false);
            }
        });

        it('rejects a value that is not an integer at all', function () {
            for (const v of [4.1, NaN, Infinity, -Infinity, null, undefined, true, false, {}, [], [41]]) {
                expect(isCanonicalInt(v), 'accepted non-integer ' + JSON.stringify(v)).to.equal(false);
            }
        });

        it('rejects a number past MAX_SAFE_INTEGER rather than signing digits it already lost', function () {
            // The BIGINT column keeps the digits JSON's number type has already rounded
            // off, so String(v) here and String(row.field) after persistence differ.
            expect(isCanonicalInt(Number.MAX_SAFE_INTEGER + 2)).to.equal(false);
            expect(isCanonicalInt(1e21)).to.equal(false);
        });

        it('checks the RAW spelling, never Number(v)', function () {
            // Number('041') === 41 and Number('41') === 41, so a guard that coerced first
            // could not tell these apart - which is the whole defect.
            expect(Number('041')).to.equal(Number('41'));
            expect(isCanonicalInt('041')).to.equal(false);
            expect(isCanonicalInt('41')).to.equal(true);
        });
    });

    describe('allCanonicalInts', function () {

        it('passes only when every named field is canonical', function () {
            const row = { a: 41, b: '5', c: 0 };
            expect(allCanonicalInts(row, ['a', 'b', 'c'])).to.equal(true);
            expect(allCanonicalInts(Object.assign({}, row, { b: '05' }), ['a', 'b', 'c'])).to.equal(false);
        });

        it('fails closed on a field the row does not carry at all', function () {
            // An absent field signs the literal 'undefined' or, behind a `|| 0`, persists
            // as 0: the same divergence with none of the digits.
            expect(allCanonicalInts({ a: 41 }, ['a', 'missing'])).to.equal(false);
            expect(allCanonicalInts(null, ['a'])).to.equal(false);
        });
    });
});
