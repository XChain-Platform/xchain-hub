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
const coins      = require('../../src/coins');

// Golden consensus hashes for the canonical coin files. These freeze the
// consensus-critical subset: any unintended change to a network byte-prefix,
// address role, fee value, gas-schedule entry, or staking param changes a hash
// and fails here. Updating a value is a deliberate act, so update the golden
// alongside it (and bump the per-service CONSENSUS_CONFIG_PIN in lockstep).
// REGENERATED 2026-07-28 ( batch, ): `wireFormat` is now folded
// into consensusSubset(), so every one of these nine hashes moved by construction.
// The testnet/regtest values are the ones bundled as CONSENSUS_CONFIG_PIN in all
// nine vendoring services; mainnet stays `null` in the pin (pre-arm) and is
// pinned only here.
// BTC REGENERATED 2026-07-31 : minStandardTxNonWitnessSize 65 -> 82 on all
// three networks. It sits in the `net` block, which consensusSubset() hashes whole,
// so a relay-policy correction moves all three BTC hashes; LTC and DOGE are
// deliberately untouched, and their unchanged goldens are the check that nothing
// else drifted with it.
// REGENERATED 2026-08-06 (): `firstBlock` is now folded into
// consensusSubset(), so all nine hashes moved by construction again. Same rollout
// rule as the wireFormat fold: every vendoring service ships the new pins in one
// wave, and a straggler fail-closes rather than forking.
// REGENERATED 2026-08-10 (fresh testnet genesis): the three testnet `firstBlock`
// heights moved to just under their live tips (BTC 138000 -> 147500, LTC 4765000
// -> 4855000, DOGE 64800000 -> 67815000), so only the three TESTNET goldens move.
// Mainnet and regtest are deliberately untouched, and their unchanged goldens are
// the check that nothing else drifted in with the genesis edit.
const GOLDEN_HASH = {
    BTC:  { mainnet: '8f2a60c4a06d819d909cefa5d463a2f810d014fc66cdfa0ef51ffa19cbb5f66b',
            testnet: '1e45a958ff9eb6a88be8684e3801b57e7afcfc9031f7761e4f4b1dcf1c8d42a9',
            regtest: '24e6a363e5a36285574dea357328a997fdee5762ef812d8947eacf69c51afc24' },
    LTC:  { mainnet: 'f5c81b02f2c8bdd4a828f25495cc5c63fa18e6040c80569c2aaeb8d6860ce577',
            testnet: '888818a874d6d8acb3363355089f0de601c355b63fc8431a44ef666f91615202',
            regtest: '5ad03b383d873d309640e75dfefa2787a5806cb8a84ee46f4cc7fb25ca7f808b' },
    DOGE: { mainnet: '8073fa2632b84c691ad625ee107f8a03ca90483f1b726700e46db833b86399b4',
            testnet: 'ea3ee0d1407959f3cb59e4baf66b50dfc2ada9962351e578d7c6d8586e6ff905',
            regtest: '019220a461e34c99fcf5cbf107673f13d3f2a57d2a20e16a0323ed44c81edd11' },
};

