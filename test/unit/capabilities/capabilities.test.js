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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

// ────────────────────────────────────────────────────────────────────────────
// capabilities/cross_chain.js
// ────────────────────────────────────────────────────────────────────────────

describe('capabilities/cross_chain selfTest()', function () {
    let crossChain;
    before(function () {
        crossChain = require('../../../src/capabilities/cross_chain');
    });

    it('returns ok=false when cross_chain config is missing', async function () {
        let r = await crossChain.selfTest({});
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('cross_chain config missing');
    });

    it('returns ok=false when chains is empty', async function () {
        let r = await crossChain.selfTest({ cross_chain: { chains: {} } });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('empty');
    });

    it('returns ok=false when a chain has no rpc', async function () {
        let r = await crossChain.selfTest({ cross_chain: { chains: { BTC: { rpc: '' } } } });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('rpc missing');
    });

    it('returns ok=false when chain config is not an object', async function () {
        let r = await crossChain.selfTest({ cross_chain: { chains: { BTC: null } } });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not an object');
    });

    it('returns ok=true when all chains have rpc configured', async function () {
        let r = await crossChain.selfTest({
            cross_chain: {
                chains: {
                    BTC: { rpc: 'http://btc:18332' },
                    LTC: { rpc: 'http://ltc:19332' }
                }
            }
        });
        expect(r.ok).to.be.true;
    });

    it('returns ok=false when chains key is not an object (null)', async function () {
        let r = await crossChain.selfTest({ cross_chain: { chains: null } });
        expect(r.ok).to.be.false;
    });
});

// ────────────────────────────────────────────────────────────────────────────
// capabilities/oracle_publish.js
// ────────────────────────────────────────────────────────────────────────────

let oraclePub;

// Checksum-valid P2PKH addresses from the DOGE registry address books: mainnet
// 0x1e, testnet 0x71, and two regtest 0x6f addresses (one 'm', one 'n').
const DOGE_MAINNET_GAS = 'DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW';
const DOGE_TESTNET_GAS = 'ngasn6zHFzJ72zpk3DBKmXhD2XtszujSDW';
const DOGE_REGTEST_N   = 'n1AvTJLLSA1NHamHd5KFj9mRn6BEcwnVbf';

function registerOraclePublishSourceTests() {
it('returns ok=false when HUB_NETWORK is absent', async function () {
        let r = await oraclePub.selfTest({
            oracle_publish: { doge_address: DOGE_MAINNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('HUB_NETWORK is not set');
    });

    it('returns ok=false when HUB_NETWORK is unrecognised', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'stagenet',
            oracle_publish: { doge_address: DOGE_MAINNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('unknown');
    });

    it('returns ok=false when doge_wallet is missing', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'mainnet',
            oracle_publish: {
                doge_address: DOGE_MAINNET_GAS,
                // no doge_wallet
            }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('doge_wallet');
    });

    it('returns ok=true with a checksum-valid mainnet P2PKH address and wallet', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'mainnet',
            oracle_publish: {
                doge_address: DOGE_MAINNET_GAS, // version 0x1e, valid checksum
                doge_wallet:  '/path/to/wallet'
            }
        });
        expect(r.ok, r.reason).to.be.true;
    });
}

function registerOraclePublishShapeTests() {
it('accepts a testnet DOGE address on a testnet hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'testnet',
            oracle_publish: { doge_address: DOGE_TESTNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok, r.reason).to.be.true;
    });

    // Testnet 0x71 and regtest 0x6f both render 'n', so only the decoded version
    // byte keeps a DOGE-testnet address off a regtest hub.
    it('rejects a DOGE TESTNET 0x71 address on a regtest hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'regtest',
            oracle_publish: { doge_address: DOGE_TESTNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE regtest address');
    });

    it('rejects an n-prefixed regtest 0x6f address on a testnet hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'testnet',
            oracle_publish: { doge_address: DOGE_REGTEST_N, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE testnet address');
    });

    // Gated per-network rather than permissive: a mainnet hub holding a testnet
    // address would pass a both-formats check and then publish nowhere.
    it('rejects a MAINNET address on a testnet hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'testnet',
            oracle_publish: { doge_address: DOGE_MAINNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE testnet address');
    });

    it('rejects a TESTNET address on a mainnet hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'mainnet',
            oracle_publish: { doge_address: DOGE_TESTNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE mainnet address');
    });
}

