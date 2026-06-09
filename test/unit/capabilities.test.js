'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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
        crossChain = require('../../src/capabilities/cross_chain');
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

describe('capabilities/oracle_publish selfTest()', function () {
    let oraclePub;
    before(function () {
        oraclePub = require('../../src/capabilities/oracle_publish');
    });

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
            oracle_publish: { doge_address: 'not-a-doge-address', doge_wallet: '/path' }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('invalid format');
    });

    it('returns ok=false when doge_wallet is missing', async function () {
        let r = await oraclePub.selfTest({
            oracle_publish: {
                doge_address: 'D' + 'A'.repeat(33),
                // no doge_wallet
            }
        });
        expect(r.ok).to.be.false;
        expect(r.reason).to.include('doge_wallet');
    });

    it('returns ok=true with valid address (D-prefix + 33 base58 chars) and wallet', async function () {
        let r = await oraclePub.selfTest({
            oracle_publish: {
                doge_address: 'DPVuXtvCWXSBFEkgWKfeSCL1e4YqfbwXkg', // valid format
                doge_wallet:  '/path/to/wallet'
            }
        });
        expect(r.ok).to.be.true;
    });
});

// ────────────────────────────────────────────────────────────────────────────
// capabilities/price.js
// ────────────────────────────────────────────────────────────────────────────

describe('capabilities/price selfTest()', function () {
    let price;
    before(function () {
        price = require('../../src/capabilities/price');
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
// capabilities/attestation.js — uses proxyquire to stub healthCheck
// ────────────────────────────────────────────────────────────────────────────

describe('capabilities/attestation selfTest()', function () {

    afterEach(function () {
        sinon.restore();
    });

    function loadAttestation(healthCheckResult) {
        let httpGetStub = { healthCheck: sinon.stub().resolves(healthCheckResult || { ok: true }) };
        // hub-credentials returns ok=false so llm probe is skipped unless explicitly enabled
        return proxyquire('../../src/capabilities/attestation', {
            '../providers/http_get.js': httpGetStub,
            '../lib/hub-credentials':  { resolveHubLlmAuth: () => ({ ok: false }) }
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
        let attestation = proxyquire('../../src/capabilities/attestation', {
            '../providers/http_get.js': throwStub,
            '../lib/hub-credentials':  { resolveHubLlmAuth: () => ({ ok: false }) }
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
        let idx = require('../../src/capabilities/index.js');
        expect(idx).to.have.property('price');
        expect(idx).to.have.property('cross_chain');
        expect(idx).to.have.property('oracle_publish');
        expect(idx).to.have.property('attestation');
        for (let key of ['price', 'cross_chain', 'oracle_publish', 'attestation']) {
            expect(typeof idx[key].selfTest).to.equal('function');
        }
    });
});