describe('coins registry', () => {

    // #1283: GENESIS_VERIFIERS lowercase normalization must run on EVERY network,
    // not regtest-only. The early `if(network !== 'regtest') return out;` used to
    // precede the normalization, so mainnet/testnet served verifier keys verbatim,
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

    // . This test previously asserted the OPPOSITE: that wireFormat stayed
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

    // , the firstBlock twin of the wireFormat fold above. This test used to
    // assert firstBlock stayed OUT of the subset on the reading that a scan start is
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

    // Every top-level coin key that is deliberately NOT part of the hashed
    // consensus subset. Shared classification source for the completeness guard:
    // a NEW top-level coin key must either join consensusSubset() or be added here
    // as a conscious display/operational call. An unclassified key fails the guard
    // instead of silently dropping out of the pin (the golden-hash test only
    // catches changes to fields already IN the subset, not omissions).
    const NON_CONSENSUS_TOP_LEVEL_KEYS = new Set([
        'tick', 'fullName', 'displayName', 'site', // identity/display metadata
        'decimals', 'confirmations',               // display / operator-tunable depth
        'network',                                 // redundant with the (tick, network) hash key
        'genesis',                                 // deliberately excluded: genesis.js fail-closes on its own hashes
        'chainGenesisHash',                        // : identifies the ENDPOINT's chain, not how bytes are read; pinning one must not move CONSENSUS_CONFIG_PIN
        'FEE_PAYMENT_MODE',                        // informational only; not read at runtime (see coin files)
        'wireFormat',                              // block/tx parse family (decoder/utxo-tracker); not hashed, mirrors the pre-existing decoder-local constant
        'DISPLAY_ONLY_ADDRESS_ROLES',              // classification metadata, not coin data; drives the address exclusion above
        'networks',                                // the per-network container itself; its OWN keys are enumerated by the guard
    ]);

    //  (item 1074): the guard's anchor is the COIN FILE's key set, never
    // getCoinConfig's output. getCoinConfig is itself a hand-maintained allowlist
    // that copies ~22 named fields out of the coin file, and consensusSubset is a
    // second, parallel hand-maintained allowlist. Iterating the resolved object
    // meant a new consensus-relevant field wired into NEITHER projection was
    // invisible to the guard AND absent from the pin: classified by silent
    // omission. Anchoring on the coin file makes the file the single source of
    // truth, so a new field must be consciously placed in consensusSubset or in
    // NON_CONSENSUS_TOP_LEVEL_KEYS. Same pattern as DISPLAY_ONLY_ADDRESS_ROLES.
    function coinFileTopLevelKeys(tick, net){
        const coinFile = require(`../../src/coins/${tick}.js`);
        // The per-network block's own keys count as top-level coin data: they are
        // flattened into the resolved config (net / firstBlock / addresses / genesis).
        return [...new Set(Object.keys(coinFile).concat(Object.keys(coinFile.networks[net])))];
    }

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
        const BTC = require('../../src/coins/BTC.js');
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

    // . The chain-tier gate in xchain-decoder can prove an endpoint is on the
    // wrong TIER, never that it is on our COIN: BTC-mainnet and DOGE-mainnet both report
    // chain="main", and testnet3/testnet4 both report a testnet string. The block-0 hash
    // is the only constant that separates them, so it lives in the registry beside the
    // other per-network identity data - but OUTSIDE the hashed consensus subset, because
    // it says which node we are talking to, not how a block's bytes are read.
    describe('chainGenesisHash (endpoint chain identity, )', () => {
        it('every coin/network declares the field, unpinned (null) or a 64-char hex hash', () => {
            for(const tick of coins.ALLOWED_COINS){
                const coinFile = require(`../../src/coins/${tick}.js`);
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
            const BTC = require('../../src/coins/BTC.js');
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

    it('derives the address exclusion from each coin file\'s DISPLAY_ONLY_ADDRESS_ROLES (no magic string)', () => {
        for(const tick of coins.ALLOWED_COINS){
            const coinFile = require(`../../src/coins/${tick}.js`);
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
        const BTC = require('../../src/coins/BTC.js');
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

    describe('env overrides (the only place coin env vars are read)', () => {
        const SAVED = {};
        const setEnv = (k, v) => { SAVED[k] = process.env[k]; if(v === undefined) delete process.env[k]; else process.env[k] = v; };
        afterEach(() => { for(const k of Object.keys(SAVED)){ if(SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });

        it('applies FEE_DESTINATION override on regtest only', () => {
            setEnv('XCHAIN_FEE_DESTINATION_BTC_REGTEST', 'rtOverrideAddr');
            expect(coins.getCoinConfig('BTC', 'regtest').addresses.FEE_DESTINATION).to.equal('rtOverrideAddr');
        });

        it('IGNORES the FEE_DESTINATION override on mainnet (consensus pin escape, item 5473)', () => {
            const pinned = coins.getCoinConfig('BTC', 'mainnet').addresses.FEE_DESTINATION;
            setEnv('XCHAIN_FEE_DESTINATION_BTC_MAINNET', 'bcOverrideAddr');
            // On mainnet the env override is dropped so it cannot escape verifyConsensusPin
            // (which hashes only the static bundle) and fork the block-hashed ledger.
            expect(coins.getCoinConfig('BTC', 'mainnet').addresses.FEE_DESTINATION).to.equal(pinned);
        });

        it('IGNORES the FEE_DESTINATION override on testnet (armed pin, multi-operator fork risk)', () => {
            // Testnet carries a real armed CONSENSUS_CONFIG_PIN; an env-resolved override
            // would escape the static-bundle hash exactly as on mainnet, letting two
            // operators accept/reject the same native-fee action differently.
            const pinned = coins.getCoinConfig('BTC', 'testnet').addresses.FEE_DESTINATION;
            setEnv('XCHAIN_FEE_DESTINATION_BTC_TESTNET', 'tbOverrideAddr');
            expect(coins.getCoinConfig('BTC', 'testnet').addresses.FEE_DESTINATION).to.equal(pinned);
        });

        it('binds regtest genesis from env but never affects the consensus hash', () => {
            const before = coins.consensusHash('BTC', 'regtest');
            setEnv('XCHAIN_GENESIS_BLOCK', '12345');
            setEnv('XCHAIN_GENESIS_LEDGER_HASH', 'deadbeef');
            const c = coins.getCoinConfig('BTC', 'regtest');
            expect(c.genesis.block).to.equal(12345);
            expect(c.genesis.ledgerHash).to.equal('deadbeef');
            expect(coins.consensusHash('BTC', 'regtest')).to.equal(before);
        });

        it('ignores genesis env on mainnet/testnet', () => {
            setEnv('XCHAIN_GENESIS_BLOCK', '999');
            expect(coins.getCoinConfig('BTC', 'mainnet').genesis.block).to.equal(950000);
            expect(coins.getCoinConfig('DOGE', 'testnet').genesis.block).to.equal(0);
        });

        //  / . The airdrop bucket set decides how much XCHAIN each
        // snapshot holder mints and which synthetic tx hashes carry the credits, so it
        // belongs to the bundle everywhere the bundle is frozen.
        it('binds the regtest airdrop set from env, index-aligned, without moving the consensus hash', () => {
            const before = coins.consensusHash('BTC', 'regtest');
            setEnv('GENESIS_AIRDROP_PATHS',   'data/xcp.csv, data/xdp.csv');
            setEnv('GENESIS_AIRDROP_HASHES',  'aa, ');           // second bucket deliberately unpinned
            setEnv('GENESIS_AIRDROP_AMOUNTS', '20000000.00000000,10000000.00000000');
            setEnv('GENESIS_AIRDROP_SNAPSHOT_BLOCK', '950000');
            setEnv('GENESIS_AIRDROP_SET_HASH', 'f00d');
            const g = coins.getCoinConfig('BTC', 'regtest').genesis;
            expect(g.airdropPaths).to.deep.equal(['data/xcp.csv', 'data/xdp.csv']);
            // The empty hash entry SURVIVES: entry N pins entry N of paths, so compacting
            // it would shift the first bucket's pin onto the second bucket's file.
            expect(g.airdropHashes).to.deep.equal(['aa', '']);
            expect(g.airdropAmounts).to.deep.equal(['20000000.00000000', '10000000.00000000']);
            expect(g.airdropSnapshotBlock).to.equal('950000');
            expect(g.airdropSetHash).to.equal('f00d');
            expect(coins.consensusHash('BTC', 'regtest')).to.equal(before);
        });

        it('IGNORES the airdrop env on mainnet and testnet, for every coin', () => {
            setEnv('GENESIS_AIRDROP_PATHS',   'data/evil.csv');
            setEnv('GENESIS_AIRDROP_HASHES',  'bb');
            setEnv('GENESIS_AIRDROP_AMOUNTS', '99999999.00000000');
            setEnv('GENESIS_AIRDROP_SNAPSHOT_BLOCK', '1');
            setEnv('GENESIS_AIRDROP_SET_HASH', 'beef');
            for(const tick of coins.ALLOWED_COINS){
                for(const net of ['mainnet', 'testnet']){
                    const g = coins.getCoinConfig(tick, net).genesis;
                    expect(g.airdropPaths,   `${tick}/${net} paths`).to.deep.equal([]);
                    expect(g.airdropHashes,  `${tick}/${net} hashes`).to.deep.equal([]);
                    expect(g.airdropAmounts, `${tick}/${net} amounts`).to.deep.equal([]);
                    expect(g.airdropSnapshotBlock, `${tick}/${net} snapshot`).to.equal(null);
                    expect(g.airdropSetHash, `${tick}/${net} set hash`).to.equal(null);
                }
            }
        });

        it('carries the airdrop keys on every coin/network so the bundle is the only source', () => {
            for(const tick of coins.ALLOWED_COINS){
                for(const net of coins.NETWORKS){
                    const g = coins.getCoinConfig(tick, net).genesis;
                    expect(g, `${tick}/${net}`).to.include.all.keys(
                        'airdropPaths', 'airdropHashes', 'airdropAmounts', 'airdropSnapshotBlock', 'airdropSetHash');
                }
            }
        });
    });

    describe('consensus config pin', () => {
        const { CONSENSUS_CONFIG_PIN } = require('../../src/coins/consensus_pin.js');

        it('pins match the canonical hashes for every armed network/coin', () => {
            for(const net of coins.NETWORKS){
                const pin = CONSENSUS_CONFIG_PIN[net];
                if(pin === null || pin === undefined) continue; // mainnet skipped pre-arm
                for(const tick of coins.ALLOWED_COINS)
                    expect(pin[tick], `${tick}/${net}`).to.equal(coins.consensusHash(tick, net));
            }
        });

        it('mainnet is null (pin armed only in the Phase 6 coordinated release)', () => {
            expect(CONSENSUS_CONFIG_PIN.mainnet).to.equal(null);
        });

        it('verifyConsensusPin passes for armed networks and skips mainnet', () => {
            expect(coins.verifyConsensusPin('testnet')).to.deep.equal({ ok: true, skipped: false });
            expect(coins.verifyConsensusPin('regtest')).to.deep.equal({ ok: true, skipped: false });
            expect(coins.verifyConsensusPin('mainnet')).to.deep.equal({ ok: true, skipped: true });
        });

        it('consensusHashes returns a hash for every coin', () => {
            const h = coins.consensusHashes('regtest');
            expect(Object.keys(h)).to.deep.equal(coins.ALLOWED_COINS);
            expect(h.BTC).to.match(/^[0-9a-f]{64}$/);
        });
    });

    //  / CF-1: on mainnet an XCHAIN_CONFIRMATIONS_<COIN> override may only
    // raise the depth above the per-coin default, never lower it. A validator
    // running a lowered depth would co-sign source actions the rest of the
    // federation still considers reorg-able.
    describe('resolveConfirmations mainnet floor ', () => {
        const saved = {};
        beforeEach(() => {
            for(const tick of coins.ALLOWED_COINS){
                const key = 'XCHAIN_CONFIRMATIONS_' + tick;
                saved[key] = process.env[key];
                delete process.env[key];
            }
        });
        afterEach(() => {
            for(const key of Object.keys(saved)){
                if(saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
        });

        it('defaults everywhere when no override is set', () => {
            for(const net of ['mainnet', 'testnet', 'regtest'])
                expect(coins.resolveConfirmations({}, net)).to.deep.equal(coins.DEFAULT_CONFIRMATIONS);
        });

        it('clamps an env override below the default up to the floor on mainnet', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = '1';
            const out = coins.resolveConfirmations({}, 'mainnet');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
        });

        it('clamps a p2pConfig override below the default on mainnet', () => {
            const out = coins.resolveConfirmations({ XCHAIN_CONFIRMATIONS_DOGE: '2' }, 'mainnet');
            expect(out.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
        });

        it('allows raising the depth above the default on mainnet', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = String(coins.DEFAULT_CONFIRMATIONS.BTC + 4);
            const out = coins.resolveConfirmations({}, 'mainnet');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC + 4);
        });

        it('allows lowering the depth on testnet and regtest (drill seam)', () => {
            process.env.XCHAIN_CONFIRMATIONS_LTC = '1';
            expect(coins.resolveConfirmations({}, 'testnet').LTC).to.equal(1);
            expect(coins.resolveConfirmations({}, 'regtest').LTC).to.equal(1);
        });

        it('env override takes precedence over p2pConfig', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = '20';
            const out = coins.resolveConfirmations({ XCHAIN_CONFIRMATIONS_BTC: '30' }, 'regtest');
            expect(out.BTC).to.equal(20);
        });

        it('falls back to the default on a garbage or non-positive override', () => {
            process.env.XCHAIN_CONFIRMATIONS_BTC = 'banana';
            process.env.XCHAIN_CONFIRMATIONS_LTC = '-3';
            const out = coins.resolveConfirmations({}, 'regtest');
            expect(out.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
            expect(out.LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
        });
    });
});
