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
const coins      = require('../../src/coins');

describe('Fuzz: XChainHub.getFeeQuote()', function () {

    let XChainHub, hub, dbStub;

    // Known actions = the canonical GAS_SCHEDULE keys, sourced from the coin
    // registry (getFeeQuote now serves the schedule from the same bundle). Deriving
    // this here rather than hardcoding keeps the known/unknown split in step with a
    // schedule repin, so a new metered action can't silently pass the "unknown
    // action" filter below (this list previously drifted, omitting VM_XCALL_REQUEST /
    // VM_XCALL_CALLBACK / VM_GUARD_GAS_CEILING).
    const KNOWN_ACTIONS = Object.keys(coins.getCoinConfig('BTC', 'mainnet').GAS_SCHEDULE);

    // getFeeQuote is fail-closed on the XCHAIN/USD oracle (deepdive L-5): with no
    // finalized round it throws rather than quoting off a missing price. The
    // arithmetic properties below therefore have to hand it a live oracle; they
    // used to resolve every query to [], which made every "known action" run throw
    // before it reached a single assertion. Fail-closed is covered explicitly by
    // its own property at the bottom of this file.
    function priceStub (prices) {
        return sinon.stub().callsFake(function (query, params) {
            if (query.includes('coin_pair = ?')) {
                let pair = (params || [])[0];
                if (Object.prototype.hasOwnProperty.call(prices, pair)) {
                    // No block_timestamp: getPriceStatus treats an unstamped row as
                    // fresh, keeping these properties about arithmetic, not clocks.
                    return Promise.resolve([{ price: String(prices[pair]), status: 'finalized' }]);
                }
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        });
    }

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
                    dbStub.doQuery = priceStub({
                        'XCHAIN/USD': '0.05',
                        'BTC/USD': '60000', 'LTC/USD': '80', 'DOGE/USD': '0.12'
                    });
                    hub.db = dbStub;
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
                    dbStub.doQuery = priceStub({ 'XCHAIN/USD': '0.05', 'BTC/USD': '60000' });
                    hub.db = dbStub;
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
                            // getPrice call: return fuzzed price for BTC/USD, nothing for XCHAIN
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
                        // amplifies the error. Use 1e-3 relative tolerance (still catches
                        // NaN, Infinity, sign errors, and order-of-magnitude bugs).
                        let tolerance = Math.max(Math.abs(feeUsd) * 1e-3, 1e-7);
                        expect(reconstructed).to.be.closeTo(feeUsd, tolerance);
                    }
                }
            ), { numRuns: 100 });
        });
    });

    // -----------------------------------------------------------------
    // Oracle fail-closed (deepdive L-5)
    // -----------------------------------------------------------------

    describe('oracle fail-closed', function () {

        it('every known action rejects when XCHAIN/USD has no finalized round', function () {
            return fc.assert(fc.asyncProperty(
                fc.constantFrom(...KNOWN_ACTIONS),
                fc.constantFrom('BTC', 'LTC', 'DOGE'),
                async function (action, chain) {
                    // Coin price present, XCHAIN price absent: quoting must still refuse.
                    dbStub.doQuery = priceStub({ 'BTC/USD': '60000', 'LTC/USD': '80', 'DOGE/USD': '0.12' });
                    hub.db = dbStub;
                    let threw = null;
                    try { await hub.getFeeQuote(action, chain); } catch (e) { threw = e; }
                    expect(threw, 'getFeeQuote must not quote without an XCHAIN/USD price').to.not.equal(null);
                    expect(threw.message).to.match(/XCHAIN\/USD oracle price/);
                }
            ), { numRuns: 30 });
        });

        it('a zero or negative XCHAIN/USD price is rejected', function () {
            return fc.assert(fc.asyncProperty(
                fc.constantFrom('0', '0.00000000', '-1', '-0.0001'),
                async function (badPrice) {
                    dbStub.doQuery = priceStub({ 'XCHAIN/USD': badPrice, 'BTC/USD': '60000' });
                    hub.db = dbStub;
                    let threw = null;
                    try { await hub.getFeeQuote('ISSUE', 'BTC'); } catch (e) { threw = e; }
                    expect(threw, 'a non-positive XCHAIN/USD price must not produce a quote').to.not.equal(null);
                }
            ), { numRuns: 4 });
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
