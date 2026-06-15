'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2) — config-change PBFT (XCONFIG, the 6th engine).
// Config PBFT signs only the ephemeral envelope today; A3 adds a durable
// per-validator signature over buildEquivCanonical('XCONFIG', seq, view, digest)
// (the config DIGEST only), carried as {equiv_sig, equiv_pubkey} in every vote
// message — parallel/additive to the count + weighted tally, gated on the round's
// BTC tip + network. No indexer twin: the two header-identical/different-digest
// messages are verified by BTC indexers from the messages alone in a SLASH proof.
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

    it('at/above the flag-day (regtest) → signs XCONFIG|seq|view||digest (DIGEST only)', function () {
        const c = mkConsensus('regtest');
        const out = c._equivVote(7, 2, 'deadbeef', 480);
        const expectedCanonical = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, 7, 2, 'deadbeef');
        expect(expectedCanonical).to.equal('EQUIV|XCONFIG|7|2||deadbeef');
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
