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
const GOLDEN_HASH = {
    BTC:  { mainnet: 'f9bb6c6b2fdc073fafd3672d3ccd871d2b00c2567f98eb50b8bc6e30a7bcf41e',
            testnet: '211086b82b345092a8ce18ca08ab945a6b294c59efa5588c70eacdb5ee515e62',
            regtest: 'd900b05a7df14595ff4a2be4bbd9505a661f0c6cef4237f1e00aace3b2397f0e' },
    LTC:  { mainnet: 'd09747c47fc095d1c506acdbbfb05372a0165caf71ddaa37891bb8947213c8f2',
            testnet: '7e4cc52a609606024d1ea8d26c743957e195c660b0bb749e523f4cbdcc82baf8',
            regtest: '769d91cad98ea674494290ac680bb1c0ddb8bcd3b75cbffa131365bf97811db1' },
    DOGE: { mainnet: 'eabae17f3633a36b2257c5bc171bfc5151b9293b5e849eae0fe00eb0a090e9ef',
            testnet: 'd61706332ddcb921b4bb3d0a9f077119426405692fc118eaba8d1a6a9ecb28d0',
            regtest: '3de84c0bf6478e985f0ea0cc0ece155cf2780f0e932c3f6e063d3f01bfc38197' },
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

    it('exposes a per-coin wireFormat family that stays out of the consensus hash', () => {
        const expected = { BTC: 'default', LTC: 'mweb', DOGE: 'auxpow' };
        for(const tick of coins.ALLOWED_COINS){
            expect(coins.WIRE_FORMAT[tick], `${tick} WIRE_FORMAT map`).to.equal(expected[tick]);
            for(const net of coins.NETWORKS){
                const before = coins.consensusHash(tick, net);
                expect(coins.getCoinConfig(tick, net).wireFormat, `${tick}/${net} resolved`).to.equal(expected[tick]);
                // wireFormat is not folded into the pinned subset, so it cannot shift the hash.
                expect(coins.consensusSubset(tick, net)).to.not.have.property('wireFormat');
                expect(coins.consensusHash(tick, net)).to.equal(before);
            }
        }
    });

    it('excludes display-only fields from the consensus subset', () => {
        const subset = coins.consensusSubset('BTC', 'mainnet');
        expect(subset.addresses).to.not.have.property('EXPLORER');
        // .any.keys, not exact-set .keys: the exact-set form is only true when the
        // subset has EXACTLY these keys, so its negation was vacuously true and
        // could never catch a display-only field leaking into the pinned subset.
        expect(subset).to.not.have.any.keys('genesis', 'firstBlock', 'displayName', 'confirmations');
    });

    // Every resolved top-level key that is deliberately NOT part of the hashed
    // consensus subset. Shared classification source for the completeness guard:
    // a NEW top-level coin key must either join consensusSubset() or be added here
    // as a conscious display/operational call. An unclassified key fails the guard
    // instead of silently dropping out of the pin (the golden-hash test only
    // catches changes to fields already IN the subset, not omissions).
    const NON_CONSENSUS_TOP_LEVEL_KEYS = new Set([
        'tick', 'fullName', 'displayName', 'site', // identity/display metadata
        'decimals', 'confirmations',               // display / operator-tunable depth
        'network',                                 // redundant with the (tick, network) hash key
        'firstBlock',                              // node-local scan start, not validity-gating
        'genesis',                                 // deliberately excluded: genesis.js fail-closes on its own hashes
        'FEE_PAYMENT_MODE',                        // informational only; not read at runtime (see coin files)
        'wireFormat',                              // block/tx parse family (decoder/utxo-tracker); not hashed, mirrors the pre-existing decoder-local constant
    ]);

    it('covers every non-display top-level coin key in the consensus subset (completeness guard)', () => {
        for(const tick of coins.ALLOWED_COINS){
            for(const net of coins.NETWORKS){
                const resolved = coins.getCoinConfig(tick, net);
                const subset   = coins.consensusSubset(tick, net);
                for(const key of Object.keys(resolved)){
                    if(NON_CONSENSUS_TOP_LEVEL_KEYS.has(key)) continue;
                    expect(subset, `${tick}/${net}: top-level key '${key}' is neither in consensusSubset nor classified in NON_CONSENSUS_TOP_LEVEL_KEYS`)
                        .to.have.property(key);
                }
            }
        }
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
