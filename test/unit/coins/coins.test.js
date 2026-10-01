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
const coins      = require('../../../src/coins');

// Golden consensus hashes for the canonical coin files. These freeze the
// consensus-critical subset: any unintended change to a network byte-prefix,
// address role, fee value, gas-schedule entry, or staking param changes a hash
// and fails here. Updating a value is a deliberate act, so update the golden
// alongside it (and bump the per-service CONSENSUS_CONFIG_PIN in lockstep).
// REGENERATED 2026-07-28: `wireFormat` is now folded
// into consensusSubset(), so every one of these nine hashes moved by construction.
// The testnet/regtest values are the ones bundled as CONSENSUS_CONFIG_PIN in all
// nine vendoring services; mainnet stays `null` in the pin (pre-arm) and is
// pinned only here.
// BTC REGENERATED 2026-07-31: minStandardTxNonWitnessSize 65 -> 82 on all
// three networks. It sits in the `net` block, which consensusSubset() hashes whole,
// so a relay-policy correction moves all three BTC hashes; LTC and DOGE are
// deliberately untouched, and their unchanged goldens are the check that nothing
// else drifted with it.
// REGENERATED 2026-08-06: `firstBlock` is now folded into
// consensusSubset(), so all nine hashes moved by construction again. Same rollout
// rule as the wireFormat fold: every vendoring service ships the new pins in one
// wave, and a straggler fail-closes rather than forking.
// REGENERATED 2026-08-10 (fresh testnet genesis): the three testnet `firstBlock`
// heights moved to just under their live tips (BTC 138000 -> 147500, LTC 4765000
// -> 4855000, DOGE 64800000 -> 67815000), so only the three TESTNET goldens move.
// Mainnet and regtest are deliberately untouched, and their unchanged goldens are
// the check that nothing else drifted in with the genesis edit.
// REGENERATED 2026-08-24 (fresh testnet genesis): the three testnet `firstBlock`
// heights moved to just under their live tips again (BTC 147500 -> 149700,
// LTC 4855000 -> 4862500, DOGE 67815000 -> 67847500) so the public testnet
// announces with zero pre-announcement test actions. Only the three TESTNET
// goldens move; unchanged mainnet/regtest goldens are the no-drift check.
// BTC mainnet REGENERATED 2026-08-24: the mainnet validator reward pool
// (REWARD) moved to its final vanity address. Addresses are in the consensus
// subset, so only the BTC mainnet golden moves; every other golden is
// deliberately untouched and is the no-drift check.
// REGENERATED 2026-09-01: GAS_SCHEDULE gains SWEEP_BASE, SWEEP_PER_ITEM,
// CALLBACK_BASE and CALLBACK_PER_RECIPIENT, the unified prices SWEEP and CALLBACK move
// onto at the UNIFIED_FEES_SWEEP_CALLBACK flag day. GAS_SCHEDULE is in consensusSubset()
// and is hashed WHOLE, so ADDING a key moves all nine hashes by construction, even though
// the flag reading them is unarmed on mainnet and testnet. Same one-wave rollout rule as
// the folds above: every vendoring service ships the new pins together, and a straggler
// fail-closes on verifyConsensusPin() rather than forking.
// REGENERATED 2026-09-12 (XChain bridge, base and token): every network block
// gains the ADDRESS.BRIDGE_<COIN> escrow roles (one per other chain) and
// GAS_SCHEDULE gains XBRIDGE_BASE. Addresses and the gas schedule are both in
// consensusSubset() and both hashed WHOLE, so all nine hashes move by construction
// even though XCHAIN_BRIDGE_ACTIVATION is unarmed on mainnet and testnet. Same
// one-wave rollout rule as every regeneration above: every vendoring service ships
// the new pins together and a straggler fail-closes on verifyConsensusPin().
// REGENERATED 2026-09-30: GAS_SCHEDULE gains LIST_SHARE,
// LIST_SHARED_EDIT_BASE and LIST_SHARED_EDIT_PER_ITEM. GAS_SCHEDULE is hashed whole,
// so all nine hashes move even though nothing charges the keys below
// LIST_SHARE_ACTIVATION. The same one-wave rollout rule applies.
// REGENERATED 2026-10-01: ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS joins the consensus
// subset. All nine hashes move even though the 4500-second fee-gate bound is inert
// below ORACLE_PRICE_AGE_HOURLY_ACTIVATION. The one-wave rollout rule applies.
const GOLDEN_HASH = {
    BTC:  { mainnet: '1fd448eafb00c95f526f1d01422df98c1af8876a0adbefd859fca19c7d789a31',
            testnet: '3e0083d555399e54eff2670a0ea5e8d76c8935d3e7423451c1221ae698386b5a',
            regtest: 'ad800ecb8d28448f9d39743bd3a28e6aac121d0e9add30743ee1dcbbf694af86' },
    LTC:  { mainnet: '3d3d4b3820199d4398b53eb239be552acd281dff678cda0d88acf3932af2076e',
            testnet: 'd9c315b36adf5ab8bd6831ccc59a2a01124df70ba9fc8141662ec682285251e8',
            regtest: '16dd43ca2299880704e076e5f7c262eae6b5e32823ad49c9748c33f014f44c36' },
    DOGE: { mainnet: 'cc2a4db628dd3759bcf64dd35dc6b9ee2726be1a9d38eb5e5596bc3a9d0bf99e',
            testnet: '82c6bc814e3de4a1e023d008457b7186c5a6ac142c85be9bf0a18f2d5989fd72',
            regtest: 'd7bd53f527d961f1cf0cfc7de725d61e625975f7086532976c777a04c08988f6' },
};

