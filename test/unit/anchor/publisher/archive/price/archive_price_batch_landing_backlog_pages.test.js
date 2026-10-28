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
        assert.match(statement, /FORCE INDEX \(idx_batchtime_round_status\)/);
        assert.match(statement, /WHERE batch_block_time = 0 AND round_number > \? AND status != 'skipped'/);

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

    // A reset window near the tip sits above thousands of old zero-stamped rounds the
    // landing chain carries no batch for. A sweep that restarts at round 0 on every tick
    // spends its whole page budget on those and never reaches the window; the persisted
    // cursor resumes past them on the next tick and wraps once the top is read.
    it('resumes from its round cursor so a reset window above 2000 unstampable rounds is reached',
        resumesPastUnstampableRounds);
});

async function resumesPastUnstampableRounds(){
    const FIRST_BATCH_ROUND = 3001;
    const rows = Array.from({ length: 3050 }, (_, index) => ({
        round_number: index + 1, batch_block_time: 0
    }));
    const byRound = new Map(rows.map(row => [row.round_number, row]));
    const firstAfter = [];
    const context = Object.assign({}, methods, {
        db: {
            async findZeroBatchBlockTimePriceSnapshotRoundsAfter(afterRound, limit){
                return rows.filter(row => row.round_number > afterRound &&
                    row.batch_block_time === 0).slice(0, limit);
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
        // The landing chain answers completely but carries batches only from round 3001.
        async fetchPriceBatchLandings(first, last){
            const from = Math.max(first, FIRST_BATCH_ROUND);
            return { batches: from <= last ? [{ first: from, last, blockTime: 1700009000 }] : [],
                     completeBelow: last + 1 };
        }
    });
    const query = context.db.findZeroBatchBlockTimePriceSnapshotRoundsAfter;
    context.db.findZeroBatchBlockTimePriceSnapshotRoundsAfter = async function(afterRound, limit){
        if(this.pageInRun === 0) firstAfter.push(afterRound);
        this.pageInRun++;
        return query.call(this, afterRound, limit);
    };

    context.db.pageInRun = 0;
    assert.equal(await context.runPriceBatchLandingBackfill(), 0);
    context.db.pageInRun = 0;
    assert.equal(await context.runPriceBatchLandingBackfill(), 50);
    assert.equal(rows.filter(row => row.round_number >= FIRST_BATCH_ROUND &&
        row.batch_block_time === 0).length, 0);
    context.db.pageInRun = 0;
    assert.equal(await context.runPriceBatchLandingBackfill(), 0);
    assert.deepEqual(firstAfter, [0, 2000, 0]);
}
