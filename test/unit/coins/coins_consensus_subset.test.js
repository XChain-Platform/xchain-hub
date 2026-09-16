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

    // Every top-level coin key that is deliberately NOT part of the hashed
    // consensus subset. Shared classification source for the completeness guard:
    // a NEW top-level coin key must either join consensusSubset() or be added here
    // as a conscious display/operational call. An unclassified key fails the guard
    // instead of silently dropping out of the pin (the golden-hash test only
    // catches changes to fields already IN the subset, not omissions).
    const NON_CONSENSUS_TOP_LEVEL_KEYS = new Set([
        'tick', 'fullName', 'displayName', 'site', // identity/display metadata
        'decimals',                                // display metadata
        // confirmations: LOCAL, hub-side trust policy, deliberately tunable per operator
        // (resolveConfirmations, floored at the default on mainnet and testnet). It stays
        // out of the hash because it is not a ledger input. The one path that could make it
        // one, the BTC indexer's anchor-reward mint gate, reads a frozen ledger constant of
        // its own instead (ANCHOR_REWARD_DOGE_MIN_CONFIRMATIONS in
        // anchor_reward_activation.js), so a divergent bundle cannot derive the same reward
        // at a different height with the pin verifying clean. A future consensus path
        // reaching for this field is what would make folding it in correct; today folding
        // it in would only freeze a knob four hub engines legitimately tune.
        'confirmations',
        'network',                                 // redundant with the (tick, network) hash key
        'genesis',                                 // deliberately excluded: genesis.js fail-closes on its own hashes
        'chainGenesisHash',                        // identifies the ENDPOINT's chain, not how bytes are read; pinning one must not move CONSENSUS_CONFIG_PIN
        'FEE_PAYMENT_MODE',                        // informational only; not read at runtime (see coin files)
        // wireFormat was listed here as "not hashed" until it was folded INTO
        // consensusSubset() on 2026-07-28. The guard `continue`s on membership, so the
        // stale entry was silent and, worse, load-bearing in the wrong direction: had
        // wireFormat later been dropped from the subset, its exclusion here would have
        // waved the omission through. Removed, so the completeness guard now enforces its
        // presence. A key belongs in this set only while it is genuinely out of the hash.
        'DISPLAY_ONLY_ADDRESS_ROLES',              // classification metadata, not coin data; drives the address exclusion above
        'networks',                                // the per-network container itself; its OWN keys are enumerated by the guard
    ]);

    // (item 1074): the guard's anchor is the COIN FILE's key set, never
    // getCoinConfig's output. getCoinConfig is itself a hand-maintained allowlist
    // that copies ~22 named fields out of the coin file, and consensusSubset is a
    // second, parallel hand-maintained allowlist. Iterating the resolved object
    // meant a new consensus-relevant field wired into NEITHER projection was
    // invisible to the guard AND absent from the pin: classified by silent
    // omission. Anchoring on the coin file makes the file the single source of
    // truth, so a new field must be consciously placed in consensusSubset or in
    // NON_CONSENSUS_TOP_LEVEL_KEYS. Same pattern as DISPLAY_ONLY_ADDRESS_ROLES.
    function coinFileTopLevelKeys(tick, net){
        const coinFile = require(`../../../src/coins/${tick}.js`);
        // The per-network block's own keys count as top-level coin data: they are
        // flattened into the resolved config (net / firstBlock / addresses / genesis).
        return [...new Set(Object.keys(coinFile).concat(Object.keys(coinFile.networks[net])))];
    }

