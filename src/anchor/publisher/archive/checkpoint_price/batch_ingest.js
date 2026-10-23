/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ANCHOR publisher - PRICE batch landing back-fill
 *
 * A hub stamps batch_block_time only from a pushpricebatch it receives, so a
 * follower the pushes never reached holds 0 for rounds the leader stamped, and
 * samePriceRow refuses the leader's archive on that column alone. Before judging
 * archived price rows, ask the landing chain's indexer which valid batches carry
 * those rounds and stamp them through PriceAggregator.stampBatchLanding, the same
 * earliest-landing-wins write a push makes. The compare itself stays strict.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../../../observability');
const logger = getLogger();
const lifecycleMethods = require('../../lifecycle.js');

const PRICE_LANDING_CHAIN = 'DOGE';
const PRICE_BATCH_LIMIT = 1000;
// Pages of getpricebatches one back-fill reads; a backlog past this many pages is
// stamped up to where the answer was complete and the rest waits for the next archive.
const PRICE_BATCH_MAX_PAGES = 20;
const PRICE_BACKFILL_ROW_PAGE = 100;
const PRICE_BACKFILL_MAX_PAGES = 20;
const PRICE_BACKFILL_INTERVAL_MS = 15 * 60 * 1000;

function wholeNumber(value, minimum){
    if(typeof value === 'string' && !/^\d+$/.test(value)) return null;
    if(typeof value !== 'string' && typeof value !== 'number') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

// Rounds the archive carries with a landing stamp: the only rounds a 0 here can make us refuse.
function archivedLandingRounds(rows){
    const rounds = new Set();
    for(const row of (rows || [])){
        const round = wholeNumber(row && row.round_number, 0);
        const landed = wholeNumber(row && row.batch_block_time, 1);
        if(round !== null && landed !== null && String(row.status) !== 'skipped') rounds.add(round);
    }
    return Array.from(rounds).sort((a, b) => a - b);
}

// Of those, the rounds this hub holds a live row for at batch_block_time 0.
async function zeroHeldRounds(context, rounds){
    const pending = [];
    for(const round of rounds){
        const held = await context.db.findPriceSnapshotsForRound(round);
        if((held || []).some(row => String(row.status) !== 'skipped' &&
            wholeNumber(row.batch_block_time, 0) === 0)) pending.push(round);
    }
    return pending;
}

// One batch of the answer as { first, last, blockTime }; blockTime is null when the
// indexer could not resolve the landing clock (or predates the field), which makes
// every round the batch covers unknown rather than stamped from a later landing.
function batchLanding(batch){
    const first = wholeNumber(batch && batch.first_round, 0);
    const last = wholeNumber(batch && batch.last_round, 0);
    if(first === null || last === null || last < first) return null;
    const blockIndex = wholeNumber(batch && batch.block_index, 0);
    const blockTime = wholeNumber(batch && batch.block_time, 1);
    return { first, last, blockTime: (blockIndex === null || blockTime === null) ? null : blockTime };
}

// One getpricebatches page as { batches, truncated }, or null when the answer is unusable.
function pageLandings(answer){
    if(!answer || answer.error || !Array.isArray(answer.batches)) return null;
    const batches = answer.batches.map(batchLanding);
    if(!batches.every(Boolean)) return null;
    return { batches, truncated: !!answer.truncated };
}

// The landing of `round`: the earliest landing clock among the batches carrying it,
// null when none carries it or any carrier's clock is unknown.
function earliestLandingForRound(round, batches){
    let landed = null;
    for(const batch of batches){
        if(round < batch.first || round > batch.last) continue;
        if(batch.blockTime === null) return null;
        if(landed === null || batch.blockTime < landed) landed = batch.blockTime;
    }
    return landed;
}

const methods = {

    // Every valid PRICE batch overlapping [first, last] on the landing chain, read page by
    // page. Batches come back ordered by first_round, so once a page is truncated every
    // round below its last batch's first_round is fully answered; `completeBelow` is that
    // bound (last + 1 when the whole range was read). Null when the indexer cannot answer.
    async fetchPriceBatchLandings(first, last){
        const batches = [];
        let from = first;
        for(let page = 0; page < PRICE_BATCH_MAX_PAGES; page++){
            const answer = await this.indexerCall(PRICE_LANDING_CHAIN, 'getpricebatches', {
                first_round: from, last_round: last, limit: PRICE_BATCH_LIMIT
            });
            const read = pageLandings(answer);
            if(read === null) return null;
            batches.push(...read.batches);
            if(!read.truncated || read.batches.length === 0) return { batches, completeBelow: last + 1 };
            const next = read.batches[read.batches.length - 1].first;
            if(next <= from) return { batches, completeBelow: from };
            from = next;
        }
        return { batches, completeBelow: from };
    },

    // Stamp the landing clock on rounds the archive carries stamped and this hub holds at 0.
    // Best effort: any failure leaves the rows as they are, and the strict compare decides.
    // Returns the number of rows stamped.
    async backfillPriceBatchLandings(rows){
        const aggregator = this.hub && this.hub.priceAggregator;
        if(!aggregator || typeof aggregator.stampBatchLanding !== 'function') return 0;
        let stamped = 0;
        try {
            const candidates = await zeroHeldRounds(this, archivedLandingRounds(rows));
            if(candidates.length === 0) return 0;
            const landings = await this.fetchPriceBatchLandings(candidates[0], candidates[candidates.length - 1]);
            if(landings === null){
                logger.warn('StateAnchorPublisher: cannot back-fill PRICE batch landing clocks from an unusable indexer answer');
                return 0;
            }
            for(const round of candidates){
                if(round >= landings.completeBelow) break;
                const blockTime = earliestLandingForRound(round, landings.batches);
                if(blockTime !== null) stamped += await aggregator.stampBatchLanding(round, blockTime);
            }
        } catch(error){
            logger.warn('StateAnchorPublisher: cannot back-fill PRICE batch landing clocks: ' +
                (error && error.message ? error.message : error));
            return stamped;
        }
        if(stamped > 0)
            logger.info('StateAnchorPublisher: back-filled the PRICE batch landing clock on ' + stamped +
                        ' row(s) from the ' + PRICE_LANDING_CHAIN + ' indexer');
        return stamped;
    },

    // One bounded sweep. Production reads only zero-stamped rounds through an indexed
    // round cursor. The cursor starts over on each slow tick so unresolved clocks retry.
    async runPriceBatchLandingBackfill(){
        if(this.priceLandingBackfillRunning) return 0;
        const aggregator = this.hub && this.hub.priceAggregator;
        if(!aggregator || typeof aggregator.stampBatchLanding !== 'function') return 0;
        this.priceLandingBackfillRunning = true;
        let stamped = 0;
        try {
            const indexedQuery = this.db && this.db.findZeroBatchBlockTimePriceSnapshotRoundsAfter;
            const legacyQuery = this.db && this.db.findPriceSnapshotsById;
            if(typeof indexedQuery !== 'function' && typeof legacyQuery !== 'function') return 0;
            let cursor = typeof indexedQuery === 'function' ? 0 :
                (wholeNumber(this.priceLandingBackfillRowCursor, 0) || 0);
            for(let page = 0; page < PRICE_BACKFILL_MAX_PAGES; page++){
                const indexed = typeof indexedQuery === 'function';
                const answer = indexed ?
                    await indexedQuery.call(this.db, cursor, PRICE_BACKFILL_ROW_PAGE) :
                    await legacyQuery.call(this.db, cursor, PRICE_BACKFILL_ROW_PAGE);
                if(!Array.isArray(answer)) throw new Error('zero-stamped round query returned no row list');
                if(answer.length === 0){
                    if(!indexed) this.priceLandingBackfillRowCursor = 0;
                    break;
                }
                const cursorField = indexed ? 'round_number' : 'id';
                const nextCursor = Math.max(...answer.map(row =>
                    wholeNumber(row && row[cursorField], 1) || 0));
                if(nextCursor <= cursor) throw new Error('price snapshot page did not advance');
                if(!indexed) this.priceLandingBackfillRowCursor = nextCursor;
                const rounds = Array.from(new Set(answer.filter(row => indexed ||
                    (String(row && row.status) !== 'skipped' &&
                    wholeNumber(row && row.batch_block_time, 0) === 0)).map(row =>
                    wholeNumber(row && row.round_number, 0)).filter(round => round !== null)))
                    .sort((a, b) => a - b);
                if(rounds.length > 0){
                    const landings = await this.fetchPriceBatchLandings(rounds[0], rounds[rounds.length - 1]);
                    if(landings !== null){
                        for(const round of rounds){
                            if(round >= landings.completeBelow) break;
                            const blockTime = earliestLandingForRound(round, landings.batches);
                            if(blockTime !== null) stamped += await aggregator.stampBatchLanding(round, blockTime);
                        }
                    }
                }
                cursor = nextCursor;
                if(answer.length < PRICE_BACKFILL_ROW_PAGE){
                    if(!indexed) this.priceLandingBackfillRowCursor = 0;
                    break;
                }
            }
        } catch(error){
            logger.warn('StateAnchorPublisher: cannot sweep zero-stamped PRICE landing clocks: ' +
                (error && error.message ? error.message : error));
        } finally {
            this.priceLandingBackfillRunning = false;
        }
        if(stamped > 0)
            logger.info('StateAnchorPublisher: swept the PRICE batch landing clock onto ' + stamped +
                        ' row(s) from the ' + PRICE_LANDING_CHAIN + ' indexer');
        return stamped;
    },

    // Repair once at startup, then slowly enough that an unavailable indexer is not
    // hammered. The running guard also keeps an archive-triggered repair independent.
    async startPriceBatchLandingBackfill(){
        if(!this.priceLandingBackfillTimer){
            this.priceLandingBackfillTimer = setInterval(() => {
                this.runPriceBatchLandingBackfill().catch(error =>
                    logger.warn('StateAnchorPublisher: PRICE landing-clock sweep failed: ' +
                        (error && error.message ? error.message : error)));
            }, PRICE_BACKFILL_INTERVAL_MS);
            if(this.priceLandingBackfillTimer.unref) this.priceLandingBackfillTimer.unref();
        }
        return this.runPriceBatchLandingBackfill();
    },

    stopPriceBatchLandingBackfill(){
        if(this.priceLandingBackfillTimer){
            clearInterval(this.priceLandingBackfillTimer);
            this.priceLandingBackfillTimer = null;
        }
    }

};

const lifecycleStart = lifecycleMethods.start;
const lifecycleStop = lifecycleMethods.stop;

// This part is loaded before lifecycleMethods is installed on the publisher prototype,
// so extend start and stop here without widening the checkpoint_price surface.
lifecycleMethods.start = async function(){
    const result = await lifecycleStart.call(this);
    if(this.enabled && typeof this.startPriceBatchLandingBackfill === 'function')
        await this.startPriceBatchLandingBackfill();
    return result;
};

lifecycleMethods.stop = async function(){
    if(typeof this.stopPriceBatchLandingBackfill === 'function') this.stopPriceBatchLandingBackfill();
    return lifecycleStop.call(this);
};

module.exports = methods;

async function runBacklogRegression(){
    const [{ default: assert }, { default: test }, { default: priceQueries }] = await Promise.all([
        import('node:assert/strict'), import('node:test'), import('../../../../db/prices/index.js')
    ]);

    test('500 unstamped rounds after 20000 stamped rows clear in bounded pages', async () => {
        let statement;
        await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call({
            async doQuery(sql){ statement = sql; return []; }
        }, 0, PRICE_BACKFILL_ROW_PAGE);
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
}

if(require.main === module) runBacklogRegression();
