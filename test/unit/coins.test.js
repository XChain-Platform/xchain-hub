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
    BTC:  { mainnet: '7bab8a359f85b9118c4a5c8898c96131b934c104afe960b5b31c1fe6819e9e08',
            testnet: '63dbeef3ea93fa5ece4ea823f4e1f13d299f274fd869e264d713b58d0e79a66d',
            regtest: '3a33f0830b7138245b05767a905a1820c51b04b4bffd1178a4628e0bf41cafac' },
    LTC:  { mainnet: '2f938bea36e27623ae7af591795025a4328301dcaea24805b38607041ca19457',
            testnet: '39862b4a35bd5c255e68fb065b3bfe0cb3752f4b9a3562a2a23f674fed0482ea',
            regtest: '6e8a60b0aa4f78f1e64353778252b01d09f41b01ad351d6aa26ab354be4d9645' },
    DOGE: { mainnet: 'be6714fe06a047b7cf0d403bf3ea26d8031362567a6936688e894d2ff48fb258',
            testnet: 'c5dca915fb5c8233b52eeac061853b4aa9843d19569870c45ec19d8853136cf6',
            regtest: '51a8be37d15a183723338bf157365d2fa2c28fad36440db958df2dae86f544fb' },
};

describe('coins registry', () => {

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

    it('excludes display-only fields from the consensus subset', () => {
        const subset = coins.consensusSubset('BTC', 'mainnet');
        expect(subset.addresses).to.not.have.property('EXPLORER');
        expect(subset).to.not.have.keys('genesis', 'firstBlock', 'displayName', 'confirmations');
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

        it('applies FEE_DESTINATION override on non-mainnet networks', () => {
            setEnv('XCHAIN_FEE_DESTINATION_BTC_TESTNET', 'tbOverrideAddr');
            expect(coins.getCoinConfig('BTC', 'testnet').addresses.FEE_DESTINATION).to.equal('tbOverrideAddr');
        });

        it('IGNORES the FEE_DESTINATION override on mainnet (consensus pin escape, item 5473)', () => {
            const pinned = coins.getCoinConfig('BTC', 'mainnet').addresses.FEE_DESTINATION;
            setEnv('XCHAIN_FEE_DESTINATION_BTC_MAINNET', 'bcOverrideAddr');
            // On mainnet the env override is dropped so it cannot escape verifyConsensusPin
            // (which hashes only the static bundle) and fork the block-hashed ledger.
            expect(coins.getCoinConfig('BTC', 'mainnet').addresses.FEE_DESTINATION).to.equal(pinned);
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
});