function registerCompletenessTests() {
    it('covers every non-display top-level coin key in the consensus subset (completeness guard)', () => {
        for(const tick of coins.ALLOWED_COINS){
            for(const net of coins.NETWORKS){
                const subset = coins.consensusSubset(tick, net);
                for(const key of coinFileTopLevelKeys(tick, net)){
                    if(NON_CONSENSUS_TOP_LEVEL_KEYS.has(key)) continue;
                    expect(subset, `${tick}/${net}: coin-file top-level key '${key}' is neither in consensusSubset nor classified in NON_CONSENSUS_TOP_LEVEL_KEYS`)
                        .to.have.property(key);
                }
            }
        }
    });

    it('the completeness guard catches a coin-file field that BOTH projections dropped', () => {
        // The latent failure mode the anchor change closes: a new consensus-relevant
        // field lands in BTC.js but is wired into neither getCoinConfig nor
        // consensusSubset. Anchored on the resolved object the guard never saw it
        // (and the golden hash cannot detect an omission); anchored on the coin file
        // it fails loudly until someone classifies it.
        const BTC = require('../../../src/coins/BTC.js');
        BTC.NEW_CONSENSUS_FIELD = 42;
        try {
            expect(coins.getCoinConfig('BTC', 'mainnet'), 'the resolved allowlist drops it')
                .to.not.have.property('NEW_CONSENSUS_FIELD');
            expect(coins.consensusSubset('BTC', 'mainnet'), 'the hashed subset drops it too')
                .to.not.have.property('NEW_CONSENSUS_FIELD');
            expect(coinFileTopLevelKeys('BTC', 'mainnet'), 'but the guard now sees it')
                .to.include('NEW_CONSENSUS_FIELD');
            expect(() => {
                for(const key of coinFileTopLevelKeys('BTC', 'mainnet')){
                    if(NON_CONSENSUS_TOP_LEVEL_KEYS.has(key)) continue;
                    expect(coins.consensusSubset('BTC', 'mainnet')).to.have.property(key);
                }
            }, 'an unclassified coin-file field must fail the guard').to.throw(/NEW_CONSENSUS_FIELD/);
        } finally {
            delete BTC.NEW_CONSENSUS_FIELD;
        }
    });
}