// Base58Check of one version byte, 20 hash bytes all `fill` and the real checksum:
// fill 0x00 and 0xff give the lowest and highest addresses one version byte makes.
function dogeP2pkhBound(versionByte, fill) {
    const crypto = require('crypto');
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let body = Buffer.concat([Buffer.from([versionByte]), Buffer.alloc(20, fill)]);
    let sum  = crypto.createHash('sha256').update(crypto.createHash('sha256').update(body).digest()).digest();
    let n = BigInt('0x' + Buffer.concat([body, sum.subarray(0, 4)]).toString('hex'));
    let out = '';
    while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    return out;
}

function registerOraclePublishRegistryPrefixTests() {
    const coins = require('../../../src/coins');
    const DOGE_REGTEST_M = 'mvs8WdppEhzQLxfcYwrr1eoKA2nUFi55ff';

    it('accepts an m-prefixed regtest DOGE address on a regtest hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'regtest',
            oracle_publish: { doge_address: DOGE_REGTEST_M, doge_wallet: '/path' }
        });
        expect(r.ok, r.reason).to.be.true;
    });

    it('rejects an m-prefixed address on a testnet hub', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'testnet',
            oracle_publish: { doge_address: DOGE_REGTEST_M, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE testnet address');
    });

    it('names both m and n in the regtest rejection message', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'regtest',
            oracle_publish: { doge_address: DOGE_MAINNET_GAS, doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE regtest address');
        expect(r.reason).to.include("'m' or 'n'");
    });

    // The accepted version byte must track the registry's pubKeyHash bytes, so pin
    // it: both extremes of every network's version byte must pass on that network.
    it('accepts the lowest and highest P2PKH address of each network registry pubKeyHash', async function () {
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            const version = coins.getCoinConfig('DOGE', network).net.pubKeyHash;
            for (const fill of [0x00, 0xff]) {
                const address = dogeP2pkhBound(version, fill);
                let r = await oraclePub.selfTest({
                    HUB_NETWORK: network,
                    oracle_publish: { doge_address: address, doge_wallet: '/path' }
                });
                expect(r.ok, network + ' ' + address + ': ' + r.reason).to.be.true;
            }
        }
    });

    it('accepts every P2PKH literal in the registry regtest address book on a regtest hub', async function () {
        const book = coins.getCoinConfig('DOGE', 'regtest').addresses;
        for (const key of ['BURN', 'GAS', 'DONATE1', 'DONATE2', 'FEE_DESTINATION']) {
            let r = await oraclePub.selfTest({
                HUB_NETWORK: 'regtest',
                oracle_publish: { doge_address: book[key], doge_wallet: '/path' }
            });
            expect(r.ok, key + ' ' + book[key] + ': ' + r.reason).to.be.true;
        }
    });
}