function registerRegistryBasics() {
    // These four cases pin the coin registry's public surface: the fixed
    // launch list, the per-network config shape every caller depends on,
    // the explicit failure on an unknown tick or network (a caller must
    // never silently fall through to undefined config), and the golden
    // consensus hash itself. Every other helper in this file assumes the
    // registry still looks like this, so a regression here is the first
    // signal, not a downstream wireFormat or firstBlock failure that would
    // otherwise be harder to trace back to its actual cause.
    it('exposes the three launch coins with full-name mappings', () => {
        expect(coins.ALLOWED_COINS).to.deep.equal(['BTC', 'LTC', 'DOGE']);
        expect(coins.COIN_FULL_NAME).to.deep.equal({ BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' });
        expect(coins.FULL_NAME_TO_TICK.bitcoin).to.equal('BTC');
        expect(coins.DEFAULT_CONFIRMATIONS).to.deep.equal({ BTC: 6, LTC: 12, DOGE: 60 });
    });

    it('resolves every coin/network with the expected core fields', () => {
        for(const tick of coins.ALLOWED_COINS){
            for(const net of coins.NETWORKS){
                const c = coins.getCoinConfig(tick, net);
                expect(c.tick).to.equal(tick);
                expect(c.network).to.equal(net);
                expect(c.net).to.be.an('object');
                expect(c.addresses).to.include.keys('BURN', 'GAS', 'FEE_DESTINATION');
                expect(c.GAS_SCHEDULE).to.be.an('object');
                expect(c.STAKING).to.be.an('object');
            }
        }
    });

    it('throws on an unknown coin or network', () => {
        expect(() => coins.getCoinConfig('ZZZ', 'mainnet')).to.throw(/Unknown coin/);
        expect(() => coins.getCoinConfig('BTC', 'devnet')).to.throw(/Unknown network/);
    });

    it('produces stable consensus hashes matching the golden freeze vector', () => {
        for(const tick of coins.ALLOWED_COINS){
            for(const net of coins.NETWORKS){
                const h = coins.consensusHash(tick, net);
                expect(h, `${tick}/${net}`).to.equal(GOLDEN_HASH[tick][net]);
                expect(coins.consensusHash(tick, net), 'deterministic').to.equal(h);
            }
        }
    });
}

function registerWireFormatTests() {
    // Three cases, one property each: the map itself resolves to the value
    // every vendoring service bundles, folding it into the hash actually
    // changes the hash when it differs, and a display-only field that has
    // no business being consensus-critical stays out of the pinned subset.
    // Keeping these as separate cases means a failure names exactly which
    // of the three broke, rather than a single combined assertion whose
    // failure message would still need to be traced back to one of them by
    // hand.
    // This test once asserted the OPPOSITE: that wireFormat stayed
    // OUT of the consensus hash. That was the bug. wireFormat selects the block
    // parser (XChainBlockDecoder keys default/mweb/auxpow off it, and XChainDecoder
    // derives auxPow from it), so it decides how a block's bytes are read. Leaving it
    // out of the pinned subset meant CONSENSUS_CONFIG_PIN verified clean on a node
    // whose bundle declared, say, LTC as 'default' instead of 'mweb': it would decode
    // different transactions out of the same block and fork, with the one mechanism
    // built to catch exactly that reporting success.
    it('folds the per-coin wireFormat family INTO the consensus hash', () => {
        const expected = { BTC: 'default', LTC: 'mweb', DOGE: 'auxpow' };
        for(const tick of coins.ALLOWED_COINS){
            expect(coins.WIRE_FORMAT[tick], `${tick} WIRE_FORMAT map`).to.equal(expected[tick]);
            for(const net of coins.NETWORKS){
                expect(coins.getCoinConfig(tick, net).wireFormat, `${tick}/${net} resolved`).to.equal(expected[tick]);
                expect(coins.consensusSubset(tick, net), `${tick}/${net} subset`)
                    .to.have.property('wireFormat', expected[tick]);
            }
        }
    });

    // The property that matters is not "the field is present" but "changing it moves
    // the pin". Prove it end to end: a coin whose wireFormat differs must hash
    // differently, otherwise the fold is decorative and the fork stays reachable.
    it('a divergent wireFormat changes the consensus hash (the fold is load-bearing)', () => {
        const canonical = coins.consensusSubset('LTC', 'mainnet');
        expect(canonical.wireFormat).to.equal('mweb');
        const tampered = { ...canonical, wireFormat: 'default' };
        expect(coins.canonicalJson(tampered)).to.not.equal(coins.canonicalJson(canonical));
    });

    it('excludes display-only fields from the consensus subset', () => {
        const subset = coins.consensusSubset('BTC', 'mainnet');
        expect(subset.addresses).to.not.have.property('EXPLORER');
        // .any.keys, not exact-set .keys: the exact-set form is only true when the
        // subset has EXACTLY these keys, so its negation was vacuously true and
        // could never catch a display-only field leaking into the pinned subset.
        expect(subset).to.not.have.any.keys('genesis', 'displayName', 'confirmations');
    });
}

function registerFirstBlockTests() {
    // The firstBlock twin of the wireFormat tests above, asserted the same
    // way for the same reason: prove the field is folded into the hash, then
    // prove folding it in actually changes the hash when the value differs,
    // so the second case cannot pass by coincidence if the fold is removed.
    // The firstBlock twin of the wireFormat fold above. This test once
    // asserted firstBlock stayed OUT of the subset on the reading that a scan start is
    // node-local. It is not: the decoder sets startBlockIndex from it
    // (xchain-decoder/src/XChainDecoder.js) and never processes a block below it, so a
    // node bundling a higher value skips the actions in between and builds a different
    // action history from the same chain, with CONSENSUS_CONFIG_PIN verifying clean.
    // There is no env override; consensusSubset reads the static bundled value.
    it('folds the per-network firstBlock INTO the consensus hash', () => {
        for(const tick of coins.ALLOWED_COINS){
            for(const net of coins.NETWORKS){
                const expected = coins.getCoinConfig(tick, net).firstBlock;
                expect(expected, `${tick}/${net} firstBlock`).to.be.a('number');
                expect(coins.consensusSubset(tick, net), `${tick}/${net} subset`)
                    .to.have.property('firstBlock', expected);
            }
        }
    });

    // Presence is not the property that matters; moving the hash is.
    it('a divergent firstBlock changes the consensus hash (the fold is load-bearing)', () => {
        const canonical = coins.consensusSubset('DOGE', 'mainnet');
        expect(canonical.firstBlock).to.equal(6240000);
        const tampered = { ...canonical, firstBlock: 6240001 };
        expect(coins.canonicalJson(tampered)).to.not.equal(coins.canonicalJson(canonical));
    });
}

describe('coins registry', () => {
    // The three helpers above are grouped by what each one guards, not by
    // call order: registry sanity, the wireFormat fold, and the firstBlock
    // fold are three independent ways the consensus hash can silently stop
    // matching what every vendoring service actually bundles, so each earns
    // its own coverage rather than being asserted once and assumed to cover
    // the others. A change that breaks only one of the three should fail
    // only its own case, so the failing test name says which invariant
    // actually broke instead of leaving that to a debugging session.
    registerRegistryBasics();
    registerWireFormatTests();
    registerFirstBlockTests();
});
