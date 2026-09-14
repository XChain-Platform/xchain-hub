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

const { normalizeRetractionBounds } = require('../../lib/retraction_bounds.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// D28: the rounds a retracted BATCH carried, read BEFORE the DELETE because
// afterwards there is nothing left to read them off. Batch-sourced rows are the
// ones whose consensus_proof is the {"batch":...} object of D23; a v0-sourced
// row's proof is a bare signature ARRAY, so the prefix is an exact discriminator
// and v0 retraction behaviour is untouched. Only worth a query when a publisher
// exposing the clear seam is actually wired: on a mirror hub the answer has no
// consumer, so the retraction path stays a two-statement path there.
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
function snapshotRetractionDelete(sourceChain, b) {
    return this.db.deletePriceSnapshotsForRetraction(sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
}

// oracle_prices tracks the PRICE v1 oracle action via action_index
function oraclePriceRetractionDelete(sourceChain, b) {
    return this.db.deleteOraclePricesForRetraction(sourceChain, b.from, b.to, b.gen, b.bounded, b.fenced);
}

// Tell the hub DB sync channel to mirror these deletes so distributed
// indexers prune their local price-table copies too. Carry to_action_index and
// retraction_generation so the replica's _applyRetraction bounds and fences its
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
    async retractFromActionIndex(sourceChain, fromActionIndex, toActionIndex, retractionGeneration) {
        // Fail-closed on a SUPPLIED-but-invalid bound: a malformed to/generation must not
        // collapse into the absent branch and widen this into the open-ended DELETE below.
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if (bounds.error) return { error: bounds.error };
        let { from, to, gen, bounded, fenced } = bounds;

        let seam = publishedMarkerSeam.call(this);
        let batchRounds = [];
        if (seam.canClearMarkers) {
            try {
                let rows = await this.db.findBatchPriceSnapshotRoundsForRetraction(sourceChain, from, to, gen, bounded, fenced);
                for (let row of (rows || [])) {
                    let n = parseInt(row.round_number);
                    if (Number.isFinite(n)) batchRounds.push(n);
                }
            } catch (e) {
                logger.error(nodeUtil.format('PriceAggregator: could not read the retracted batch rounds for ' + sourceChain + ':', e && e.message));
            }
        }

        // Awaited only when there is a fence to write, so an unfenced retraction issues
        // its DELETE without yielding first, in the same tick the unsplit method did.
        let fenceError = bounds.fenced ? await persistIngestFence.call(this, sourceChain, bounds) : null;
        if (fenceError) return fenceError;

        let snapResult = await snapshotRetractionDelete.call(this, sourceChain, bounds);
        let oracleResult = await oraclePriceRetractionDelete.call(this, sourceChain, bounds);

        let snapDeleted   = (snapResult   && snapResult.affectedRows   !== undefined) ? Number(snapResult.affectedRows)   : 0;
        let oracleDeleted = (oracleResult && oracleResult.affectedRows !== undefined) ? Number(oracleResult.affectedRows) : 0;

        emitRetractionDeletes.call(this, sourceChain, bounds, snapDeleted, oracleDeleted);

        // D28: clear the publisher's durable at-most-once marker for every round the
        // retracted batch carried. Without this the marker outlives the rows it stands
        // for, the at-most-once guard suppresses the re-publish that recovery needs, and
        // the reorg costs an HOUR of price history instead of a round. Guarded because a
        // publisher failure must never turn a completed retraction into an error return:
        // the rows are already gone.
        if (seam.canClearMarkers && snapDeleted > 0 && batchRounds.length > 0) {
            try {
                await seam.publisher.clearPublishedMarkers(batchRounds);
            } catch (e) {
                logger.error(nodeUtil.format('PriceAggregator: clearing published markers for retracted batch rounds '
                    + batchRounds.join(',') + ' failed:', e && e.message));
            }
        }

        logger.info('PriceAggregator: retracted ' + snapDeleted + ' price_snapshots + ' + oracleDeleted + ' oracle_prices rows from ' + sourceChain + ' (action_index >= ' + from + (bounded ? ' AND <= ' + to : '') + (fenced ? ' AND push_generation <= ' + gen : '') + ')');
        return { retracted: { price_snapshots: snapDeleted, oracle_prices: oracleDeleted } };
    }

};
