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
const PriceAggregator  = require('../../src/oracle/price_aggregator');
const { createMockHub } = require('../helpers/mockHub');

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



    const STALE = {
        source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
        value: '1.23', block_time: 1700000000, action_index: 120, push_generation: 0
    };


    let clock;


    function aggOn(network) {
        let hub = createMockHub({ network });
        return { hub, agg: new PriceAggregator(hub) };
    }

function registerPriceaggregatorPriceIngestFenceIs1Hooks() {

    // The v1 ingest path applies a block_time freshness window before it reaches the fence,
    // so pin the clock to STALE's block_time the way the warning suite does; otherwise the
    // push is rejected upstream and the fence read never happens.
    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
    });

    afterEach(function () {
        clock.restore();
        sinon.restore();
    });
}

function registerPriceaggregatorPriceIngestFenceIs1Tests1() {

    it('reads the fence with the hub\'s own network, so another network\'s row is unreachable', async function () {
        let { hub, agg } = aggOn('regtest');
        sinon.stub(console, 'warn');
        await agg.receiveOraclePrice('BTC', STALE);
        expect(hub.db.getPriceIngestWatermark.called).to.equal(true);
        expect(hub.db.getPriceIngestWatermark.firstCall.args).to.deep.equal(['BTC', 'regtest']);
    });

    it('writes a retraction\'s fence under the hub\'s own network', async function () {
        let { hub, agg } = aggOn('testnet');
        hub.db.doQuery.resolves({ affectedRows: 0 });
        await agg.retractFromActionIndex('DOGE', 500, null, 9);
        expect(hub.db.bumpPriceIngestWatermark.called, 'fence bumped').to.equal(true);
        expect(hub.db.bumpPriceIngestWatermark.firstCall.args).to.deep.equal(['DOGE', 9, 500, 'testnet']);
    });

    // The behavioural claim in the ledger's verify line, driven rather than read: two hubs
    // on the same DB, same chain, different networks. A regtest retraction must fence
    // regtest and leave testnet's key alone, so a testnet clear and a regtest clear are
    // different rows.
    it('two hubs on one DB fence the same chain under different keys', async function () {
        let regtest = aggOn('regtest');
        let testnet = aggOn('testnet');
        regtest.hub.db.doQuery.resolves({ affectedRows: 0 });
        testnet.hub.db.doQuery.resolves({ affectedRows: 0 });

        await regtest.agg.retractFromActionIndex('BTC', 10, null, 3);
        await testnet.agg.retractFromActionIndex('BTC', 77, null, 4);

        let regKey  = regtest.hub.db.bumpPriceIngestWatermark.firstCall.args.slice(-1)[0];
        let testKey = testnet.hub.db.bumpPriceIngestWatermark.firstCall.args.slice(-1)[0];
        expect(regKey).to.equal('regtest');
        expect(testKey).to.equal('testnet');
        expect(regKey).to.not.equal(testKey);
    });

    // A hub that does not know its own network keys the legacy '' bucket, which is where
    // its pre-migration rows already are: unchanged behaviour, not a silently lost fence.
    it('falls back to the legacy unset bucket when the hub names no network', async function () {
        let { hub, agg } = aggOn(undefined);
        sinon.stub(console, 'warn');
        await agg.receiveOraclePrice('BTC', STALE);
        expect(hub.db.getPriceIngestWatermark.firstCall.args).to.deep.equal(['BTC', '']);
    });

    it('folds casing and whitespace so a HUB_NETWORK typo cannot split the key', async function () {
        let { hub, agg } = aggOn('  RegTest  ');
        sinon.stub(console, 'warn');
        await agg.receiveOraclePrice('BTC', STALE);
        expect(hub.db.getPriceIngestWatermark.firstCall.args).to.deep.equal(['BTC', 'regtest']);
    });

}

describe('PriceAggregator price ingest fence is scoped per network', function () {
    registerPriceaggregatorPriceIngestFenceIs1Hooks();
    registerPriceaggregatorPriceIngestFenceIs1Tests1();
});
