'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const eq = require('../../src/equivocation_header.js');

// CONSENSUS-CRITICAL: the EQUIV header (WI-2 bump 2) is prefixed onto every signed
// consensus canonical at/above the flag-day. The indexer keeps a byte-equivalent
// copy (xchain-indexer/src/equivocation_header.js); the client verifiers (xchain-sdk,
// xchain-explorer) will keep gated copies too. The cross-service regression suite
// asserts every copy's activation map equals the canonical in
// xchain-documentation/protocol/constants.js — a drift flips the header on different
// blocks → guaranteed ledger fork.
describe('equivocation_header', function () {

    describe('isEquivHeaderActive', function () {
        it('regtest activates at genesis (block 0)', function () {
            expect(eq.isEquivHeaderActive(0, 'regtest')).to.equal(true);
            expect(eq.isEquivHeaderActive(500, 'regtest')).to.equal(true);
        });
        it('mainnet is placeholder-disabled below the far-future height', function () {
            expect(eq.isEquivHeaderActive(5, 'mainnet')).to.equal(false);
        });
        it('unknown network is OFF (safe default)', function () {
            expect(eq.isEquivHeaderActive(5, 'bogus')).to.equal(false);
        });
        it('non-numeric block is OFF', function () {
            expect(eq.isEquivHeaderActive(undefined, 'regtest')).to.equal(false);
            expect(eq.isEquivHeaderActive('xx', 'regtest')).to.equal(false);
        });
    });

    describe('buildEquivCanonical / equivPrefix / equivKey', function () {
        it('prefix round-trips even when ROUND_ID contains "|" (checkpoint case)', function () {
            const tag = eq.ENGINE_TAGS.CHECKPOINT;     // XCHECKPOINT
            const roundId = 'BTC|regtest|500|7';        // chain|network|block_index|checkpoint_seq
            const content = 'XCHECKPOINT|BTC|regtest|500|aa|bb|cc|dd|7|100';
            const canon = eq.buildEquivCanonical(tag, roundId, 0, content);
            const prefix = eq.equivPrefix(eq.equivKey(tag, roundId, 0));
            expect(canon.startsWith(prefix)).to.equal(true);
            // CONTENT is recovered by slicing the (opaque) prefix off — never by
            // field-splitting, since both key and content carry "|".
            expect(canon.slice(prefix.length)).to.equal(content);
        });
        it('different VIEW ⇒ different prefix (the equivocation/honest-view boundary)', function () {
            const k0 = eq.equivKey('XDEX', 'mid', 0);
            const k1 = eq.equivKey('XDEX', 'mid', 1);
            expect(k0).to.not.equal(k1);
            expect(eq.equivPrefix(k0)).to.not.equal(eq.equivPrefix(k1));
        });
    });

    // Cross-service activation parity: the hub's LOCAL activation map must equal the
    // canonical map in constants.js AND the indexer's copy, byte-for-byte. A missing
    // canonical is a hard failure (NOT a skip) — a silent skip would be a false green
    // on a fork-class invariant.
    describe('cross-service activation parity', function () {
        it('hub activation map == canonical constants.js', function () {
            const canonical = require('../../../xchain-documentation/protocol/constants.js')
                .EQUIV_HEADER_ACTIVATION;
            expect(eq.EQUIV_HEADER_ACTIVATION).to.deep.equal(canonical);
        });
        it('all 5 copies == hub (map + tags + builder bytes)', function () {
            // hub + indexer (server consensus) + sdk + explorer (client checkpoint
            // verifiers). A drift in ANY copy flips the header on different blocks → fork.
            const copies = {
                indexer:  require('../../../xchain-indexer/src/equivocation_header.js'),
                sdk:      require('../../../xchain-sdk/src/equivocation_header.js'),
                explorer: require('../../../xchain-explorer/src/equivocation_header.js'),
            };
            const ref = eq.buildEquivCanonical('XDEX', 'mid', 2, 'XMATCH|mid|x');
            for(const [name, copy] of Object.entries(copies)){
                expect(copy.EQUIV_HEADER_ACTIVATION, name + ' activation map').to.deep.equal(eq.EQUIV_HEADER_ACTIVATION);
                expect(copy.ENGINE_TAGS, name + ' engine tags').to.deep.equal(eq.ENGINE_TAGS);
                // Builder must produce identical bytes on every side for identical inputs.
                expect(copy.buildEquivCanonical('XDEX', 'mid', 2, 'XMATCH|mid|x'), name + ' builder bytes').to.equal(ref);
            }
        });
    });
});
