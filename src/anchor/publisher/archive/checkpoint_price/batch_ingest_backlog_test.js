'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const methods = require('./batch_ingest.js');
const lifecycleMethods = require('../../lifecycle.js');

test('publisher startup clears a 500-round zero-stamped backlog in bounded pages', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
        id: index + 1, round_number: index + 1, status: 'finalized', batch_block_time: 0
    }));
    const pageSizes = [];
    const landingRanges = [];
    const context = Object.assign({}, methods, {
        enabled: true,
        spendGuard: { persistTo() {} },
        resolveMissingIndexerUrls: async () => {},
        seedArchiveSeqFloor: async () => {},
        subscribeToAnchorSources() {},
        startFlushTimers() {},
        db: {
            async findPriceSnapshotsById(afterId, limit){
                const page = rows.filter(row => row.id > afterId).slice(0, limit);
                pageSizes.push(page.length);
                return page;
            }
        },
        hub: {
            priceAggregator: {
                async stampBatchLanding(round){
                    const row = rows.find(candidate => candidate.round_number === round);
                    if(!row || row.batch_block_time !== 0) return 0;
                    row.batch_block_time = 1700009000;
                    return 1;
                }
            }
        },
        async fetchPriceBatchLandings(first, last){
            landingRanges.push([first, last]);
            return { batches: [{ first, last, blockTime: 1700009000 }], completeBelow: last + 1 };
        }
    });

    await lifecycleMethods.start.call(context);
    context.stopPriceBatchLandingBackfill();

    assert.equal(rows.filter(row => row.batch_block_time === 0).length, 0);
    assert.deepEqual(pageSizes, [100, 100, 100, 100, 100, 0]);
    assert.deepEqual(landingRanges, [[1, 100], [101, 200], [201, 300], [301, 400], [401, 500]]);
});
