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



    const WATERMARK = { retraction_generation: 5, from_action_index: 100 };

    const STALE = {
        source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
        value: '1.23', block_time: 1700000000, action_index: 120, push_generation: 0
    };


    let hub, agg, warn, clock;

function registerPriceaggregatorIngestFenceRejectionWarning1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        hub.db.getPriceIngestWatermark.resolves({ ...WATERMARK });
        warn  = sinon.stub(console, 'warn');
        clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
    });

    afterEach(function () {
        clock.restore();
        sinon.restore();
    });
}

function registerPriceaggregatorIngestFenceRejectionWarning1Tests1() {

    it('names the fence, the generation comparison, and the remedy', async function () {
        await agg.receiveOraclePrice('BTC', STALE);
        expect(warn.calledOnce).to.equal(true);
        let line = warn.firstCall.args[0];
        expect(line).to.contain('PriceAggregator: WARNING');
        expect(line).to.contain('BTC');
        expect(line).to.contain('push_generation 0 <= retraction_generation 5');
        expect(line).to.contain('action_index 120 >= from_action_index 100');
        expect(line).to.contain('price_ingest_watermarks');
    });

    // The remedy an operator pastes has to be the SCOPED delete. An unscoped one run
    // against a hub DB shared with a live network drops that network's fence for the same
    // chain, which is the exact failure the network column was added to remove.
    it('hands the operator a network-scoped DELETE, never a chain-only one', async function () {
        hub.network = 'regtest';
        await agg.receiveOraclePrice('BTC', STALE);
        let line = warn.firstCall.args[0];
        expect(line).to.contain("DELETE FROM price_ingest_watermarks WHERE source_chain = 'BTC' AND network = 'regtest'");
        expect(line).to.not.match(/source_chain = 'BTC'\s+on the hub DB/);
    });

    it('throttles repeats for the same chain and reports the suppressed count on the next line', async function () {
        for (let i = 0; i < 5; i++) await agg.receiveOraclePrice('BTC', STALE);
        expect(warn.callCount).to.equal(1);       // 4 suppressed inside the window

        clock.tick(60_000);
        await agg.receiveOraclePrice('BTC', STALE);
        expect(warn.callCount).to.equal(2);
        expect(warn.secondCall.args[0]).to.contain('4 further rejection(s)');

        // The count resets with each printed line, so it never double-counts.
        clock.tick(60_000);
        await agg.receiveOraclePrice('BTC', STALE);
        expect(warn.callCount).to.equal(3);
        expect(warn.thirdCall.args[0]).to.not.contain('further rejection(s)');
    });

    it('throttles per source chain, so one noisy chain cannot mask another going down', async function () {
        await agg.receiveOraclePrice('BTC', STALE);
        await agg.receiveOraclePrice('BTC', STALE);
        await agg.receiveOraclePrice('DOGE', STALE);
        expect(warn.callCount).to.equal(2);
        expect(warn.secondCall.args[0]).to.contain('DOGE');
    });

    it('says nothing when the fence does not fire', async function () {
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT INTO oracle_prices/.test(sql) ? {} : []));
        // Below the orphaned range: a legitimate survivor, not a stale replay.
        let result = await agg.receiveOraclePrice('BTC', { ...STALE, action_index: 50, push_generation: 5 });
        expect(result).to.deep.equal({ accepted: true });
        expect(warn.called).to.equal(false);
    });

}

describe('PriceAggregator ingest-fence rejection warning', function () {
    registerPriceaggregatorIngestFenceRejectionWarning1Hooks();
    registerPriceaggregatorIngestFenceRejectionWarning1Tests1();
});
