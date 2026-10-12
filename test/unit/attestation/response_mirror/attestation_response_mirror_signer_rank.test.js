'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The mirror's signer-set replace rule: the set with the lower rank vector in the
// round's responsible set wins, so hubs converge whatever order they hear sets in.

const { expect } = require('chai');
const { signerRankVector, isRankBetterSignerSet } = require('../../../../src/attestation/response_mirror/signer_rank.js');

const R = ['dd', 'bb', 'aa', 'cc'];

describe('mirror signer rank', () => {
    describe('signerRankVector', () => {
        it('lower-cases and returns ascending positions in the responsible set', () => {
            expect(signerRankVector(['AA', 'dd'], R)).to.deep.equal([0, 2]);
        });
        it('sorts positions whatever the input order', () => {
            expect(signerRankVector(['cc', 'bb'], R)).to.deep.equal([1, 3]);
        });
        it('is null when a pubkey is outside the set', () => {
            expect(signerRankVector(['dd', 'ee'], R)).to.equal(null);
        });
        it('is null when a pubkey repeats, case-insensitively', () => {
            expect(signerRankVector(['dd', 'dd'], R)).to.equal(null);
            expect(signerRankVector(['dd', 'DD'], R)).to.equal(null);
        });
        it('is null for non-array or non-string input', () => {
            expect(signerRankVector(null, R)).to.equal(null);
            expect(signerRankVector([1], R)).to.equal(null);
        });
    });

    describe('isRankBetterSignerSet', () => {
        const better = (a, b) => isRankBetterSignerSet(a, b, R, 2);
        it('the ledger sets {a,b} and {b,c} with a ranked first: {a,b} wins', () => {
            const r = ['aa', 'bb', 'cc'];
            expect(isRankBetterSignerSet(['aa', 'bb'], ['bb', 'cc'], r, 2)).to.equal(true);
            expect(isRankBetterSignerSet(['bb', 'cc'], ['aa', 'bb'], r, 2)).to.equal(false);
        });
        it('lower vector beats higher', () => {
            expect(better(['dd', 'bb'], ['bb', 'aa'])).to.equal(true);
        });
        it('higher vector loses', () => {
            expect(better(['bb', 'aa'], ['dd', 'bb'])).to.equal(false);
        });
        it('equal vectors are not better, whatever the order', () => {
            expect(better(['dd', 'bb'], ['bb', 'dd'])).to.equal(false);
        });
        it('a strict prefix is lower than the longer stored vector', () => {
            expect(better(['dd', 'bb'], ['dd', 'bb', 'aa'])).to.equal(true);
        });
        it('an incoming vector outside the set is never better', () => {
            expect(better(['dd', 'ee'], ['bb', 'aa'])).to.equal(false);
        });
        it('an incoming vector of the wrong size is never better', () => {
            expect(better(['dd'], ['bb', 'aa'])).to.equal(false);
            expect(better(['dd', 'bb', 'aa'], ['bb', 'aa'])).to.equal(false);
        });
        it('an incoming vector with a repeat is never better', () => {
            expect(better(['dd', 'dd'], ['bb', 'aa'])).to.equal(false);
        });
        it('a null stored vector loses to any valid incoming one', () => {
            expect(better(['bb', 'aa'], ['ee', 'aa'])).to.equal(true);
        });
        it('a null incoming vector loses to a null stored one', () => {
            expect(better(['ee', 'aa'], ['ff', 'aa'])).to.equal(false);
        });
    });
});
