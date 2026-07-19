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
const { bftQuorum, bftQuorumOrSingle } = require('../../src/lib/bft_quorum.js');

// The pre-extraction inline expression, hand-copied at ~15 consensus sites.
// The whole point of the extraction  is that bftQuorum must reproduce
// THIS exactly, for every N, or a divergent copy forks the chain.
function legacyInline(n){
    return Math.max(2 * Math.floor((n - 1) / 3) + 1, Math.ceil((n + 1) / 2));
}

describe('lib/bft_quorum ( count-quorum extraction)', () => {
    it('reproduces the legacy inline formula for every N in 2..5000', () => {
        for(let n = 2; n <= 5000; n++){
            expect(bftQuorum(n), `bftQuorum(${n})`).to.equal(legacyInline(n));
        }
    });

    it('pins the known BFT thresholds', () => {
        // n=2/3 floor to a simple majority of 2 (bare 2f+1 would be 1); larger
        // sets follow max(2*floor((n-1)/3)+1, ceil((n+1)/2)).
        const expected = {
            2: 2, 3: 2, 4: 3, 5: 3, 6: 4, 7: 5, 8: 5, 9: 5,
            10: 7, 13: 9, 16: 11, 19: 13, 100: 67, 300: 199,
        };
        for(const [n, q] of Object.entries(expected)){
            expect(bftQuorum(Number(n)), `n=${n}`).to.equal(q);
        }
    });

    it('never lets a single validator finalize a multi-node round (quorum >= majority)', () => {
        for(let n = 2; n <= 1000; n++){
            expect(bftQuorum(n)).to.be.at.least(Math.ceil((n + 1) / 2));
            expect(bftQuorum(n)).to.be.at.most(n);   // reachable: never more than the whole set
        }
    });

    it('bftQuorumOrSingle folds in the caller-chosen single-node value at N<=1', () => {
        // 0 = "no peer to reach, caller bypasses"; 1 = "self-sign is the quorum".
        expect(bftQuorumOrSingle(0, 0)).to.equal(0);
        expect(bftQuorumOrSingle(1, 0)).to.equal(0);
        expect(bftQuorumOrSingle(0, 1)).to.equal(1);
        expect(bftQuorumOrSingle(1, 1)).to.equal(1);
        // negative / degenerate N also takes the single-node branch (never NaN).
        expect(bftQuorumOrSingle(-3, 0)).to.equal(0);
    });

    it('bftQuorumOrSingle matches bftQuorum for N>=2 regardless of the single-node value', () => {
        for(let n = 2; n <= 500; n++){
            expect(bftQuorumOrSingle(n, 0)).to.equal(bftQuorum(n));
            expect(bftQuorumOrSingle(n, 1)).to.equal(bftQuorum(n));
        }
    });
});
