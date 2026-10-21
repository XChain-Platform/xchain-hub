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
const { computeQuorumMargin } = require('../../../../src/oracle/quorum_margin.js');

function vals(weights){
    return weights.map((w, i) => ({ pubkey: 'pk' + i, source: 's' + i, weight: String(w) }));
}
function keys(...idx){ return idx.map(i => 'pk' + i); }

describe('oracle quorum margin', function(){
    describe('count mode', function(){
        it('is one-fault tolerant with a signer to spare', function(){
            let r = computeQuorumMargin({ weighted: false, validators: vals([1,1,1,1]), signers: keys(0,1,2,3) });
            expect(r).to.include({ mode: 'count', quorum: 3, met: true, oneFaultTolerant: true });
        });
        it('is not one-fault tolerant at exactly quorum', function(){
            let r = computeQuorumMargin({ weighted: false, validators: vals([1,1,1,1]), signers: keys(0,1,2) });
            expect(r).to.include({ met: true, oneFaultTolerant: false });
        });
        it('reports an unmet quorum as not tolerant', function(){
            let r = computeQuorumMargin({ weighted: false, validators: vals([1,1,1,1]), signers: keys(0,1) });
            expect(r).to.include({ met: false, oneFaultTolerant: false });
        });
        it('counts a repeated signer once', function(){
            let r = computeQuorumMargin({ weighted: false, validators: vals([1,1,1,1]), signers: ['pk0','pk0','pk1','pk2'] });
            expect(r.signers).to.equal(3);
            expect(r.oneFaultTolerant).to.equal(false);
        });
    });

    describe('stake mode', function(){
        it('is tolerant when no single source is load bearing', function(){
            let r = computeQuorumMargin({ weighted: true, validators: vals([10,10,10,10,10]), signers: keys(0,1,2,3,4) });
            expect(r).to.include({ mode: 'stake', met: true, oneFaultTolerant: true });
        });
        it('is not tolerant when one heavy source carries the threshold', function(){
            let r = computeQuorumMargin({ weighted: true, validators: vals([70,10,10,10]), signers: keys(0,1) });
            expect(r).to.include({ met: true, oneFaultTolerant: false });
        });
        it('fails closed when the threshold is unmet', function(){
            let r = computeQuorumMargin({ weighted: true, validators: vals([10,10,10]), signers: keys(0,1) });
            expect(r).to.include({ met: false, oneFaultTolerant: false });
        });
        it('fails closed on a truncated snapshot', function(){
            let v = vals([10,10,10,10,10]); v.truncated = true;
            let r = computeQuorumMargin({ weighted: true, validators: v, signers: keys(0,1,2,3,4) });
            expect(r).to.include({ met: false, oneFaultTolerant: false });
        });
        it('treats a source with several keys as one fault unit', function(){
            let v = [
                { pubkey: 'a1', source: 'A', weight: '40' }, { pubkey: 'a2', source: 'A', weight: '40' },
                { pubkey: 'b', source: 'B', weight: '30' }, { pubkey: 'c', source: 'C', weight: '30' },
            ];
            let r = computeQuorumMargin({ weighted: true, validators: v, signers: ['a1','a2','b','c'] });
            expect(r).to.include({ met: true, oneFaultTolerant: false });
        });
    });
});
