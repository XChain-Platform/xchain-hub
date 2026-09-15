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

const SAVED = {};
const setEnv = (k, v) => { SAVED[k] = process.env[k]; if(v === undefined) delete process.env[k]; else process.env[k] = v; };

function registerEnvironmentOverrideTests() {
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
}

function registerAirdropOverrideTests() {
        // The airdrop bucket set decides how much XCHAIN each
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
}

function registerCoinEnvironmentTests() {
    describe('env overrides (the only place coin env vars are read)', () => {
        afterEach(() => { for(const k of Object.keys(SAVED)){ if(SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } });
        registerEnvironmentOverrideTests();
        registerAirdropOverrideTests();
    });
}

describe('coins registry', () => {
    registerCoinEnvironmentTests();
});
