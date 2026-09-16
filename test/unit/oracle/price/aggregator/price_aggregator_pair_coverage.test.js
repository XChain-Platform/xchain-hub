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

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const PriceAggregator  = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');

// Mirror of the canonical PRICE v0 payload (xchain-indexer/src/consensus/ed25519.js)
// buildPriceV0Payload. Tests sign these exact bytes. The mockHub has no `network`,
// so the EQUIV header is OFF (unknown network) and this is the bare-JSON branch;
// btc_block_height still rides in the signed content (#4232).
function buildPriceV0Payload(round, timestamp, pairs, btcBlockHeight) {
    let sortedPairs = pairs
        .map(p => ({ pair: p.pair, price: String(p.price) }))
        .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
    return JSON.stringify({
        round:            parseInt(round),
        timestamp:        parseInt(timestamp),
        btc_block_height: parseInt(btcBlockHeight),
        pairs:            sortedPairs
    });
}

// Generate a real Ed25519 validator keypair: { pubkey (64-hex), sign(payload) → 128-hex }
function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}



    let hub, agg, warn, clock;


    let pairs = (...names) => names.map(n => ({ pair: n, price: '1' }));

function registerPriceaggregatorIngestPairCoverageItem1Hooks() {

    beforeEach(function () {
        hub  = createMockHub();
        agg  = new PriceAggregator(hub);
        warn = sinon.stub(console, 'warn');
        clock = sinon.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
    });

    afterEach(function () {
        clock.restore();
        sinon.restore();
    });
}

function registerPriceaggregatorIngestPairCoverageItem1Tests1() {

    it('says nothing on the first round from a chain: it is the baseline, not a drop', function () {
        agg.checkIngestPairCoverage('BTC', 1, pairs('BTC/USD', 'LTC/USD'));
        expect(warn.called).to.equal(false);
    });

    it('never warns about a pair this chain has simply never sent (local config is not the basis)', function () {
        // The hub is configured for 36 pairs; a source federation publishing two of them is
        // not a drop, and a detector that says so every round names nothing.
        agg.checkIngestPairCoverage('BTC', 1, pairs('BTC/USD', 'LTC/USD'));
        agg.checkIngestPairCoverage('BTC', 2, pairs('BTC/USD', 'LTC/USD'));
        agg.checkIngestPairCoverage('BTC', 3, pairs('BTC/USD', 'LTC/USD'));
        expect(warn.called).to.equal(false);
    });

    it('names a pair that was arriving and stops, with the short-round count', function () {
        agg.checkIngestPairCoverage('BTC', 1, pairs('BTC/USD', 'LTC/USD'));
        agg.checkIngestPairCoverage('BTC', 2, pairs('BTC/USD'));
        expect(warn.callCount).to.equal(1);
        expect(warn.firstCall.args[0]).to.contain('LTC/USD');
        expect(warn.firstCall.args[0]).to.contain('round 2 from BTC');
        expect(warn.firstCall.args[0]).to.contain('1 round(s) from this chain have been short');
    });

    it('keeps reporting while the pair stays gone, throttled, and carries the suppressed count', function () {
        agg.checkIngestPairCoverage('BTC', 1, pairs('BTC/USD', 'LTC/USD'));
        agg.checkIngestPairCoverage('BTC', 2, pairs('BTC/USD'));
        agg.checkIngestPairCoverage('BTC', 3, pairs('BTC/USD'));
        agg.checkIngestPairCoverage('BTC', 4, pairs('BTC/USD'));
        expect(warn.callCount).to.equal(1);   // 2 suppressed inside the window

        clock.tick(60_000);
        agg.checkIngestPairCoverage('BTC', 5, pairs('BTC/USD'));
        expect(warn.callCount).to.equal(2);
        expect(warn.secondCall.args[0]).to.contain('2 warning(s) suppressed');
        expect(warn.secondCall.args[0]).to.contain('4 round(s) from this chain have been short');
    });

    it('goes quiet once the pair comes back', function () {
        agg.checkIngestPairCoverage('BTC', 1, pairs('BTC/USD', 'LTC/USD'));
        agg.checkIngestPairCoverage('BTC', 2, pairs('BTC/USD'));
        expect(warn.callCount).to.equal(1);

        clock.tick(60_000);
        agg.checkIngestPairCoverage('BTC', 3, pairs('BTC/USD', 'LTC/USD'));
        expect(warn.callCount).to.equal(1);
    });

    it('tracks each source chain separately, so one chain cannot mask another', function () {
        agg.checkIngestPairCoverage('BTC',  1, pairs('BTC/USD', 'LTC/USD'));
        agg.checkIngestPairCoverage('DOGE', 1, pairs('DOGE/USD'));
        agg.checkIngestPairCoverage('BTC',  2, pairs('BTC/USD'));
        agg.checkIngestPairCoverage('DOGE', 2, pairs('DOGE/USD'));
        expect(warn.callCount).to.equal(1);
        expect(warn.firstCall.args[0]).to.contain('from BTC');
    });
}

function registerPriceaggregatorIngestPairCoverageItem1Tests7() {

    it('adopts a pair that starts arriving, so its later loss is reported too', function () {
        agg.checkIngestPairCoverage('BTC', 1, pairs('BTC/USD'));
        agg.checkIngestPairCoverage('BTC', 2, pairs('BTC/USD', 'XCHAIN/USD'));
        expect(warn.called).to.equal(false);

        agg.checkIngestPairCoverage('BTC', 3, pairs('BTC/USD'));
        expect(warn.callCount).to.equal(1);
        expect(warn.firstCall.args[0]).to.contain('XCHAIN/USD');
    });

}

describe('PriceAggregator ingest pair coverage (item 5335)', function () {
    registerPriceaggregatorIngestPairCoverageItem1Hooks();
    registerPriceaggregatorIngestPairCoverageItem1Tests1();
    registerPriceaggregatorIngestPairCoverageItem1Tests7();
});
