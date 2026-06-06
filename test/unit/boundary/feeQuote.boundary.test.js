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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

// Stub all dependencies to isolate XChainHub
let mockDb;
const XChainHub = proxyquire('../../../src/XChainHub', {
    './db.js':              function () { return mockDb; },
    './PeerManager.js':     function () { return null; },
    './Consensus.js':       function () {},
    './ValidatorIdentity.js': function () {},
    './OracleConsensus.js': function () {},
    './OracleRound.js':     function () {},
    './RewardTracker.js':   function () {},
    './SlashDetector.js':   function () {},
    './CrossChainEngine.js': function () {},
    './ReorgHandler.js':    function () {},
    './SwapTracker.js':     function () {},
    './Governance.js':      function () {}
});

describe('Boundary: Fee Quote Calculation', function () {

    let hub;

    beforeEach(function () {
        mockDb = {
            doQuery:        sinon.stub(),
            setParam:       sinon.stub().resolves(),
            createDatabase: sinon.stub().resolves(),
            verifyTables:   sinon.stub().resolves(),
            close:          sinon.stub().resolves()
        };
        // Default: XCHAIN/USD = $1.00 (first doQuery call), no coin/USD (second call onward)
        mockDb.doQuery
            .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
            .resolves([]);
        hub = new XChainHub('host', 3306, 'test_db', 'user', 'pass');
        hub.db = mockDb;
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Gas schedule boundaries
    // -----------------------------------------------------------------

    describe('action lookup', function () {

        it('known action ISSUE returns gas cost 100000', async function () {
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.gasCost).to.equal(100000);
        });

        it('known action ISSUE_SUBTOKEN returns gas cost 50000', async function () {
            let result = await hub.getFeeQuote('ISSUE_SUBTOKEN', 'BTC');
            expect(result.gasCost).to.equal(50000);
        });

        it('unknown action returns error', async function () {
            let result = await hub.getFeeQuote('NONEXISTENT', 'BTC');
            expect(result.error).to.include('unknown action');
        });

        it('empty string action returns error', async function () {
            let result = await hub.getFeeQuote('', 'BTC');
            expect(result.error).to.include('unknown action');
        });
    });

    // -----------------------------------------------------------------
    // Gas price calculation precision
    // -----------------------------------------------------------------

    describe('gas price calculation', function () {

        it('ISSUE: 100000 * 0.00001 = 1.00000000 (exact)', async function () {
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.xchainAmount).to.equal('1.00000000');
        });

        it('ISSUE_SUBTOKEN: 50000 * 0.00001 = 0.50000000', async function () {
            let result = await hub.getFeeQuote('ISSUE_SUBTOKEN', 'BTC');
            expect(result.xchainAmount).to.equal('0.50000000');
        });

        it('EXPIRATION_PER_DAY: 550 * 0.00001 = 0.00550000', async function () {
            let result = await hub.getFeeQuote('EXPIRATION_PER_DAY', 'BTC');
            expect(result.xchainAmount).to.equal('0.00550000');
        });

        it('gasPrice is formatted to 8 decimal places', async function () {
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.gasPrice).to.equal('0.00001000');
        });
    });

    // -----------------------------------------------------------------
    // Oracle price integration
    // -----------------------------------------------------------------

    describe('oracle price boundaries', function () {

        it('XCHAIN/USD unavailable → throws with descriptive error', async function () {
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery.resolves([]);
            let threw = false;
            try {
                await hub.getFeeQuote('ISSUE', 'BTC');
            } catch (e) {
                threw = true;
                expect(e.message).to.match(/XCHAIN\/USD oracle price unavailable/);
            }
            expect(threw, 'expected getFeeQuote to throw').to.equal(true);
        });

        it('XCHAIN/USD = 0 → throws (zero price guard)', async function () {
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery
                .onFirstCall().resolves([{ price: '0', status: 'finalized' }])
                .resolves([]);
            let threw = false;
            try {
                await hub.getFeeQuote('ISSUE', 'BTC');
            } catch (e) {
                threw = true;
                expect(e.message).to.match(/zero or negative/);
            }
            expect(threw, 'expected getFeeQuote to throw').to.equal(true);
        });

        it('XCHAIN/USD available, no coin/USD → result includes xchainUsd but no nativeCoinAmount', async function () {
            // Default beforeEach: XCHAIN/USD = 1.00, coin/USD = null
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.xchainUsd).to.equal('1.00000000');
            expect(result.nativeCoinAmount).to.be.undefined;
            expect(result.feeUsd).to.be.undefined;
        });

        it('coin price = 0 → nativeCoinAmount fields omitted (division guard)', async function () {
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery
                .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
                .onSecondCall().resolves([{ price: '0', status: 'finalized' }]);
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.xchainUsd).to.equal('1.00000000');
            expect(result.nativeCoinAmount).to.be.undefined;
        });

        it('valid coin price → nativeCoinAmount computed', async function () {
            // XCHAIN/USD = 2.00, BTC/USD = 100000
            // xchainAmount = 1.0, feeUsd = 2.0, nativeCoinAmount = 2.0 / 100000 = 0.00002
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery
                .onFirstCall().resolves([{ price: '2.00', status: 'finalized' }])
                .onSecondCall().resolves([{ price: '100000', status: 'finalized' }]);
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.nativeCoinAmount).to.equal('0.00002000');
            expect(result.xchainUsd).to.equal('2.00000000');
            expect(result.feeUsd).to.equal('2.00000000');
            expect(result.coinUsd).to.equal('100000.00000000');
        });

        it('XCHAIN/USD = 1.00, coin price = 100000 → nativeCoinAmount = 0.00001000', async function () {
            // Regression: verifies the $1 oracle result matches the former hardcoded placeholder
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery
                .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
                .onSecondCall().resolves([{ price: '100000', status: 'finalized' }]);
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            expect(result.nativeCoinAmount).to.equal('0.00001000');
            expect(result.coinUsd).to.equal('100000.00000000');
        });

        it('very small coin price → large nativeCoinAmount', async function () {
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery
                .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
                .onSecondCall().resolves([{ price: '0.00000001', status: 'finalized' }]);
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            // nativeCoinAmount = 1.0 / 0.00000001 = 100000000
            expect(result.nativeCoinAmount).to.equal('100000000.00000000');
        });

        it('very large coin price → very small nativeCoinAmount', async function () {
            mockDb.doQuery.resetBehavior();
            mockDb.doQuery
                .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
                .onSecondCall().resolves([{ price: '1000000', status: 'finalized' }]);
            let result = await hub.getFeeQuote('ISSUE', 'BTC');
            // nativeCoinAmount = 1.0 / 1000000 = 0.000001
            expect(result.nativeCoinAmount).to.equal('0.00000100');
        });
    });
});
