'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2) — config-change PBFT (XCONFIG, the 6th engine).
// Config PBFT signs only the ephemeral envelope today; A3 adds a durable per-validator
// signature over buildEquivCanonical('XCONFIG', seq, view, `${snapshot_block}|${digest}`),
// carried as {equiv_sig, equiv_pubkey} in every vote message — parallel/additive to the
// count + weighted tally, gated on the round's BTC tip + network. The Phase-A amendment
// (WI-2 bump 2) carries the round's locked snapshot_block IN the signed content so config
// equivocation is SLASHABLE: a BTC indexer recovers the whole-federation membership block
// from the two header-identical / same-snapshot_block / different-digest messages alone.
const { expect } = require('chai');
const eq = require('../../src/equivocation_header.js');
const Consensus = require('../../src/Consensus.js');

// Stub identity whose sign() echoes its input → lets us assert the EXACT signed bytes.
const identity = { sign: (s) => 'SIG(' + s + ')', getPubkeyHex: () => 'ABCDEF' };
function mkConsensus(network){
    return new Consensus({ network: network, getPeerManager: () => ({}), db: {}, getIdentity: () => identity });
}

describe('EQUIV config canonical (WI-2 bump 2, XCONFIG)', function () {

    it('below the flag-day (mainnet) → no equiv fields (vote still counts)', function () {
        const c = mkConsensus('mainnet');
        expect(c._equivVote(7, 0, 'deadbeef', 5)).to.deep.equal({});
    });

    it('at/above the flag-day (regtest) → signs XCONFIG|seq|view||snapshot_block|digest', function () {
        const c = mkConsensus('regtest');
        const out = c._equivVote(7, 2, 'deadbeef', 480);
        // content = `<snapshot_block>|<digest>` so a SLASH proof recovers the membership block.
        const expectedCanonical = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, 7, 2, '480|deadbeef');
        expect(expectedCanonical).to.equal('EQUIV|XCONFIG|7|2||480|deadbeef');
        expect(out).to.deep.equal({ equiv_sig: 'SIG(' + expectedCanonical + ')', equiv_pubkey: 'abcdef' });
    });

    it('a different view ⇒ a different signed canonical (honest view-change boundary)', function () {
        const c = mkConsensus('regtest');
        const v0 = c._equivVote(7, 0, 'deadbeef', 480).equiv_sig;
        const v1 = c._equivVote(7, 1, 'deadbeef', 480).equiv_sig;
        expect(v0).to.not.equal(v1);
    });

    it('no identity → no equiv fields (gate on, but nothing to sign with)', function () {
        const c = new Consensus({ network: 'regtest', getPeerManager: () => ({}), db: {}, getIdentity: () => null });
        expect(c._equivVote(7, 0, 'deadbeef', 480)).to.deep.equal({});
    });
});
