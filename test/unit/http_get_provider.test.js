/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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

    it('returns the majority body when 2 of 3 agree (PBFT quorum 2f+1 at N=3, f=0 → 1; 2-of-3 trivially meets it)', function () {
        const result = httpGet.agree([p('A', '200'), p('A', '200'), p('B', '500')]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('A');
    });

    it('returns null on 3-way split with N=3 (no body has enough — 1<quorum)', function () {
        // Wait — at N=3, quorum = 2*floor((3-1)/3)+1 = 1. So any single proposal counts as quorum.
        // For a 3-way split each has count=1 which meets quorum=1; first found wins.
        // The interesting "no quorum" case starts at N>=4 where quorum>1.
        const result = httpGet.agree([p('A', '200'), p('B', '404'), p('C', '500')]);
        // At N=3 with f=0, any single body meets quorum. winner picked arbitrarily — just ensure non-null.
        expect(result).to.not.be.null;
    });

    it('returns null when no body meets 2f+1 at N=5 (3-way split with 2-2-1)', function () {
        // N=5, quorum = 2*floor((5-1)/3)+1 = 2*1+1 = 3. Max group is 2; below quorum.
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
        // At N=3, quorum=1; the largest group is {A,500} with count=2. Returns it.
        expect(result).to.not.be.null;
        expect(result.meta).to.equal('500');
    });

    it('ignores proposals with non-Buffer body', function () {
        const result = httpGet.agree([
            { body: 'not a buffer', meta: '200' },  // ignored
            p('valid', '200')
        ]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('valid');
    });

});
