/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - http_get attestation provider tests (byte_equality agree)
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const httpGet    = require('../../src/providers/http_get.js');

function p(body, meta){ return { body: Buffer.from(body, 'utf8'), meta: String(meta || '200') }; }

describe('http_get.agree — byte_equality', function () {

    it('returns null on empty input', function () {
        expect(httpGet.agree([])).to.be.null;
        expect(httpGet.agree(null)).to.be.null;
        expect(httpGet.agree(undefined)).to.be.null;
    });

    it('returns the single proposal trivially (N=1, quorum=1)', function () {
        const result = httpGet.agree([p('hello', '200')]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('hello');
        expect(result.meta).to.equal('200');
    });

    it('returns the unanimous body when all N proposals match (N=3)', function () {
        const result = httpGet.agree([p('x', '200'), p('x', '200'), p('x', '200')]);
        expect(result.body.toString()).to.equal('x');
    });

    it('returns the majority body when 2 of 3 agree (simple-majority quorum=2 at N=3; 2-of-3 meets it)', function () {
        const result = httpGet.agree([p('A', '200'), p('A', '200'), p('B', '500')]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('A');
    });

    it('returns null on a 3-way split at N=3 (each body count=1 < quorum=2)', function () {
        // Regression guard for the quorum=1 defect: under the old BFT formula
        // 2*floor((N-1)/3)+1 this yielded quorum=1 at N=3, so the first-inserted
        // group won with count=1 and a single divergent body became canonical.
        // Simple-majority quorum = ceil((3+1)/2) = 2, so a total 3-way split has
        // no majority and MUST return null. If this ever returns non-null the
        // REDUNDANCY=3 consensus guarantee has been silently reverted.
        const result = httpGet.agree([p('A', '200'), p('B', '404'), p('C', '500')]);
        expect(result).to.be.null;
    });

    it('returns null when no body meets quorum at N=5 (3-way split with 2-2-1)', function () {
        // N=5, quorum = ceil((5+1)/2) = 3. Max group is 2; below quorum.
        const result = httpGet.agree([
            p('A', '200'), p('A', '200'),
            p('B', '200'), p('B', '200'),
            p('C', '500')
        ]);
        expect(result).to.be.null;
    });

    it('returns the majority body when 3-of-5 agree at N=5 (meets quorum=3)', function () {
        const result = httpGet.agree([
            p('A', '200'), p('A', '200'), p('A', '200'),
            p('B', '200'), p('C', '500')
        ]);
        expect(result.body.toString()).to.equal('A');
    });

    it('treats different META as different groups even when body matches', function () {
        // {body=A, meta=200} vs {body=A, meta=500} are different groups under byte_equality
        const result = httpGet.agree([
            p('A', '200'),
            p('A', '500'),
            p('A', '500')
        ]);
        // At N=3, quorum=2; the largest group is {A,500} with count=2, which meets it.
        expect(result).to.not.be.null;
        expect(result.meta).to.equal('500');
    });

    it('ignores proposals with non-Buffer body', function () {
        // Two valid matching proposals form a majority (count=2 >= quorum=2 at N=3);
        // the non-Buffer entry is skipped during grouping and does not corrupt the result.
        const result = httpGet.agree([
            { body: 'not a buffer', meta: '200' },  // ignored
            p('valid', '200'),
            p('valid', '200')
        ]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('valid');
    });

    // The AttestationSpotChecker compares a published body against the expected
    // pattern by calling agree() with exactly two proposals (N=2). Under the old
    // BFT formula quorum was 1, so a published/expected MISMATCH still produced a
    // winner and the spot-check silently passed. Simple-majority quorum at N=2 is
    // ceil((2+1)/2) = 2, so both must agree for the check to pass.
    it('requires both proposals to agree at N=2 (spot-check path)', function () {
        const match    = httpGet.agree([p('same', '200'), p('same', '200')]);
        expect(match).to.not.be.null;
        expect(match.body.toString()).to.equal('same');

        const mismatch = httpGet.agree([p('published', '200'), p('expected', '200')]);
        expect(mismatch).to.be.null;
    });

});
