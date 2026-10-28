/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Hub - Price Aggregator: reorg retraction
 *
 * Deletes the price rows an indexer rolled back, under the persisted ingest
 * fence that keeps a stale replay from re-inserting them, and clears the
 * publisher's at-most-once markers for every round a retracted batch carried.
 *
 ********************************************************************/

const { normalizeRetractionBounds, parseIndex } = require('../../lib/retraction_bounds.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();
const PRICE_KEEP_CHECK_TIMEOUT_MS = 3000;

// D28: the rounds a retracted BATCH carried, read BEFORE the DELETE because
// afterwards there is nothing left to read them off. Batch-sourced rows are the
// ones whose consensus_proof is the {"batch":...} object of D23; a v0-sourced
// row's proof is a bare signature ARRAY, so the prefix is an exact discriminator
// and v0 retraction behaviour is untouched. The active-chain retention check uses
// these rows on every hub; publisher wiring additionally clears durable markers.
function publishedMarkerSeam() {
    let publisher = this.hub && this.hub.oraclePublisher;
    let canClearMarkers = !!(publisher && typeof publisher.clearPublishedMarkers === 'function');
    if (publisher && !canClearMarkers) {
        logger.warn('PriceAggregator: OraclePublisher is wired but exposes no clearPublishedMarkers(rounds);'
            + ' a retracted PRICE batch will stay marked as published and the at-most-once guard will'
            + ' suppress the recovery re-publish, costing an hour of price history rather than a round.');
    }
    return { publisher, canClearMarkers };
}

// HUB-RETRACT-4: durably record this retraction's generation + orphaned-range lower bound
// so a stale price push (a fire-and-forget or in-flight PRICE arriving AFTER the delete, or
// a retried push carrying the pre-reorg generation) is rejected at ingest instead of
// re-inserting the orphan. Only when the source carried a generation to fence on; without
// it we cannot tell stale from fresh, so we leave the fence untouched (pre-fix behaviour).
// Runs even on a 0-row delete: the stale push may not have arrived yet.
//
// Written BEFORE the deletes, and a failed write aborts the retraction rather than being
// logged and forgotten. The caller drops its durable outbox row on a success return
// (xchain-indexer hub_push_queue.js markHubPushDelivered), so a swallowed failure left the
// rows deleted, the fence unpersisted and no retry anywhere in the fleet. Early is safe
// because the fence is monotonic (GREATEST generation, LEAST from in db.js
// bumpPriceIngestWatermark), so it can only reject pushes this retraction is about to
// delete; there is no hub-side transaction spanning both, so this is fail-closed, not
// atomic. Keep the error wording clear of the indexer's TERMINAL_HUB_REJECTIONS patterns
// (xchain-indexer/src/hub/hub_client.js) or the retained retry becomes a silent drop.
async function persistIngestFence(sourceChain, bounds) {
    if (bounds.fenced) {
        try {
            await this.db.bumpPriceIngestWatermark(sourceChain, bounds.gen, bounds.from, this.fenceNetwork());
        } catch (e) {
            logger.error(nodeUtil.format('PriceAggregator: ingest-watermark bump failed for ' + sourceChain + ':', e && e.message));
            return { error: 'ingest fence not persisted for ' + sourceChain
                + ' (' + ((e && e.message) || 'unknown error') + ')' };
        }
    }
    return null;
}

// The three retraction statements below share one WHERE tail (source chain, the
// [from, to] range, the generation fence); the only per-table difference is the
// action-index column, so each named method owns its own column: price_snapshots
// tracks the PRICE v0 round action via source_action_index, oracle_prices the
// PRICE v1 action via action_index.
async function snapshotRetractionDelete(sourceChain, b, keepRounds) {
    await this.db.insertPriceTombstonesForRetraction(
        sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced, keepRounds);
    return this.db.deletePriceSnapshotsForRetraction(
        sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced, keepRounds);
}

// oracle_prices tracks the PRICE v1 oracle action via action_index
function oraclePriceRetractionDelete(sourceChain, b) {
    return this.db.deleteOraclePricesForRetraction(sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
}

// Tell the hub DB sync channel to mirror these deletes so distributed
// indexers prune their local price-table copies too. Carry to_action_index and
// retraction_generation so the replica's applyRetraction bounds and fences its
// delete identically (hub<->replica parity).
function emitRetractionDeletes(sourceChain, b, snapDeleted, oracleDeleted) {
    if (snapDeleted > 0) {
        let evt = { table: 'price_snapshots', source_chain: sourceChain, from_action_index: b.from };
        if (b.bounded) evt.to_action_index = b.to;
        if (b.fenced) evt.retraction_generation = b.gen;
        this.emit('row:deleted', evt);
    }
    if (oracleDeleted > 0) {
        let evt = { table: 'oracle_prices', source_chain: sourceChain, from_action_index: b.from };
        if (b.bounded) evt.to_action_index = b.to;
        if (b.fenced) evt.retraction_generation = b.gen;
        this.emit('row:deleted', evt);
    }
}

// A range deletion reaches mirrors before these unchanged rows. Re-emitting them
// immediately makes a connected mirror upsert the rounds this hub retained, while
// reconnecting mirrors re-page price_snapshots from zero and reach the same result.
function emitRetainedRows(rows, keepRounds) {
    if (!keepRounds.length) return;
    let kept = new Set(keepRounds);
    for (let row of rows) {
        if (kept.has(Number(row.round_number)))
            this.emit('row:inserted', { table: 'price_snapshots', row, origin: 'chain-ingest' });
    }
}

async function resetOrphanedLandingBlockTimes(sourceChain, b) {
    const rows = await this.db.findSelfFinalizedRoundsForBatchRetraction(
        sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
    const rounds = [...new Set((Array.isArray(rows) ? rows : [])
        .map(row => Number(row.round_number))
        .filter(Number.isSafeInteger))];
    if (rounds.length === 0) return;
    await this.db.resetSelfFinalizedBatchBlockTimeForRetraction(
        sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
    for (const round of rounds) {
        const resetRows = await this.db.findPriceSnapshotsForRound(round);
        for (const row of (Array.isArray(resetRows) ? resetRows : [])) {
            this.emit('row:inserted', { table: 'price_snapshots', row, origin: 'chain-ingest' });
        }
    }
}

// A retraction carries more windows than this only from a broken sender; refuse it.
const MAX_RETRACTED_BATCH_WINDOWS = 1000;

// The PRICE batch round windows a retraction names: absent means none (an indexer that
// predates the field). A malformed list resets nothing but never refuses the retraction:
// the indexer drops an "invalid" refusal as terminal, which would lose the deletes too.
function normalizeRetractedBatchWindows(batches) {
    if (batches === undefined || batches === null) return { windows: [] };
    if (!Array.isArray(batches) || batches.length > MAX_RETRACTED_BATCH_WINDOWS)
        return { error: 'invalid batches' };
    let windows = [];
    for (let batch of batches) {
        let first = parseIndex(batch && batch.first_round);
        let last = parseIndex(batch && batch.last_round);
        if (first === null || last === null || first < 0 || last < first) return { error: 'invalid batches' };
        windows.push({ first, last });
    }
    return { windows };
}

// The windows to reset, logging and dropping a malformed list.
function retractedBatchWindows(sourceChain, batches) {
    let retracted = normalizeRetractedBatchWindows(batches);
    if (!retracted.error) return retracted.windows;
    logger.error('PriceAggregator: ignoring malformed retracted batch windows from ' + sourceChain +
        '; their landing clocks are not reset');
    return [];
}

// Clear the landing clock on every round of each retracted batch window, whatever path
// stored the round. The batch-row join above finds only rounds this hub stored from the
// batch itself, so a batch whose every round this hub had already finalized left its
// stamp behind; the window names those rounds directly. Re-emits the reset rows so every
// mirror following this hub clears them too.
async function resetRetractedBatchWindows(windows) {
    for (let w of windows) {
        let rows = await this.db.findPriceSnapshotRoundsLandedBetween(w.first, w.last);
        let rounds = [...new Set((Array.isArray(rows) ? rows : [])
            .map(row => Number(row.round_number))
            .filter(Number.isSafeInteger))];
        if (rounds.length === 0) continue;
        await this.db.updatePriceSnapshotsClearBatchBlockTimeBetween(w.first, w.last);
        for (let round of rounds) {
            let resetRows = await this.db.findPriceSnapshotsForRound(round);
            for (let row of (Array.isArray(resetRows) ? resetRows : [])) {
                this.emit('row:inserted', { table: 'price_snapshots', row, origin: 'chain-ingest' });
            }
        }
    }
}

// The window reset as an error return: a failure makes the indexer retry, which is safe
// because the deletes before it are idempotent and the reset only ever writes 0.
async function resetRetractedBatchWindowsOrError(sourceChain, windows) {
    try {
        await resetRetractedBatchWindows.call(this, windows);
        return null;
    } catch (e) {
        logger.error(nodeUtil.format('PriceAggregator: could not reset retracted batch landing times for ' + sourceChain + ':', e && e.message));
        return { error: 'batch landing times not reset for ' + sourceChain
            + ' (' + ((e && e.message) || 'unknown error') + ')' };
    }
}

// A window list naming more rounds than this in total is from a broken sender; it
// clears no marker by range.
const MAX_RETRACTED_BATCH_ROUNDS = 10000;

// Every round the retracted windows name, ascending, or none past the cap.
function retractedWindowRounds(windows) {
    const rounds = new Set();
    for (const w of windows) {
        if (w.last - w.first + 1 > MAX_RETRACTED_BATCH_ROUNDS - rounds.size) return [];
        for (let round = w.first; round <= w.last; round++) rounds.add(round);
    }
    return Array.from(rounds).sort((a, b) => a - b);
}

// One marker clear, guarded because a publisher failure must never turn a completed
// retraction into an error return: the rows are already gone.
async function clearMarkersLogged(publisher, rounds, what, knownCarried) {
    try {
        if (knownCarried instanceof Set)
            await publisher.clearPublishedMarkers(rounds, knownCarried);
        else
            await publisher.clearPublishedMarkers(rounds);
    } catch (e) {
        logger.error(nodeUtil.format('PriceAggregator: clearing published markers for retracted batch '
            + what + ' ' + rounds.join(',') + ' failed:', e && e.message));
    }
}

// D28: clear the publisher's durable at-most-once marker for every round the retracted
// batch carried. Without this the marker outlives the rows it stands for, the
// at-most-once guard suppresses the re-publish that recovery needs, and the reorg costs
// an HOUR of price history instead of a round. The batch rows read before the deletes
// name only rounds this hub stored from the batch itself; a round this hub had already
// finalized carries no batch row, yet the retracted batch published it, so every round
// the retracted windows name that no batch row covered is cleared as well (all of them
// when nothing was deleted).
async function clearRetractedMarkers(publisher, batchRounds, windows, snapDeleted, carriedRounds) {
    let knownCarried = Array.isArray(carriedRounds) ? new Set(carriedRounds) : null;
    if (snapDeleted > 0 && batchRounds.length > 0)
        await clearMarkersLogged(publisher, batchRounds, 'rounds', knownCarried);
    const ranged = retractedWindowRounds(windows);
    const stored = new Set(batchRounds);
    const missing = snapDeleted === 0 ? ranged : ranged.filter(round => !stored.has(round));
    if (missing.length > 0) await clearMarkersLogged(publisher, missing, 'ranges', knownCarried);
}

async function readRetractedBatchRows(sourceChain, b) {
    let rows = [];
    try {
        if (typeof this.db.findBatchPriceSnapshotsForRetraction === 'function') {
            rows = await this.db.findBatchPriceSnapshotsForRetraction(
                sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
        } else if (typeof this.db.findBatchPriceSnapshotRoundsForRetraction === 'function') {
            rows = await this.db.findBatchPriceSnapshotRoundsForRetraction(
                sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
        }
    } catch (e) {
        logger.error(nodeUtil.format('PriceAggregator: could not read the retracted batch rounds for ' + sourceChain + ':', e && e.message));
    }
    let safeRows = Array.isArray(rows) ? rows : [];
    let rounds = [...new Set(safeRows.map(row => parseInt(row.round_number))
        .filter(Number.isFinite))];
    return { rows: safeRows, rounds };
}

async function roundsStillCarried(rounds) {
    if (rounds.length === 0) return [];
    if (typeof this.priceRoundsCarriedByChain !== 'function') return null;
    let timeout;
    try {
        let carried = await Promise.race([
            this.priceRoundsCarriedByChain(rounds),
            new Promise((resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('active-chain keep check timed out')),
                    PRICE_KEEP_CHECK_TIMEOUT_MS);
            })
        ]);
        return rounds.filter(round => carried instanceof Set && carried.has(round));
    } catch (e) {
        logger.warn(nodeUtil.format('PriceAggregator: could not check retracted PRICE rounds against the active chain:',
            e && e.message));
        return null;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

module.exports = {

    // Retract price rows seeded from PRICE actions that an indexer rolled back
    // during a reorg. The indexer pushes the source chain plus the lowest
    // rolled-back action_index; we delete every row tagged with that chain whose
    // source action_index is >= that value, across both price tables.
    //
    // This is the indexer-driven counterpart to ReorgHandler, which only reacts
    // to a separate PBFT reorg attestation. PBFT attestations never arrive for
    // non-PBFT reorgs, so without this path orphaned prices would survive
    // indefinitely and feed getLatestPrice / getOracleDataForVM / fee validation.
    //
    // sourceChain:     BTC | LTC | DOGE
    // fromActionIndex: lowest rolled-back action_index (inclusive)
    // Returns { retracted: { price_snapshots, oracle_prices } } with deleted row counts.
    // toActionIndex (optional) bounds the retraction to a CLOSED range [from, to]. A DEFERRED
    // (queued) retraction passes it so a price row re-published inside the original open-ended
    // range is not deleted (item 5296). Absent => open-ended `>= from`, the live-retraction
    // behavior. The bound is mirrored onto the row:deleted event so replicas apply the same delete.
    // retractionGeneration (optional, item 5308) is the source chain's push generation captured at
    // rollback start. When present, only rows stamped with push_generation <= it are deleted, so a
    // row re-published at a recycled action_index (higher generation) survives even though it falls
    // inside [from, to]. Omitted (older indexer) => no fence == today's behavior; the bound is
    // mirrored onto row:deleted so replicas fence identically.
    // batches (optional) names the round window [{first_round, last_round}] of each PRICE
    // batch the indexer rolled back; every round inside one has its landing clock cleared.
    async retractFromActionIndex(sourceChain, fromActionIndex, toActionIndex, retractionGeneration, batches) {
        // Fail-closed on a SUPPLIED-but-invalid bound: a malformed to/generation must not
        // collapse into the absent branch and widen this into the open-ended DELETE below.
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if (bounds.error) return { error: bounds.error };
        let windows = retractedBatchWindows(sourceChain, batches);
        let { from, to, gen, bounded, fenced } = bounds;

        let seam = publishedMarkerSeam.call(this);
        let canCheckChain = typeof this.priceRoundsCarriedByChain === 'function';
        let batchRead = (canCheckChain || seam.canClearMarkers)
            ? await readRetractedBatchRows.call(this, sourceChain, bounds)
            : { rows: [], rounds: [] };
        let batchRounds = batchRead.rounds;
        let chainCheckRounds = [...new Set(batchRounds.concat(retractedWindowRounds(windows)))];
        let carriedRounds = await roundsStillCarried.call(this, chainCheckRounds);
        let carried = new Set(Array.isArray(carriedRounds) ? carriedRounds : []);
        let keepRounds = batchRounds.filter(round => carried.has(round));

        // Awaited only when there is a fence to write, so an unfenced retraction issues
        // its DELETE without yielding first, in the same tick the unsplit method did.
        let fenceError = bounds.fenced ? await persistIngestFence.call(this, sourceChain, bounds) : null;
        if (fenceError) return fenceError;

        try {
            await resetOrphanedLandingBlockTimes.call(this, sourceChain, bounds);
        } catch (e) {
            logger.error(nodeUtil.format('PriceAggregator: could not reset orphaned batch landing times for ' + sourceChain + ':', e && e.message));
            return { error: 'batch landing times not reset for ' + sourceChain
                + ' (' + ((e && e.message) || 'unknown error') + ')' };
        }

        let snapResult = await snapshotRetractionDelete.call(this, sourceChain, bounds, keepRounds);
        let oracleResult = await oraclePriceRetractionDelete.call(this, sourceChain, bounds);

        let snapDeleted   = (snapResult   && snapResult.affectedRows   !== undefined) ? Number(snapResult.affectedRows)   : 0;
        let oracleDeleted = (oracleResult && oracleResult.affectedRows !== undefined) ? Number(oracleResult.affectedRows) : 0;

        emitRetractionDeletes.call(this, sourceChain, bounds, snapDeleted, oracleDeleted);
        emitRetainedRows.call(this, batchRead.rows, keepRounds);

        // After the deletes, so the batch's own rows are gone and only surviving rows are reset.
        let windowError = await resetRetractedBatchWindowsOrError.call(this, sourceChain, windows);
        if (windowError) return windowError;

        if (seam.canClearMarkers)
            await clearRetractedMarkers(seam.publisher, batchRounds, windows, snapDeleted, carriedRounds);

        // Restore any older hole in this retracted window through the same verified
        // batch ingest path. Failure is best-effort here: the completed retraction must
        // still acknowledge so its durable outbox can settle.
        if (windows.length > 0 && typeof this.schedulePriceChainRestore === 'function')
            this.schedulePriceChainRestore(windows, keepRounds);

        logger.info('PriceAggregator: retracted ' + snapDeleted + ' price_snapshots + ' + oracleDeleted + ' oracle_prices rows from ' + sourceChain + ' (action_index >= ' + from + (bounded ? ' AND <= ' + to : '') + (fenced ? ' AND push_generation <= ' + gen : '') + ')');
        return { retracted: { price_snapshots: snapDeleted, oracle_prices: oracleDeleted } };
    }

};
