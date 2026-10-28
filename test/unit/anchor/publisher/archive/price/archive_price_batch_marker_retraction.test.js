'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins the batch-window marker clear of price retraction: retracting a window whose
// batch is fully finalized clears that round's published D28 marker even when no
// snapshot or oracle price row is removed. Only retract.js is loaded, so the clear is
// proven to hold without the anchor publisher in the process.

const assert = require('node:assert/strict');
const retraction = require('../../../../../../src/oracle/price_aggregator/retract.js');

function finalizedBatchFixture(){
    const markers = new Set([42]);
    const cleared = [];
    const none = async () => [];
    const untouched = async () => ({ affectedRows: 0 });
    const db = {
        findBatchPriceSnapshotRoundsForRetraction: none,
        findSelfFinalizedRoundsForBatchRetraction: none,
        findPriceSnapshotRoundsLandedBetween: none,
        insertPriceTombstonesForRetraction: untouched,
        deletePriceSnapshotsForRetraction: untouched,
        deleteOraclePricesForRetraction: untouched
    };
    const publisher = {
        async clearPublishedMarkers(rounds){
            cleared.push(...rounds);
            for(const round of rounds) markers.delete(round);
        }
    };
    const aggregator = {
        db, hub: { oraclePublisher: publisher }, emit(){}, fenceNetwork(){ return 'regtest'; }
    };
    return { markers, cleared, aggregator };
}

describe('archive price batch marker retraction', () => {
    it('a fully finalized batch retraction clears its D28 marker', async () => {
        const fixture = finalizedBatchFixture();
        const result = await retraction.retractFromActionIndex.call(
            fixture.aggregator, 'DOGE', 100, undefined, undefined,
            [{ first_round: 42, last_round: 42 }]);
        assert.deepEqual(result.retracted, { price_snapshots: 0, oracle_prices: 0 });
        assert.deepEqual(fixture.cleared, [42]);
        assert.equal(fixture.markers.has(42), false);
    });
});
