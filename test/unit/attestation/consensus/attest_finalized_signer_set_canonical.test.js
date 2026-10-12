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
const { selectFinalizedSigners } = require('../../../../src/attestation/consensus/finalized_signers.js');
const commit = require('../../../../src/attestation/consensus/commit.js');

function sigMap(order) {
    return new Map(order.map(pk => [pk, 'sig-' + pk]));
}

describe('finalized signer set is canonical', function () {
    it('returns the same set whatever order the signatures arrived in', function () {
        let a = selectFinalizedSigners(sigMap(['cc', 'aa', 'bb', 'dd']), 2);
        let b = selectFinalizedSigners(sigMap(['dd', 'bb', 'aa', 'cc']), 2);
        expect(a).to.deep.equal(b);
        expect(a.map(s => s.pubkey)).to.deep.equal(['aa', 'bb']);
    });

    it('emits exactly the needed count, never every held signature', function () {
        expect(selectFinalizedSigners(sigMap(['aa', 'bb', 'cc']), 2)).to.have.length(2);
    });

    it('returns all held signatures when fewer than needed', function () {
        expect(selectFinalizedSigners(sigMap(['bb', 'aa']), 5).map(s => s.pubkey)).to.deep.equal(['aa', 'bb']);
    });

    it('keeps each pubkey paired with its own signature', function () {
        let out = selectFinalizedSigners(sigMap(['bb', 'aa']), 2);
        out.forEach(s => expect(s.sig).to.equal('sig-' + s.pubkey));
    });

    it('checkCommitQuorum emits the canonical subset for two hubs with different arrivals', function () {
        function run(order) {
            let emitted = [];
            let pending = { finalized: false, quorum: 2, redundancy: 2, signatures: sigMap(order),
                            prepares: new Set(), commits: new Set(), status: 'ok' };
            let ctx = Object.create(commit);
            ctx.pending = new Map([['r', pending]]);
            ctx.settleFinalizedRound = () => {};
            ctx.emitFinalized = (rid, p, sigs) => emitted.push(sigs);
            ctx.earlyCommits = new Map();
            ctx.checkCommitQuorum('r');
            return emitted[0];
        }
        let h1 = run(['cc', 'aa', 'bb']);
        let h2 = run(['bb', 'cc', 'aa']);
        expect(h1).to.deep.equal(h2);
        expect(h1.map(s => s.pubkey)).to.deep.equal(['aa', 'bb']);
    });
});
