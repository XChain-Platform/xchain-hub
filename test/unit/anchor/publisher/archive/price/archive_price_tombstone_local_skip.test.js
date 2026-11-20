'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const { samePriceKey } = require('../../../../../../src/anchor/publisher/archive/unheld_row.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

function buildPub(prices){
    return new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            findPriceSnapshotsForRound: async round =>
                prices.filter(row => Number(row.round_number) === Number(round))
        },
        network: 'regtest',
        getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
}

function archive(coinPair = 'BTC/USD'){
    return {
        network: 'regtest', matches: [], calls: [], rewards: [],
        state_checkpoints: [], price_snapshots: [],
        price_tombstones: [{ round_number: 12, coin_pair: coinPair }],
        capability_snapshots: []
    };
}

function price(coinPair, status, value){
    return {
        round_number: 12,
        coin_pair: coinPair,
        price: value,
        consensus_proof: status === 'skipped' ? '[]' : '["proof"]',
        status
    };
}

describe('archive price tombstone local skipped rows', () => {
    it('accepts a tombstone over a held skipped marker', async () => {
        const pub = buildPub([price('BTC/USD', 'skipped', null)]);

        expect(await pub.verifyArchiveAgainstLocal(archive(), null, 'regtest')).to.equal(true);
    });

    it('refuses a tombstone over a held finalized row', async () => {
        const pub = buildPub([price('BTC/USD', 'finalized', '62000.00')]);

        expect(await pub.verifyArchiveAgainstLocal(archive(), null, 'regtest')).to.equal(false);
    });

    for(const spelling of ['btc/usd', 'BTC/USD ']){
        it('refuses a ' + JSON.stringify(spelling) + ' tombstone over the folded live key', async () => {
            const pub = buildPub([price('BTC/USD', 'finalized', '62000.00')]);

            expect(await pub.verifyArchiveAgainstLocal(archive(spelling), null, 'regtest')).to.equal(false);
        });
    }

    it('still accepts a folded tombstone over a skipped marker', async () => {
        const pub = buildPub([price('BTC/USD', 'skipped', null)]);

        expect(await pub.verifyArchiveAgainstLocal(archive('btc/usd'), null, 'regtest')).to.equal(true);
    });

    it('accepts a tombstone beside a different finalized pair', async () => {
        const pub = buildPub([price('ETH/USD', 'finalized', '2400.00')]);

        expect(await pub.verifyArchiveAgainstLocal(archive(), null, 'regtest')).to.equal(true);
    });
});

describe('price database key folding', () => {
    it('matches case and trailing padding but keeps round and leading spaces distinct', () => {
        const base = { round_number: 12, coin_pair: 'BTC/USD' };
        expect(samePriceKey(base, { round_number: 12, coin_pair: 'btc/usd' })).to.equal(true);
        expect(samePriceKey(base, { round_number: 12, coin_pair: 'BTC/USD ' })).to.equal(true);
        expect(samePriceKey(base, { round_number: 12, coin_pair: ' BTC/USD' })).to.equal(false);
        expect(samePriceKey(base, { round_number: 13, coin_pair: 'BTC/USD' })).to.equal(false);
    });
});
