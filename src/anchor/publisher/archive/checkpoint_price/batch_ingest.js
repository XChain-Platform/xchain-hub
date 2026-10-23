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
 ********************************************************************/

'use strict';

const { getLogger } = require('../../../../observability');
const logger = getLogger();

const PRICE_LANDING_CHAIN = 'DOGE';
const PRICE_BATCH_LIMIT = 1000;

function wholeNumber(value, minimum){
    if(typeof value === 'string' && !/^\d+$/.test(value)) return null;
    if(typeof value !== 'string' && typeof value !== 'number') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function archivedLandingRounds(rows){
    const rounds = new Set();
    for(const row of (rows || [])){
        const round = wholeNumber(row && row.round_number, 0);
        const landed = wholeNumber(row && row.batch_block_time, 1);
        if(round !== null && landed !== null && String(row.status) !== 'skipped') rounds.add(round);
    }
    return Array.from(rounds).sort((a, b) => a - b);
}

async function zeroHeldRounds(context, rounds){
    const pending = [];
    for(const round of rounds){
        const held = await context.db.findPriceSnapshotsForRound(round);
        if((held || []).some(row => String(row.status) !== 'skipped' &&
            wholeNumber(row.batch_block_time, 0) === 0)) pending.push(round);
    }
    return pending;
}

function batchLanding(batch, indexedTip){
    const first = wholeNumber(batch && batch.first_round, 0);
    const last = wholeNumber(batch && batch.last_round, 0);
    const blockIndex = wholeNumber(batch && batch.block_index, 0);
    const blockTime = wholeNumber(batch && batch.block_time, 1);
    if(first === null || last === null || last < first || blockIndex === null || blockTime === null)
        return null;
    if(indexedTip !== null && blockIndex > indexedTip) return null;
    return { first, last, blockIndex, blockTime };
}

function usableBatchLandings(answer){
    if(!answer || answer.error || !Array.isArray(answer.batches) || answer.truncated) return null;
    const indexedTip = wholeNumber(answer.block_index, 0);
    if(answer.batches.length > 0 && indexedTip === null) return null;
    const batches = answer.batches.map(batch => batchLanding(batch, indexedTip));
    return batches.every(Boolean) ? batches : null;
}

function earliestLandingForRound(round, batches){
    let landed = null;
    for(const batch of batches){
        if(round < batch.first || round > batch.last) continue;
        if(landed === null || batch.blockTime < landed) landed = batch.blockTime;
    }
    return landed;
}

module.exports = {

    async backfillPriceBatchLandings(rows){
        const candidates = await zeroHeldRounds(this, archivedLandingRounds(rows));
        if(candidates.length === 0) return 0;

        const aggregator = this.hub && this.hub.priceAggregator;
        if(!aggregator || typeof aggregator.stampBatchLanding !== 'function') return 0;

        let answer;
        try {
            answer = await this.indexerCall(PRICE_LANDING_CHAIN, 'getpricebatches', {
                first_round: candidates[0],
                last_round: candidates[candidates.length - 1],
                limit: PRICE_BATCH_LIMIT
            });
        } catch(error){
            logger.warn('StateAnchorPublisher: cannot back-fill PRICE batch landing clocks: ' +
                (error && error.message ? error.message : error));
            return 0;
        }

        const batches = usableBatchLandings(answer);
        if(batches === null){
            logger.warn('StateAnchorPublisher: cannot back-fill PRICE batch landing clocks from an incomplete indexer answer');
            return 0;
        }

        let stamped = 0;
        for(const round of candidates){
            const blockTime = earliestLandingForRound(round, batches);
            if(blockTime !== null) stamped += await aggregator.stampBatchLanding(round, blockTime);
        }
        return stamped;
    }

};
