'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins the batch landing back-fill against a deep backlog: a few hundred unstamped price
// rounds sitting above tens of thousands of stamped ones must clear in bounded pages,
// and the page query must use the pair/batch-time index.

const assert = require('node:assert/strict');
const methods = require('../../../../../../src/anchor/publisher/archive/checkpoint_price/batch_ingest.js');
const priceQueries = require('../../../../../../src/db/prices/index.js');

const ROW_PAGE = 100;

describe('archive price batch landing back-fill deep backlog', () => {
    it('clears 500 unstamped rounds above 20000 stamped rows in bounded index-forced pages', async () => {
        let statement;
        await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call({
            async doQuery(sql){ statement = sql; return []; }
        }, 0, ROW_PAGE);
        assert.match(statement, /FORCE INDEX \(idx_pair_batchtime_round\)/);
        assert.match(statement, /pending\.coin_pair = pairs\.coin_pair AND pending\.batch_block_time = 0/);

        const rows = Array.from({ length: 20500 }, (_, index) => ({
            round_number: index + 1,
            batch_block_time: index < 20000 ? 1700008000 : 0
        }));
        const byRound = new Map(rows.map(row => [row.round_number, row]));
        const pageSizes = [];
        const context = Object.assign({}, methods, {
            db: {
                async findZeroBatchBlockTimePriceSnapshotRoundsAfter(afterRound, limit){
                    const page = rows.filter(row => row.round_number > afterRound &&
                        row.batch_block_time === 0).slice(0, limit);
                    pageSizes.push(page.length);
                    return page;
                }
            },
            hub: {
                priceAggregator: {
                    async stampBatchLanding(round, blockTime){
                        const row = byRound.get(round);
                        if(!row || row.batch_block_time !== 0) return 0;
                        row.batch_block_time = blockTime;
                        return 1;
                    }
                }
            },
            async fetchPriceBatchLandings(first, last){
                return { batches: [{ first, last, blockTime: 1700009000 }], completeBelow: last + 1 };
            }
        });

        assert.equal(await context.runPriceBatchLandingBackfill(), 500);
        assert.equal(rows.filter(row => row.batch_block_time === 0).length, 0);
        assert.deepEqual(pageSizes, [100, 100, 100, 100, 100, 0]);
    });
});
