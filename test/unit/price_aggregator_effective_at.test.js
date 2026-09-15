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



    let hub, agg;


    // Capture the INSERT args; the dedup SELECT misses.
    function stubDb() {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        return () => insertArgs;
    }


    // INSERT column order: source_address, source_chain, coin, tick, fiat, value,
    // fee, memo, block_time, effective_at, action_index
    const EFFECTIVE_AT = 9;

function registerPriceaggregatorReceiveoraclepriceUniform24hEffective1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorReceiveoraclepriceUniform24hEffective1Tests1() {

    it('delays a first-ever publish by 24h from its block_time', async function () {
        let getInsert = stubDb();

        let result = await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
            value: '1.23', block_time: 1700000000, action_index: 7
        });

        expect(result).to.deep.equal({ accepted: true });
        // EVERY publish (first included) is delayed 24h so the row lands in
        // every mirror before any block can read it (no retroactive effect).
        expect(getInsert()[EFFECTIVE_AT]).to.equal(1700000000 + 86400);
    });

    it('delays an update by 24h from its block_time', async function () {
        let getInsert = stubDb();

        let result = await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
            value: '1.50', block_time: 1700000000, action_index: 8
        });

        expect(result).to.deep.equal({ accepted: true });
        expect(getInsert()[EFFECTIVE_AT]).to.equal(1700000000 + 86400);
    });

}

describe('PriceAggregator.receiveOraclePrice() uniform 24h effective_at delay', function () {
    registerPriceaggregatorReceiveoraclepriceUniform24hEffective1Hooks();
    registerPriceaggregatorReceiveoraclepriceUniform24hEffective1Tests1();
});
