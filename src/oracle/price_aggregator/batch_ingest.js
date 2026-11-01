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
 * XChain Hub - Price Aggregator: PRICE batch ingest
 *
 * Receives ONE quorum signature set over a WINDOW of rounds: verifies the set
 * once against the batch canonical, stores each round that is not already
 * finalized here, and stamps the landing clock on the ones that are.
 *
 ********************************************************************/

const { validateBatchWindow, validateBatchAnchors, validateBatchRounds,
        refuseUnanchoredOrStraddlingBatch, validateBatchSigs } = require('./batch_validation.js');
const { verifyBatchQuorum } = require('./batch_verification.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Source-chain reorg fence (item 5308 / HUB-RETRACT-4), same as the v0 path: a
// batch push that arrives after its source action was rolled back and retracted
// carries the pre-reorg generation and is dropped; the re-published canonical
// batch carries a higher one. Checked before any verification work.
function batchFenceInputs(batchData) {
    let sourceActionIndex = batchData.action_index === undefined || batchData.action_index === null
        ? null : batchData.action_index;
    let pushGeneration = parseInt(batchData.push_generation);
    if (!Number.isFinite(pushGeneration) || pushGeneration < 0) pushGeneration = 0;
    let batchActionIndex = parseInt(sourceActionIndex);
    return { sourceActionIndex, pushGeneration, batchActionIndex };
}

// Read every candidate round with one bulk query. Repair may supply the result
// from its pass-wide presence read so the verified ingest adds no second read.
async function batchPresenceRows(rounds, supplied) {
    if (Array.isArray(supplied)) return supplied;
    let numbers = rounds.map(r => r.round);
    let rows = await this.db.findPriceSnapshotRowsForRounds(numbers);
    return Array.isArray(rows) ? rows : [];
}

function rowsByRound(rows) {
    let grouped = new Map();
    for (let row of (Array.isArray(rows) ? rows : [])) {
        let round = Number(row && row.round_number);
        if (!Number.isSafeInteger(round)) continue;
        if (!grouped.has(round)) grouped.set(round, []);
        grouped.get(round).push(row);
    }
    return grouped;
}

// Column semantics pinned so a v2-sourced row is indistinguishable from a
// v0-sourced one (§5.7): block_timestamp is the ROUND's own timestamp (the
// field the fee path reads), and reference_block is the PUSH's block_index,
// the landing block on the landing chain (D8), NOT the round's BTC anchor.
// Two consensus readers read reference_block, so a v2 row that differed here
// would fork them.
//
// batch_block_time is the LANDING BLOCK's own clock, and it is a different
// quantity from every other time column here: block_timestamp is when the
// round was priced, this is when the chain could first show it. Fee pricing
// bounds itself on it so a hub-connected node and a chain-only node select
// the same round (the indexer's registry row
// price_fee_batch_landed_activation.PRICE_FEE_BATCH_LANDED_ACTIVATION in src/protocol_changes/gates_2.js).
// The round's admission map lands in its per-chain columns, every federation
// column named so a legacy round NULLs them rather than leaving a default a later
// schema edit could change under a signed row. Appended AFTER created_at so every
// positional reader of this INSERT keeps its index.
function batchSnapshotRows(r, sourceChain, head, verified, fence, createdAt, admitCols) {
    let insertedRows = [];
    for (let p of r.pairs) {
        insertedRows.push({
            round_number:        r.round,
            coin_pair:           p.pair,
            price:               p.price,
            reference_block:     head.referenceBlock,
            reference_chain:     sourceChain || null,
            block_timestamp:     r.timestamp,
            validator_count:     verified.validatorCount,
            consensus_round:     1,
            consensus_proof:     verified.proofJson,
            status:              'finalized',
            source_chain:        sourceChain || null,
            source_action_index: fence.sourceActionIndex,
            push_generation:     fence.pushGeneration,
            batch_block_time:    head.blockTime,
            created_at:          createdAt,
            admit_block_btc:     admitCols.admit_block_btc,
            admit_block_ltc:     admitCols.admit_block_ltc,
            admit_block_doge:    admitCols.admit_block_doge
        });
    }
    return insertedRows;
}

// ONE multi-row INSERT PER ROUND, not one for the whole batch: a single
// statement is the atomicity tool, with no db.withTransaction needed,
// and the unit that must never be observed torn is the round (a
// getfeequote reader must not see some pairs of round N beside others of
// round N-1). Across rounds a partial batch is fine, because each stored
// round is independently complete and the rest arrive on the next attempt.
function batchRoundInsert(r, sourceChain, head, verified, fence, createdAt, admitCols) {
    return this.db.setBatchPriceSnapshotRound(r.round, r.pairs, head.referenceBlock, sourceChain || null, r.timestamp,
        verified.validatorCount, verified.proofJson, fence.sourceActionIndex, fence.pushGeneration, head.blockTime,
        createdAt, admitCols);
}

// A duplicate round whose stored row is the ORPHANED landing of this same batch: the
// source chain rolled the batch back and re-mined it, and the re-push reached the hub
// before (or while) the retraction for the rolled-back action ran. Deduping it would
// leave the row on its pre-reorg generation, so the generation-fenced retraction
// delete then removes the only row the canonical batch has, and nothing re-pushes a
// batch that already landed.
//
// The test is one-directional: a batch row from the same source chain, at a LOWER
// push generation, whose action index is at or ABOVE this push's. A source chain's
// action counter only moves backwards through a rollback, so that combination means
// the stored row's action was rolled back. An overlapping batch from a later window
// (D25) always carries a higher action index and keeps the plain dedupe, so a round
// an untouched earlier batch still carries is never re-attributed to a newer one.
// Self-finalized rows (no action index, bare-array proof) never match.
async function orphanedBatchLandingOf(sourceChain, rows, fence) {
    if (!sourceChain || !Number.isFinite(fence.batchActionIndex)) return false;
    if (!Array.isArray(rows)) return false;
    for (let row of rows) {
        if (!row || row.status === 'skipped' || row.source_chain !== sourceChain) continue;
        if (typeof row.consensus_proof !== 'string' || !row.consensus_proof.startsWith('{"batch":')) continue;
        let gen = Number(row.push_generation);
        let action = Number(row.source_action_index);
        if (row.source_action_index === null || row.source_action_index === undefined) continue;
        if (Number.isFinite(gen) && Number.isFinite(action) &&
            gen < fence.pushGeneration && action >= fence.batchActionIndex) return true;
    }
    return false;
}

// Re-store a re-landed round from the canonical batch through the same per-round
// upsert, which moves its action index, generation, landing block and proof onto the
// canonical landing, so the generation fence of the late retraction spares it. Emits
// what the hub now HOLDS (the upsert keeps the earlier landing clock), re-read rather
// than built, so a mirror never receives a value this hub does not store.
async function restoreRelandedBatchRound(r, sourceChain, head, verified, fence, createdAt) {
    let admitCols = this.admission.admitBlocksToColumns(r.admitBlocks === undefined ? null : r.admitBlocks);
    await batchRoundInsert.call(this, r, sourceChain, head, verified, fence, createdAt, admitCols);
    let rows = await this.db.findPriceSnapshotsForRound(r.round);
    for (let row of (Array.isArray(rows) ? rows : [])) {
        if (row && row.status !== 'skipped') {
            this.emit('row:inserted', { table: 'price_snapshots', row: row, origin: 'chain-ingest' });
        }
    }
    logger.warn('PriceAggregator: round ' + r.round + ' re-landed from ' + sourceChain + ' at action ' +
        fence.sourceActionIndex + ' generation ' + fence.pushGeneration +
        '; its rolled-back batch row is moved onto the canonical landing');
}

async function handleDuplicateBatchRound(sourceChain, r, head, verified, fence, createdAt,
                                         existing, targetRounds) {
    if (existing.length === 0) return false;
    // Repair validates the whole signed batch but only mutates rounds its one
    // bulk presence read selected. A present target was retained across a late
    // retraction and must move onto the active batch just like a same-position
    // re-land, including its action index, generation, proof and landing clock.
    if (targetRounds && !targetRounds.has(r.round)) return true;
    try {
        let relanded = !!targetRounds ||
            await orphanedBatchLandingOf.call(this, sourceChain, existing, fence);
        if (relanded)
            await restoreRelandedBatchRound.call(this, r, sourceChain, head, verified, fence, createdAt);
    } catch (err) {
        // The round is still finalized here; a failed move leaves it on the old
        // landing, which is what the dedupe did before, so it is never a reject.
        logger.error(nodeUtil.format('PriceAggregator: could not move re-landed round ' + r.round +
            ' onto its canonical batch:', err));
    }
    // The batch is how the round reached the chain even when this hub finalized
    // it first, so stamp the landing clock on every ordinary duplicate.
    await this.stampBatchLanding(r.round, head.blockTime);
    return true;
}

// Store every round of a verified batch that is not already finalized here, and
// stamp the landing clock on the ones that are. Async because the dedupe read, the
// insert and the stamp are its own awaits, in the order the single pass made them;
// the caller only logs and returns after it.
async function storeBatchRounds(sourceChain, head, rounds, verified, fence, options) {
    let createdAt = new Date();
    let stored = 0, duplicates = 0;
    let grouped = rowsByRound(await batchPresenceRows.call(this, rounds, options && options.existingRows));
    let targetRounds = options && options.targetRounds instanceof Set ? options.targetRounds : null;
    for (let r of rounds) {
        let existing = (grouped.get(r.round) || []).filter(row => row && row.status !== 'skipped');
        if (await handleDuplicateBatchRound.call(this, sourceChain, r, head, verified, fence,
            createdAt, existing, targetRounds)) {
            duplicates++;
            continue;
        }

        if (targetRounds && !targetRounds.has(r.round)) {
            duplicates++;
            continue;
        }

        let admitCols = this.admission.admitBlocksToColumns(r.admitBlocks === undefined ? null : r.admitBlocks);
        let insertedRows = batchSnapshotRows(r, sourceChain, head, verified, fence, createdAt, admitCols);
        try {
            await batchRoundInsert.call(this, r, sourceChain, head, verified, fence, createdAt, admitCols);
        } catch (err) {
            logger.error(nodeUtil.format('PriceAggregator: error inserting batch round ' + r.round + ':', err));
            return {
                accepted: false, stored, duplicates,
                rejected: rounds.length - stored - duplicates,
                reason: 'db error'
            };
        }

        // Re-emit on the WS mirror stream exactly as v0-stored rows do, or a
        // replaying node's mirror never fills and its price barrier never opens.
        for (let row of insertedRows) {
            this.emit('row:inserted', { table: 'price_snapshots', row: row, origin: 'chain-ingest' });
        }
        stored++;

        // Diagnostics only, and guarded: the round is already stored and must never
        // be flipped to rejected by a coverage warning (item 5335).
        try {
            this.checkIngestPairCoverage(sourceChain, r.round, r.pairs);
        } catch (e) {
            logger.warn(nodeUtil.format('PriceAggregator: pair-coverage check failed for round ' + r.round + ':', e.message));
        }
    }
    return { stored, duplicates };
}

// Tell the batch rail these rounds are on chain, WHETHER OR NOT any row was
// stored. On a validator every round is normally a duplicate here (it finalized
// them itself), so the stored rows the publisher's observation prune keys on
// never appear, and its buffer kept every round it ever finalized until the
// catch-up sweep re-published them as duplicates. The batch header is
// the chain-derived range and this push reaches every hub, so it is the one
// place a follower learns that a window it did not lead has landed.
function noteLandedBatchToPublisher(sourceChain, batchData, head) {
    let landedPublisher = this.hub && this.hub.oraclePublisher;
    if (landedPublisher && typeof landedPublisher.noteBatchLanded === 'function') {
        try {
            landedPublisher.noteBatchLanded(head.firstRound, head.lastRound,
                { sourceChain: sourceChain, actionIndex: batchData.action_index });
        } catch (e) {
            logger.warn(nodeUtil.format('PriceAggregator: could not hand the landed batch [' + head.firstRound + '..' +
                head.lastRound + '] to the publisher; its rounds stay buffered:', e && e.message));
        }
    }
}

module.exports = {

    // Stamp the LANDING clock of the batch that carried `round` onto rows of that
    // round which are already finalized here, and re-emit whatever it changed so every
    // mirror following this hub converges on the same value.
    //
    // EARLIEST LANDING WINS. Overlapping and re-published batches carry the same rounds
    // by design (D25), so taking the minimum makes the stored clock independent of the
    // order a hub happened to receive them in; two hubs that saw the same chain end up
    // bounding fee pricing identically, which is the whole point of the column.
    //
    // Returns the number of rows re-emitted (0 when an earlier batch already stamped
    // the round at or below this clock).
    async stampBatchLanding(round, blockTime) {
        let landed = Number(blockTime);
        if (!Number.isSafeInteger(landed) || landed <= 0) return 0;
        try {
            await this.db.updatePriceSnapshotByRoundNumber(landed, round, landed);
            // Re-read rather than trust an affected-row count: the mirror applier is an
            // upsert keyed on (round_number, coin_pair), so it needs the WHOLE row, and
            // selecting the rows that now carry THIS clock also skips the no-op case
            // without asking the driver for a count it does not uniformly report.
            let rows = await this.db.findPriceSnapshotsByRoundNumberAndBatchBlockTime(round, landed);
            for (let row of (rows || [])) {
                this.emit('row:inserted', { table: 'price_snapshots', row: row, origin: 'chain-ingest' });
            }
            return (rows || []).length;
        } catch (err) {
            // Never fatal: the round is finalized either way, and an unstamped round
            // reads as NOT LANDED, which fails fee pricing closed rather than pricing
            // against a round the chain has not shown. Loud, because a hub that cannot
            // stamp holds the fee gate shut for its own indexers once the bound is armed.
            logger.error(nodeUtil.format('PriceAggregator: could not stamp the landing clock for round ' +
                round + ':', err));
            return 0;
        }
    },

    // PRICE v0 (batch) ingest: ONE quorum signature set over a WINDOW of full-body
    // rounds. Same posture as receiveValidatedRound (the pusher's local validation is
    // never trusted; every signature is re-verified here against the canonical bytes
    // the validators signed), with the two differences the batch shape forces:
    //
    //   - the signature set is verified ONCE, because it covers every round in the
    //     window. A signature or structural failure therefore rejects the WHOLE batch,
    //     exactly as it rejects a whole round in v0: a signed batch is atomic.
    //   - dedupe is PER ROUND, not the whole-call early return receiveValidatedRound
    //     uses. Overlapping and re-published batches are expected (leaders may split a
    //     window differently, D25), so a whole-call return over one already-finalized
    //     round would silently drop the five good rounds sharing the batch, and under
    //     batching the batch is the SOLE carrier of those rounds for a chain-only node.
    //
    // Returns { accepted, stored, duplicates, rejected } (D13). `accepted` is true iff
    // every round either stored or deduped; `reason` names the cause when it is not.
    async receiveValidatedBatch(sourceChain, batchData, options) {
        let roundCount = (batchData && Array.isArray(batchData.rounds)) ? batchData.rounds.length : 0;
        // Whole-batch rejection: nothing stored, nothing deduped, every round refused.
        let refuse = (reason) => ({ accepted: false, stored: 0, duplicates: 0, rejected: roundCount, reason });

        let head = validateBatchWindow.call(this, sourceChain, batchData);
        if (head.reason) return refuse(head.reason);
        let anchors = validateBatchAnchors.call(this, batchData);
        if (anchors.reason) return refuse(anchors.reason);
        Object.assign(head, anchors);

        let parsed = validateBatchRounds.call(this, batchData, head);
        if (parsed.reason) return refuse(parsed.reason);
        let anchorReason = refuseUnanchoredOrStraddlingBatch.call(this, head.btcBlockHeight, parsed.rounds);
        if (anchorReason) return refuse(anchorReason);

        let structural = validateBatchSigs(batchData);
        if (structural.reason) return refuse(structural.reason);

        let fence = batchFenceInputs(batchData);
        if (Number.isFinite(fence.batchActionIndex)) {
            let wm = await this.db.getPriceIngestWatermark(sourceChain || '', this.fenceNetwork());
            if (wm && fence.pushGeneration <= wm.retraction_generation && fence.batchActionIndex >= wm.from_action_index) {
                // Never silent: a rebuilt indexer trips this fence on every push.
                this.warnIngestFenceRejection(sourceChain, 'PRICE batch', fence.pushGeneration, fence.batchActionIndex, wm);
                return refuse('stale (retracted generation)');
            }
        }

        let verified = await verifyBatchQuorum.call(this, structural.sigs, head, parsed.rounds);
        if (verified.reason) return refuse(verified.reason);

        let result = await storeBatchRounds.call(this, sourceChain, head, parsed.rounds, verified, fence, options);
        if (result.reason) return result;

        logger.info('PriceAggregator: accepted batch [' + head.firstRound + '..' + head.lastRound + '] from '
            + (sourceChain || 'unknown') + ' (' + result.stored + ' stored, ' + result.duplicates + ' duplicate round(s), '
            + verified.validatorCount + ' sigs)');

        noteLandedBatchToPublisher.call(this, sourceChain, batchData, head);

        return { accepted: true, stored: result.stored, duplicates: result.duplicates, rejected: 0 };
    }

};