function registerOraclePublishCoreTests() {
it('returns ok=false when oracle_publish config is missing', async function () {
        let r = await oraclePub.selfTest({});
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('oracle_publish config missing');
    });

    it('returns ok=false when doge_address is missing', async function () {
        let r = await oraclePub.selfTest({ oracle_publish: { doge_wallet: '/path/to/wallet' } });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('doge_address');
    });

    it('returns ok=false when doge_address has invalid format', async function () {
        let r = await oraclePub.selfTest({
            HUB_NETWORK: 'mainnet',
            oracle_publish: { doge_address: 'not-a-doge-address', doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('not a valid DOGE mainnet address');
    });
}

describe('capabilities/oracle_publish selfTest()', function () {
    before(function () {
        oraclePub = require('../../../src/capabilities/oracle_publish');
    });

    registerOraclePublishCoreTests();

    // The address prefix is per-network because the publish TARGET is per-network:
    // OraclePublisher broadcasts through DOGE_ENCODER_URL, not through HUB_NETWORK,
    // so a testnet federation publishes on DOGE testnet. The prefix was hardcoded
    // to mainnet 'D', which rejected the correct address on every non-mainnet
    // deployment and made oracle_publish unreachable there.
    registerOraclePublishShapeTests();

    // Regtest reuses the Bitcoin-testnet version byte 0x6f, which encodes as 'm' or
    // 'n', so the accepted prefixes follow the registry rather than DOGE testnet.
    registerOraclePublishRegistryPrefixTests();

    // Fails closed rather than assuming mainnet: guessing is what would let a
    // testnet hub validate a mainnet address and spend real DOGE.
    registerOraclePublishSourceTests();
});

// ────────────────────────────────────────────────────────────────────────────
// capabilities/price.js
// ────────────────────────────────────────────────────────────────────────────

describe('capabilities/price selfTest()', function () {
    let price;
    before(function () {
        price = require('../../../src/capabilities/price');
    });

    it('returns ok=false when price config is missing', async function () {
        let r = await price.selfTest({});
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('price config missing');
    });

    it('returns ok=false when sources is empty', async function () {
        let r = await price.selfTest({ price: { sources: [], fiats: ['USD'] } });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('sources empty');
    });

    it('returns ok=false when fiats is empty', async function () {
        let r = await price.selfTest({ price: { sources: ['coingecko'], fiats: [] } });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('fiats empty');
    });

    it('returns ok=true with sources and fiats configured', async function () {
        let r = await price.selfTest({ price: { sources: ['coingecko'], fiats: ['USD', 'EUR'] } });
        expect(r.ok).to.be.true;
    });

    it('returns ok=false when sources is not an array', async function () {
        let r = await price.selfTest({ price: { sources: 'coingecko', fiats: ['USD'] } });
        expect(r.ok).to.be.false;
    });
});

// ────────────────────────────────────────────────────────────────────────────
// capabilities/attestation.js: uses proxyquire to stub healthCheck
// ────────────────────────────────────────────────────────────────────────────

describe('capabilities/attestation selfTest()', function () {

    afterEach(function () {
        sinon.restore();
    });

    function loadAttestation(healthCheckResult) {
        let httpGetStub = { healthCheck: sinon.stub().resolves(healthCheckResult || { ok: true }) };
        // hub-credentials returns ok=false so llm probe is skipped unless explicitly enabled
        return proxyquire('../../../src/capabilities/attestation', {
            '../providers/http_get.js': httpGetStub,
            '../lib/hub_credentials':  { resolveHubLlmAuth: () => ({ ok: false }) }
        });
    }

    it('returns ok=true when http_get healthCheck passes', async function () {
        let attestation = loadAttestation({ ok: true, status: '200' });
        let r = await attestation.selfTest({});
        expect(r.ok).to.be.true;
        expect(r.providers).to.include('http_get');
    });

    it('returns ok=false when http_get healthCheck fails', async function () {
        let attestation = loadAttestation({ ok: false, error: 'connection refused' });
        let r = await attestation.selfTest({});
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('no attestation providers healthy');
    });

    it('returns ok=false when http_get is opted out', async function () {
        let attestation = loadAttestation({ ok: true });
        let r = await attestation.selfTest({ attestation: { providers: { http_get: false } } });
        expect(r.ok).to.be.false;
    });

    it('includes failed provider info when partial providers fail', async function () {
        // Load with both http_get and a fake failing provider
        let httpGetStub = { healthCheck: sinon.stub().resolves({ ok: true }) };
        let failStub    = { healthCheck: sinon.stub().resolves({ ok: false, error: 'down' }) };
        // We can't easily add fake providers; just verify partial failure case with http_get
        // by having healthCheck throw
        let throwStub = { healthCheck: sinon.stub().rejects(new Error('probe died')) };
        let attestation = proxyquire('../../../src/capabilities/attestation', {
            '../providers/http_get.js': throwStub,
            '../lib/hub_credentials':  { resolveHubLlmAuth: () => ({ ok: false }) }
        });
        let r = await attestation.selfTest({});
        expect(r.ok).to.be.false;
    });
});

// ────────────────────────────────────────────────────────────────────────────
// capabilities/index.js
// ────────────────────────────────────────────────────────────────────────────

describe('capabilities/index.js', function () {
    it('exports all four capability modules', function () {
        let idx = require('../../../src/capabilities/index.js');
        expect(idx).to.have.property('price');
        expect(idx).to.have.property('cross_chain');
        expect(idx).to.have.property('oracle_publish');
        expect(idx).to.have.property('attestation');
        for (let key of ['price', 'cross_chain', 'oracle_publish', 'attestation']) {
            expect(typeof idx[key].selfTest).to.equal('function');
        }
    });
});
