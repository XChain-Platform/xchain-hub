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
const fc         = require('fast-check');
const proxyquire = require('proxyquire');
const gen        = require('./generators');

describe('Fuzz: XChainHub.getFeeQuote()', function () {

    let XChainHub, hub, dbStub;

    // Known actions in the gas schedule
    const KNOWN_ACTIONS = [
        'ISSUE', 'ISSUE_SUBTOKEN', 'EXPIRATION_PER_DAY', 'OWNERSHIP_ESCROW',
        'AIRDROP_PER_RECIPIENT', 'DIVIDEND_PER_RECIPIENT',
        'VM_EXECUTE_BASE', 'VM_DEPLOY_BASE', 'VM_DEPLOY_PER_BYTE',
        'VM_STATE_READ', 'VM_STATE_WRITE', 'VM_STATE_DELETE',
        'VM_ORACLE_READ', 'VM_CROSSCHAIN_READ', 'VM_ATTEST_REQUEST',
        'VM_EMISSION', 'VM_COMPUTATION'
    ];

    beforeEach(function () {
        // Stub the Database class to avoid real MariaDB connections
        dbStub = {
            doQuery: sinon.stub().resolves([]),
            setParam: sinon.stub().resolves(),
            getConfig: sinon.stub().resolves({}),
            getAllConfigs: sinon.stub().resolves({}),
            close: sinon.stub().resolves()
        };

        XChainHub = proxyquire('../../src/XChainHub', {
            './db': function () { return dbStub; }
        });

        hub = new XChainHub('localhost', '3306', 'testdb', 'user', 'pass');
        hub.db = dbStub;
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Arithmetic properties
    // -----------------------------------------------------------------

    describe('arithmetic properties', function () {

        it('known action returns positive gasCost, valid xchainAmount format', function () {
            return fc.assert(fc.asyncProperty(
                fc.constantFrom(...KNOWN_ACTIONS),
                fc.constantFrom('BTC', 'LTC', 'DOGE'),
                async function (action, chain) {
                    dbStub.doQuery.resolves([]);
                    let result = await hub.getFeeQuote(action, chain);
                    expect(result.gasCost).to.be.a('number').and.greaterThan(0);
                    expect(result.xchainAmount).to.match(/^\d+\.\d{8}$/);
                    expect(result.gasPrice).to.match(/^\d+\.\d{8}$/);
                    expect(result.xchainAmount).to.not.equal('NaN');
                    expect(result.xchainAmount).to.not.include('Infinity');
                }
            ), { numRuns: 50 });
        });

        it('xchainAmount equals gasCost * gasPrice (arithmetic consistency)', function () {
            return fc.assert(fc.asyncProperty(
                fc.constantFrom(...KNOWN_ACTIONS),
                async function (action) {
                    dbStub.doQuery.resolves([]);
                    let result = await hub.getFeeQuote(action, 'BTC');
                    let expected = result.gasCost * parseFloat(result.gasPrice);
                    expect(parseFloat(result.xchainAmount)).to.be.closeTo(expected, 1e-10);
                }
            ), { numRuns: 50 });
        });

        it('nativeCoinAmount is never zero, NaN, or Infinity when coinUsd is positive', function () {
            return fc.assert(fc.asyncProperty(
                fc.double({ min: 0.01, max: 10_000_000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n > 0),
                async function (coinUsdValue) {
                    dbStub.doQuery = sinon.stub().callsFake(function (query) {
                        if (query.includes('coin_pair = ?')) {
                            let params = Array.from(arguments)[1] || [];
                            if (params[0] === 'XCHAIN/BTC') return Promise.resolve([]);
                            return Promise.resolve([{ price: String(coinUsdValue), status: 'finalized' }]);
                        }
                        return Promise.resolve([]);
                    });
                    hub.db = dbStub;

                    let result = await hub.getFeeQuote('ISSUE', 'BTC');

                    if (result.nativeCoinAmount !== undefined) {
                        let nca = parseFloat(result.nativeCoinAmount);
                        expect(Number.isFinite(nca)).to.be.true;
                        expect(nca).to.be.greaterThan(0);
                        expect(result.nativeCoinAmount).to.not.equal('NaN');
                        expect(result.nativeCoinAmount).to.not.include('Infinity');
                    }
                }
            ), { numRuns: 100 });
        });

        it('round-trip: nativeCoinAmount * coinUsd ≈ feeUsd', function () {
            return fc.assert(fc.asyncProperty(
                fc.double({ min: 1, max: 100_000, noNaN: true, noDefaultInfinity: true })
                    .filter(n => Number.isFinite(n) && n >= 1),
                async function (coinUsdValue) {
                    // Use callsFake to handle both getPrice calls correctly
                    dbStub.doQuery = sinon.stub().callsFake(function (query) {
                        if (query.includes('coin_pair = ?')) {
                            // getPrice call — return fuzzed price for BTC/USD, nothing for XCHAIN
                            let args = Array.from(arguments);
                            let params = args[1] || [];
                            if (params[0] === 'XCHAIN/BTC') return Promise.resolve([]);
                            return Promise.resolve([{ price: String(coinUsdValue), status: 'finalized' }]);
                        }
                        return Promise.resolve([]);
                    });
                    hub.db = dbStub;

                    let result = await hub.getFeeQuote('ISSUE', 'BTC');

                    if (result.nativeCoinAmount !== undefined && result.feeUsd !== undefined) {
                        let reconstructed = parseFloat(result.nativeCoinAmount) * parseFloat(result.coinUsd);
                        let feeUsd = parseFloat(result.feeUsd);
                        // toFixed(8) truncates to 8 decimal places. When dividing feeUsd
                        // (~1.0) by a large coinUsd (e.g. 60000), nativeCoinAmount is ~1.6e-5.
                        // toFixed(8) on this loses relative precision. Multiplying back
                        // amplifies the error. Use 1e-3 relative tolerance — still catches
                        // NaN, Infinity, sign errors, and order-of-magnitude bugs.
                        let tolerance = Math.max(Math.abs(feeUsd) * 1e-3, 1e-7);
                        expect(reconstructed).to.be.closeTo(feeUsd, tolerance);
                    }
                }
            ), { numRuns: 100 });
        });
    });

    // -----------------------------------------------------------------
    // Unknown action handling
    // -----------------------------------------------------------------

    describe('unknown action handling', function () {

        it('unknown action string always returns error object (never throws)', function () {
            return fc.assert(fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 30 })
                    .filter(function (s) { return !KNOWN_ACTIONS.includes(s); }),
                async function (action) {
                    dbStub.doQuery.resolves([]);
                    let result = await hub.getFeeQuote(action, 'BTC');
                    expect(result).to.have.property('error');
                    expect(result.error).to.be.a('string');
                }
            ), { numRuns: 100 });
        });

        it('Object.prototype keys (constructor, toString, etc.) are rejected', function () {
            return fc.assert(fc.asyncProperty(
                fc.constantFrom('constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'),
                async function (protoKey) {
                    dbStub.doQuery.resolves([]);
                    let result = await hub.getFeeQuote(protoKey, 'BTC');
                    expect(result).to.have.property('error');
                }
            ), { numRuns: 10 });
        });
    });
});