function registerChainGenesisTests() {
    // The chain-tier gate in xchain-decoder can prove an endpoint is on the
    // wrong TIER, never that it is on our COIN: BTC-mainnet and DOGE-mainnet both report
    // chain="main", and testnet3/testnet4 both report a testnet string. The block-0 hash
    // is the only constant that separates them, so it lives in the registry beside the
    // other per-network identity data - but OUTSIDE the hashed consensus subset, because
    // it says which node we are talking to, not how a block's bytes are read.
    describe('chainGenesisHash (endpoint chain identity)', () => {
        it('every coin/network declares the field, unpinned (null) or a 64-char hex hash', () => {
            for(const tick of coins.ALLOWED_COINS){
                const coinFile = require(`../../../src/coins/${tick}.js`);
                for(const net of coins.NETWORKS){
                    const v = coinFile.networks[net].chainGenesisHash;
                    expect(coinFile.networks[net], `${tick}/${net}`).to.have.property('chainGenesisHash');
                    if(v !== null)
                        expect(v, `${tick}/${net} chainGenesisHash`).to.match(/^[0-9a-fA-F]{64}$/);
                }
            }
        });

        it('regtest stays unpinned: every stack mines its own chain', () => {
            for(const tick of coins.ALLOWED_COINS)
                expect(coins.getCoinConfig(tick, 'regtest').chainGenesisHash, tick).to.equal(null);
        });

        it('getCoinConfig exposes it so consumers can assert it against getblockhash 0', () => {
            for(const tick of coins.ALLOWED_COINS)
                for(const net of coins.NETWORKS)
                    expect(coins.getCoinConfig(tick, net), `${tick}/${net}`).to.have.property('chainGenesisHash');
        });

        it('is NOT in the hashed consensus subset', () => {
            for(const tick of coins.ALLOWED_COINS)
                for(const net of coins.NETWORKS)
                    expect(coins.consensusSubset(tick, net), `${tick}/${net}`).to.not.have.property('chainGenesisHash');
        });

        // The property that matters operationally: the operator can pin a real block-0
        // hash without moving CONSENSUS_CONFIG_PIN, so no flag-day and no lockstep
        // re-pin of the nine per-service bundles is needed to close the wrong-coin hole.
        it('pinning a real hash does not move the consensus hash (no flag-day to arm it)', () => {
            const BTC = require('../../../src/coins/BTC.js');
            const before = coins.consensusHash('BTC', 'mainnet');
            BTC.networks.mainnet.chainGenesisHash =
                '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
            try {
                expect(coins.getCoinConfig('BTC', 'mainnet').chainGenesisHash)
                    .to.equal('000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
                expect(coins.consensusHash('BTC', 'mainnet')).to.equal(before);
            } finally {
                BTC.networks.mainnet.chainGenesisHash = null;
            }
        });
    });
}

function registerAddressSubsetTests() {
    it('derives the address exclusion from each coin file\'s DISPLAY_ONLY_ADDRESS_ROLES (no magic string)', () => {
        for(const tick of coins.ALLOWED_COINS){
            const coinFile = require(`../../../src/coins/${tick}.js`);
            // Behavior freeze: today exactly EXPLORER is display-only. Changing this
            // list changes the consensus hash and requires a coordinated pin bump.
            expect(coinFile.DISPLAY_ONLY_ADDRESS_ROLES, tick).to.deep.equal(['EXPLORER']);
            for(const net of coins.NETWORKS){
                const subset = coins.consensusSubset(tick, net);
                for(const role of coinFile.DISPLAY_ONLY_ADDRESS_ROLES)
                    expect(subset.addresses, `${tick}/${net}`).to.not.have.property(role);
            }
        }
    });

    it('a newly-declared display-only role is excluded and cannot shift the consensus hash', () => {
        const BTC = require('../../../src/coins/BTC.js');
        const before = coins.consensusHash('BTC', 'mainnet');
        BTC.networks.mainnet.addresses.TESTONLY = '1TestDisplayOnlyRoleXXXXXXXXXXXXXX';
        BTC.DISPLAY_ONLY_ADDRESS_ROLES.push('TESTONLY');
        try {
            expect(coins.consensusSubset('BTC', 'mainnet').addresses).to.not.have.property('TESTONLY');
            expect(coins.consensusHash('BTC', 'mainnet')).to.equal(before);
        } finally {
            delete BTC.networks.mainnet.addresses.TESTONLY;
            BTC.DISPLAY_ONLY_ADDRESS_ROLES.pop();
        }
    });

    it('does not mutate the source modules when a caller edits the result', () => {
        const before = coins.consensusHash('BTC', 'mainnet');
        const c = coins.getCoinConfig('BTC', 'mainnet');
        c.GAS_SCHEDULE.ISSUE = 999;
        c.addresses.BURN = 'tampered';
        expect(coins.consensusHash('BTC', 'mainnet')).to.equal(before);
        expect(coins.getCoinConfig('BTC', 'mainnet').addresses.BURN).to.not.equal('tampered');
    });
}

function registerFullnodeNormalizationTests() {
    // #1283: GENESIS_VERIFIERS lowercase normalization must run on EVERY network,
    // not regtest-only. The early `if(network !== 'regtest') return out;` once
    // preceded the normalization, so mainnet/testnet served verifier keys verbatim,
    // contradicting the 'case-insensitive on the wire; normalize' contract.
    describe('resolveFullnode GENESIS_VERIFIERS normalization (#1283)', () => {
        const mixedCase = { GENESIS_VERIFIERS: ['ABcd12', 'EF00Ff'] };

        it('lowercases GENESIS_VERIFIERS on mainnet', () => {
            const out = coins.resolveFullnode(mixedCase, 'mainnet');
            expect(out.GENESIS_VERIFIERS).to.deep.equal(['abcd12', 'ef00ff']);
        });

        it('lowercases GENESIS_VERIFIERS on testnet', () => {
            const out = coins.resolveFullnode(mixedCase, 'testnet');
            expect(out.GENESIS_VERIFIERS).to.deep.equal(['abcd12', 'ef00ff']);
        });

        it('lowercases GENESIS_VERIFIERS on regtest (unchanged behavior)', () => {
            const out = coins.resolveFullnode(mixedCase, 'regtest');
            expect(out.GENESIS_VERIFIERS).to.deep.equal(['abcd12', 'ef00ff']);
        });
    });
}

describe('coins registry', () => {
    registerCompletenessTests();
    registerAddressSubsetTests();
    registerFullnodeNormalizationTests();
    registerChainGenesisTests();
});
