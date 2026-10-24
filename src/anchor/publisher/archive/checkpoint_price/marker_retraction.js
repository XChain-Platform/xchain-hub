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
 **********************************************************************/

'use strict';

const { normalizeRetractionBounds } = require('../../../../lib/retraction_bounds.js');
const retraction = require('../../../../oracle/price_aggregator/retract.js');
const { getLogger } = require('../../../../observability');
const logger = getLogger();

const DECORATED = Symbol.for('xchain.price-retraction-batch-marker-ranges');
const MAX_BATCH_WINDOWS = 1000;
const MAX_BATCH_ROUNDS = 10000;

function wholeNumber(value){
    if(typeof value === 'string' && !/^\d+$/.test(value)) return null;
    if(typeof value !== 'string' && typeof value !== 'number') return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function retractedWindowRounds(batches){
    if(!Array.isArray(batches) || batches.length > MAX_BATCH_WINDOWS) return [];
    const rounds = new Set();
    for(const batch of batches){
        const first = wholeNumber(batch && batch.first_round);
        const last = wholeNumber(batch && batch.last_round);
        if(first === null || last === null || last < first ||
           last - first + 1 > MAX_BATCH_ROUNDS - rounds.size) return [];
        for(let round = first; round <= last; round++) rounds.add(round);
    }
    return Array.from(rounds).sort((a, b) => a - b);
}

async function storedBatchRounds(context, sourceChain, from, to, generation){
    const bounds = normalizeRetractionBounds(from, to, generation);
    if(bounds.error || !context.db ||
       typeof context.db.findBatchPriceSnapshotRoundsForRetraction !== 'function') return new Set();
    try {
        const rows = await context.db.findBatchPriceSnapshotRoundsForRetraction(
            sourceChain, bounds.from, bounds.to, bounds.gen, bounds.bounded, bounds.fenced);
        return new Set((rows || []).map(row => wholeNumber(row && row.round_number))
            .filter(round => round !== null));
    } catch(_error){
        return new Set();
    }
}

function successfulRetraction(result){
    return result && !result.error && result.retracted;
}

function decorateRetraction(){
    const original = retraction.retractFromActionIndex;
    if(typeof original !== 'function' || original[DECORATED]) return;
    async function retractWithBatchMarkerRanges(sourceChain, from, to, generation, batches){
        const ranged = retractedWindowRounds(batches);
        const stored = ranged.length > 0 ?
            await storedBatchRounds(this, sourceChain, from, to, generation) : new Set();
        const result = await original.apply(this, arguments);
        const publisher = this.hub && this.hub.oraclePublisher;
        if(ranged.length === 0 || !successfulRetraction(result) || !publisher ||
           typeof publisher.clearPublishedMarkers !== 'function') return result;
        const deleted = Number(result.retracted.price_snapshots) || 0;
        const missing = deleted === 0 ? ranged : ranged.filter(round => !stored.has(round));
        if(missing.length === 0) return result;
        try {
            await publisher.clearPublishedMarkers(missing);
        } catch(error){
            logger.error('PriceAggregator: clearing published markers for retracted batch ranges ' +
                missing.join(',') + ' failed: ' + (error && error.message));
        }
        return result;
    }
    retractWithBatchMarkerRanges[DECORATED] = true;
    retraction.retractFromActionIndex = retractWithBatchMarkerRanges;
}

decorateRetraction();

module.exports = { retractedWindowRounds };
