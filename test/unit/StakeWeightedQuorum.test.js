'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const swq = require('../../src/stake_weighted_quorum.js');

// CONSENSUS-CRITICAL: this predicate decides every cross-chain settlement under
// STAKE_WEIGHTED_QUORUM. The indexer keeps a byte-equivalent copy
// (xchain-indexer/src/stake_weighted_quorum.js) — the cross-service regression
// suite asserts they agree.
describe('stake_weighted_quorum', function () {

    // S1 = 6000 across TWO keys (a, b) — one staking source, additive DELEGATE.
    // S2 = 3000 (c), S3 = 3000 (d). Total S = 12000.
    const V = [
        { pubkey: 'a', source: 'S1', weight: '6000' },
        { pubkey: 'b', source: 'S1', weight: '6000' },
        { pubkey: 'c', source: 'S2', weight: '3000' },
        { pubkey: 'd', source: 'S3', weight: '3000' },
    ];

    describe('meetsStakeThreshold', function () {

        it('returns false for an empty signer set', function () {
            expect(swq.meetsStakeThreshold(V, [])).to.equal(false);
        });

        it('SECURITY: a source\'s multiple keys count its stake ONCE (no delegation inflation)', function () {
            // a + b are both S1 → 6000, not 12000. 3·6000 = 18000 !> 2·12000 = 24000.
            expect(swq.meetsStakeThreshold(V, ['a', 'b'])).to.equal(false);
        });

        it('exactly 2/3 of stake is NOT enough (strictly greater required)', function () {
            // Two equal sources of 3750 each, S = 7500; one source = exactly 2/3? No —
            // use P=5000 of S=7500 = 2/3 exactly → false.
            const D = [
                { pubkey: 'p', source: 'P', weight: '5000.00000000' },
                { pubkey: 'q', source: 'Q', weight: '2500.00000000' },
            ];
            expect(swq.meetsStakeThreshold(D, ['p'])).to.equal(false);     // 3·5000 = 15000 !> 2·7500 = 15000
            expect(swq.meetsStakeThreshold(D, ['p', 'q'])).to.equal(true);
        });

        it('strictly more than 2/3 finalizes', function () {
            // S1 + S2 = 9000 of 12000 = 3/4. 3·9000 = 27000 > 24000.
            expect(swq.meetsStakeThreshold(V, ['a', 'c'])).to.equal(true);
        });

        it('counts a source once even when several of its keys sign, plus another source', function () {
            expect(swq.meetsStakeThreshold(V, ['a', 'b', 'c'])).to.equal(true); // 6000 + 3000
        });

        it('ignores duplicate signer pubkeys', function () {
            expect(swq.meetsStakeThreshold(V, ['a', 'a'])).to.equal(false);
        });

        it('ignores signers not present in the snapshot', function () {
            expect(swq.meetsStakeThreshold(V, ['zzz'])).to.equal(false);
        });

        it('a single source IS the whole snapshot — finalizes on its own signature', function () {
            const one = [{ pubkey: 'x', source: 'X', weight: '5000' }];
            expect(swq.meetsStakeThreshold(one, ['x'])).to.equal(true);     // 3·5000 > 2·5000
        });

        it('S = 0 (empty snapshot) is disabled — never finalizes', function () {
            expect(swq.meetsStakeThreshold([], ['x'])).to.equal(false);
        });

        it('is case-insensitive on signer pubkeys', function () {
            expect(swq.meetsStakeThreshold(V, ['A', 'C'])).to.equal(true);
        });
    });

    describe('totalStake', function () {
        it('sums weight over DISTINCT sources (not keys)', function () {
            // totalStake returns a bcmath bignumber; assert on its decimal string.
            expect(String(swq.totalStake(V))).to.equal('12000');
        });
    });

    describe('isStakeWeightedQuorumActive', function () {
        it('regtest + testnet activate at genesis', function () {
            expect(swq.isStakeWeightedQuorumActive(0, 'regtest')).to.equal(true);
            expect(swq.isStakeWeightedQuorumActive(0, 'testnet')).to.equal(true);
        });
        it('mainnet is placeholder-disabled until a flag-day height is set', function () {
            expect(swq.isStakeWeightedQuorumActive(0, 'mainnet')).to.equal(false);
        });
        it('unknown network is off (safe default)', function () {
            expect(swq.isStakeWeightedQuorumActive(5, 'bogus')).to.equal(false);
        });
        it('non-numeric snapshot block is off', function () {
            expect(swq.isStakeWeightedQuorumActive(undefined, 'regtest')).to.equal(false);
        });
    });

    // Cross-service activation parity: the hub's LOCAL activation map must equal
    // the canonical map in xchain-documentation/protocol/constants.js. The indexer
    // suite asserts the same against its own copy, so transitively
    // hub == canonical == indexer. A drift here means the hub and indexers would
    // flip stake-weighting on different blocks → guaranteed ledger fork.
    describe('cross-service activation parity', function () {
        it('hub activation map == canonical constants.js', function () {
            // Monorepo-relative; the canonical doc is always present alongside the
            // services. A missing/unreadable canonical is a hard failure (NOT a
            // skip) — a silent skip would be a false green on a fork-class invariant.
            const canonical = require('../../../xchain-documentation/protocol/constants.js')
                .STAKE_WEIGHTED_QUORUM_ACTIVATION;
            expect(swq.STAKE_WEIGHTED_QUORUM_ACTIVATION).to.deep.equal(canonical);
        });
    });
});
