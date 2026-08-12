'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// a validator hub resolves BTC network and per-coin indexer URL from
// its validated HUB_NETWORK, never from the configs table's regtest>testnet>
// mainnet preference order. Both resolvers used to take the first configured
// network, so a multi-network configs tree anchored a mainnet round to the
// regtest tip (OracleRound) and handed regtest indexer URLs to the checkpoint,
// attestation and cross-chain engines while every consensus gate read mainnet.
// _indexerCoinMismatch cannot catch that: a regtest BTC indexer reports coin=BTC.
// Standalone hubs (HUB_NETWORK unset) keep the dev-loop preference order.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

describe('XChainHub network resolution honours HUB_NETWORK', function () {

    let XChainHub, axiosStub, mockDb, errorLog;

    const ENV_KEYS = ['BTC_INDEXER_API_URL', 'BTC_INDEXER_URL', 'DOGE_INDEXER_API_URL',
                      'DOGE_INDEXER_URL', 'INDEXER_COIN_CHECK'];
    let savedEnv;

    // A configs tree carrying BOTH regtest and mainnet legs: the shape the finding is about.
    const MULTI_NETWORK_CONFIGS = {
        bitcoin: {
            regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3514 } },
            mainnet: { 'xchain-indexer': { host: '10.0.0.9',  port: 3500 } }
        },
        dogecoin: {
            regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3524 } },
            mainnet: { 'xchain-indexer': { host: '10.0.0.9',  port: 3520 } }
        }
    };

    before(function () {
        this.timeout(30000);
        axiosStub = { post: sinon.stub() };
        XChainHub = proxyquire('../../src/XChainHub', {
            'axios': axiosStub,
            './db': function () { return mockDb; }
        });
    });

    beforeEach(function () {
        savedEnv = {};
        for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
        axiosStub.post.reset();
        axiosStub.post.resolves({ data: { result: {} } });
        mockDb = { getAllConfigs: sinon.stub().resolves({}) };
        errorLog = sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
        for (const k of ENV_KEYS) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
    });

    // Validator mode: p2pConfig carries the HUB_NETWORK api.js validated.
    function validatorHub(network, configs) {
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: network });
        mockDb.getAllConfigs.resolves(configs);
        hub.db = mockDb;
        return hub;
    }

    // Standalone mode: no p2pConfig, so this.network === '' and no consensus runs.
    function standaloneHub(configs) {
        const hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
        mockDb.getAllConfigs.resolves(configs);
        hub.db = mockDb;
        return hub;
    }

    describe('_resolveBtcNetwork', function () {

        it('returns HUB_NETWORK, not the regtest leg, on a multi-network tree', async function () {
            const hub = validatorHub('mainnet', MULTI_NETWORK_CONFIGS);
            expect(await hub._resolveBtcNetwork()).to.equal('mainnet');
        });

        it('returns HUB_NETWORK for a testnet validator whose tree also holds regtest', async function () {
            const hub = validatorHub('testnet', {
                bitcoin: {
                    regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3514 } },
                    testnet: { 'xchain-indexer': { host: '10.0.0.8',  port: 3510 } }
                }
            });
            expect(await hub._resolveBtcNetwork()).to.equal('testnet');
        });

        it('fails closed when the tree carries only OTHER networks', async function () {
            const hub = validatorHub('mainnet', {
                bitcoin: { regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3514 } } }
            });
            let threw = null;
            try { await hub._resolveBtcNetwork(); } catch (e) { threw = e; }
            expect(threw).to.not.equal(null);
            expect(threw.message).to.contain('HUB_NETWORK=mainnet');
        });

        it('returns its own network (never mainnet) when nothing is configured', async function () {
            expect(await validatorHub('regtest', {})._resolveBtcNetwork()).to.equal('regtest');
            expect(await validatorHub('regtest', { bitcoin: {} })._resolveBtcNetwork()).to.equal('regtest');
        });

        it('returns its own network when the configs read fails', async function () {
            const hub = validatorHub('testnet', {});
            mockDb.getAllConfigs.rejects(new Error('db down'));
            expect(await hub._resolveBtcNetwork()).to.equal('testnet');
        });

        it('keeps the regtest>testnet>mainnet preference for a standalone hub', async function () {
            expect(await standaloneHub(MULTI_NETWORK_CONFIGS)._resolveBtcNetwork()).to.equal('regtest');
        });
    });

    describe('_resolveIndexerUrl', function () {

        it('resolves the HUB_NETWORK leg, not the regtest one', async function () {
            const hub = validatorHub('mainnet', MULTI_NETWORK_CONFIGS);
            expect(await hub._resolveIndexerUrl('BTC')).to.equal('http://10.0.0.9:3500');
            expect(await hub._resolveIndexerUrl('DOGE')).to.equal('http://10.0.0.9:3520');
        });

        it('returns null rather than another network when its own leg is absent', async function () {
            const hub = validatorHub('mainnet', {
                bitcoin: { regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3514 } } }
            });
            expect(await hub._resolveIndexerUrl('BTC')).to.equal(null);
        });

        it('returns null when its own leg is present but incomplete', async function () {
            const hub = validatorHub('mainnet', {
                bitcoin: {
                    mainnet: { 'xchain-indexer': { host: '10.0.0.9' } },   // no port
                    regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3514 } }
                }
            });
            expect(await hub._resolveIndexerUrl('BTC')).to.equal(null);
        });

        it('still honours the explicit env override on a validator hub', async function () {
            process.env.BTC_INDEXER_API_URL = 'http://operator-override:3599';
            const hub = validatorHub('mainnet', MULTI_NETWORK_CONFIGS);
            expect(await hub._resolveIndexerUrl('BTC')).to.equal('http://operator-override:3599');
        });

        it('keeps the preference order for a standalone hub', async function () {
            expect(await standaloneHub(MULTI_NETWORK_CONFIGS)._resolveIndexerUrl('BTC'))
                .to.equal('http://127.0.0.1:3514');
        });
    });

    // The scheduler tick must degrade, not crash, on the fail-closed throw.
    it('_resolveBtcLatestBlock returns null instead of throwing on a cross-network tree', async function () {
        const hub = validatorHub('mainnet', {
            bitcoin: { regtest: { 'xchain-indexer': { host: '127.0.0.1', port: 3514 } } }
        });
        mockDb.getChainTip = sinon.stub().resolves(null);
        expect(await hub._resolveBtcLatestBlock()).to.equal(null);
        expect(errorLog.called).to.equal(true);
    });
});
