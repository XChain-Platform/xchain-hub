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
const PriceFetcher    = require('../../../src/PriceFetcher');
const OracleRound     = require('../../../src/OracleRound');
const OracleConsensus = require('../../../src/OracleConsensus');
const { createMockHub }        = require('../../helpers/mockHub');
const { VALIDATORS_4, SAMPLE_PRICES } = require('../../helpers/fixtures');
const { runExperiment }        = require('../helpers/chaosRunner');
const mockApi                  = require('../../helpers/mockExternalApi');

describe('Chaos: Total Price Source Blackout (API-6)', function () {
    this.timeout(10000);

    before(function () {
        mockApi.setup();
    });

    after(function () {
        mockApi.teardown();
    });

    beforeEach(function () {
        mockApi.reset();
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('all sources unavailable → fetchPrices returns empty array', async function () {
        let fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  1000
        });

        mockApi.mockCoinGeckoError(500);
        mockApi.mockCmcError(500);

        let prices = await fetcher.fetchPrices();
        expect(prices).to.be.an('array').that.is.empty;
    });

    it('all sources timeout → fetchPrices returns empty array', async function () {
        let fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  500 // Very short timeout
        });

        mockApi.mockCoinGeckoTimeout(5000);
        // CMC not mocked = will fail with nock disable

        let prices = await fetcher.fetchPrices();
        expect(prices).to.be.an('array').that.is.empty;
    });

    it('oracle round skips when no prices available', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves([]);

        let prevRound = oracle.currentRound;
        await oracle._executeRound();

        // Round incremented but no broadcast
        expect(oracle.currentRound).to.equal(prevRound + 1);
        expect(hub._peerManager.broadcast.called).to.be.false;

        // Warning logged
        expect(console.warn.calledWithMatch('No prices available')).to.be.true;
    });

    it('oracle round skips when fetchPrices throws', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        sinon.stub(oracle.priceFetcher, 'fetchPrices')
            .rejects(new Error('Network error'));

        await oracle._executeRound();

        expect(hub._peerManager.broadcast.called).to.be.false;
        expect(console.error.calledWithMatch('Price fetch failed')).to.be.true;
    });

    it('consensus stores skipped round when no submissions', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);
        let oracleConsensus = new OracleConsensus(hub, oracle);

        // No submissions for round 5
        oracle.currentRound = 5;

        await oracleConsensus.finalizeRound(5);

        // Should store skipped round (3 coin pairs)
        expect(hub.db.doQuery.callCount).to.equal(3);
        let firstCall = hub.db.doQuery.getCall(0).args;
        expect(firstCall[0]).to.include('skipped');
        expect(firstCall[1][0]).to.equal(5);

        // Round should be marked as finalized
        expect(oracleConsensus.finalized.has(5)).to.be.true;
    });

    it('consensus stores skipped round when below min submissions', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);
        let oracleConsensus = new OracleConsensus(hub, oracle);
        oracleConsensus.minSubmissions = 3;

        // Only 1 submission (below minimum of 3)
        oracle.currentRound = 10;
        oracle.submissions.set(10, new Map([
            ['ws://v1:10001', { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() }]
        ]));

        await oracleConsensus.finalizeRound(10);

        // Should store as skipped
        expect(hub.db.doQuery.called).to.be.true;
        let firstCall = hub.db.doQuery.getCall(0).args;
        expect(firstCall[0]).to.include('skipped');
    });

    it('non-oracle subsystems unaffected during price blackout', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves([]);

        // Execute failed oracle round
        await oracle._executeRound();

        // Hub's other methods remain callable
        expect(hub.applyConfig.called).to.be.false;  // Not touched
        expect(hub.db.doQuery.called).to.be.false;    // No DB writes for empty round
    });

    it('recovery: sources come back → next round produces valid prices', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        // Round 1: blackout
        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves([]);
        await oracle._executeRound();
        expect(hub._peerManager.broadcast.called).to.be.false;

        // Round 2: recovery
        oracle.priceFetcher.fetchPrices.restore();
        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves(SAMPLE_PRICES);
        await oracle._executeRound();

        expect(hub._peerManager.broadcast.calledOnce).to.be.true;
        let data = hub._peerManager.broadcast.getCall(0).args[1];
        expect(data.prices).to.have.length(3);
        expect(parseFloat(data.prices[0].price)).to.be.gt(0);
    });

    it('multiple consecutive blackout rounds → no crash or state corruption', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves([]);

        // Run 5 consecutive blackout rounds
        for (let i = 0; i < 5; i++) {
            await oracle._executeRound();
        }

        expect(oracle.currentRound).to.equal(5);
        expect(hub._peerManager.broadcast.called).to.be.false;

        // Submissions map should only have current and previous round
        expect(oracle.submissions.size).to.be.lte(2);
    });
});
