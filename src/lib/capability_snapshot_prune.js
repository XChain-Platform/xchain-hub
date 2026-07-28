'use strict';

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
 * XChain Hub - stale capability_snapshots prune 
 *
 * capability_snapshots rows are keyed UNIQUE on
 * (snapshot_block, capability, signing_pubkey, source) and every writer
 * inserts with INSERT IGNORE (CrossChainCallEngine._persistCapabilitySnapshot,
 * CrossChainDexEngine, StateCheckpointEngine). That is safe only while every
 * row in the table belongs to the chain the hub is currently following.
 *
 * When a regtest / testnet chain is RESET, the rows written under the dead
 * incarnation keep their old snapshot_block values. Two things then go wrong
 * once the new chain mines back up through those heights:
 *
 *   1. Collision. A fresh snapshot at a height the dead chain also used is
 *      swallowed by INSERT IGNORE, so the mirror keeps the DEAD chain's
 *      validator set and stake for that boundary. Nothing errors; the quorum
 *      is just silently wrong for any verifier reading the table.
 *   2. Wedge. Rows for heights the live chain has not reached yet look to a
 *      mirror-side barrier (xchain-indexer hub_db_sync._snapshotSyncSatisfied)
 *      like snapshots it must still catch up to, and mining cannot drain them.
 *
 * This module is the operator tool for removing such rows. It is deliberately
 * range-bound and parameterized: there is no "delete everything" mode, and the
 * block range must be stated explicitly by the operator.
 *
 * Scope note: this prunes the HUB's own table. Mirrors replicate
 * capability_snapshots by an id watermark (HubDbBroadcaster), and the wire
 * protocol's row:deleted event is action_index shaped (price / xcall
 * retractions), so it cannot express a snapshot_block range. A mirror that
 * already copied the dead rows must be reset separately; venues where the
 * indexer reads the hub DB directly (this.hubDb) need no second step.
 *
 ********************************************************************/

const TABLE = 'capability_snapshots';

// Matches the capability names in src/capabilities (price, cross_chain,
// oracle_publish, attestation, full_node) and the column width (VARCHAR(20)).
const CAPABILITY_REGEX = /^[a-z][a-z_]{0,19}$/;

// A DATE or DATETIME literal, the two shapes MariaDB compares directly against
// a TIMESTAMP column. Anything else is rejected rather than coerced.
const CREATED_BEFORE_REGEX = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/;

// MariaDB BIGINT UNSIGNED tops out well above any block height; cap the range
// at Number.MAX_SAFE_INTEGER so an open-ended prune stays exactly representable.
const MAX_BLOCK = Number.MAX_SAFE_INTEGER;

const DEFAULT_BATCH_SIZE = 1000;

function isWholeNumber(v){
    return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Validate and normalize the caller's prune range.
 *
 * fromBlock is REQUIRED: an operator must always say where the dead range
 * starts, so a typo cannot turn into a full-table wipe. toBlock is optional and
 * inclusive; omitting it means "and everything above", which is the shape used
 * to clear snapshots that sit ahead of a reset chain's tip.
 *
 * @returns {{fromBlock:number, toBlock:number, capability:string|null}}
 */
function normalizeRange(opts){
    let o = opts || {};

    let fromBlock = (typeof o.fromBlock === 'string' && o.fromBlock.trim() !== '') ? Number(o.fromBlock) : o.fromBlock;
    if(!isWholeNumber(fromBlock))
        throw new Error('fromBlock is required and must be a non-negative integer');

    let toBlock = o.toBlock;
    if(typeof toBlock === 'string' && toBlock.trim() !== '') toBlock = Number(toBlock);
    if(toBlock === undefined || toBlock === null || toBlock === '') toBlock = MAX_BLOCK;
    if(!isWholeNumber(toBlock))
        throw new Error('toBlock must be a non-negative integer when given');
    if(toBlock > MAX_BLOCK)
        throw new Error('toBlock exceeds the safe integer range');
    if(toBlock < fromBlock)
        throw new Error('toBlock (' + toBlock + ') must be >= fromBlock (' + fromBlock + ')');

    let capability = o.capability;
    if(capability === undefined || capability === null || capability === '') capability = null;
    if(capability !== null){
        if(typeof capability !== 'string' || !CAPABILITY_REGEX.test(capability))
            throw new Error('Invalid capability: ' + String(capability));
    }

    // Optional write-time cutoff. Once the live chain has mined back through the
    // dead range, height alone no longer separates dead rows from real ones, so
    // an operator can fence the prune to rows written before the reset.
    let createdBefore = o.createdBefore;
    if(createdBefore === undefined || createdBefore === null || createdBefore === '') createdBefore = null;
    if(createdBefore !== null){
        if(typeof createdBefore !== 'string' || !CREATED_BEFORE_REGEX.test(createdBefore))
            throw new Error('Invalid createdBefore (expected YYYY-MM-DD or YYYY-MM-DD HH:MM:SS): ' + String(createdBefore));
        if(Number.isNaN(Date.parse(createdBefore.replace(' ', 'T'))))
            throw new Error('Invalid createdBefore (not a real date): ' + createdBefore);
    }

    return { fromBlock, toBlock, capability, createdBefore };
}

// Build the shared WHERE clause. Every value is bound, never interpolated: the
// capability comes from an operator flag and must not reach the SQL text even
// though it is regex-checked.
function buildWhere(range){
    let clause = 'snapshot_block BETWEEN ? AND ?';
    let args   = [range.fromBlock, range.toBlock];
    if(range.capability !== null){
        clause += ' AND capability = ?';
        args.push(range.capability);
    }
    if(range.createdBefore){
        clause += ' AND created_at < ?';
        args.push(range.createdBefore);
    }
    return { clause, args };
}

/**
 * Per-block detail for the range, newest write first. This is how an operator
 * confirms which heights carry dead-chain rows before deleting anything.
 *
 * @returns {Array<{snapshotBlock:number, capability:string, rows:number,
 *                  minCreated:*, maxCreated:*}>}
 */
async function listStaleBlocks(db, opts, limit){
    let range = normalizeRange(opts);
    let where = buildWhere(range);

    let cap = (limit === undefined || limit === null) ? 200 : Number(limit);
    if(!isWholeNumber(cap) || cap < 1)
        throw new Error('limit must be a positive integer');

    let rows = await db.doQuery(
        'SELECT snapshot_block, capability, COUNT(*) AS rows_count, ' +
        'MIN(created_at) AS min_created, MAX(created_at) AS max_created ' +
        'FROM ' + TABLE + ' WHERE ' + where.clause +
        ' GROUP BY snapshot_block, capability ORDER BY snapshot_block ASC LIMIT ?',
        where.args.concat([cap])
    );

    return (rows || []).map(r => ({
        snapshotBlock: Number(r.snapshot_block),
        capability:    String(r.capability),
        rows:          Number(r.rows_count),
        minCreated:    r.min_created || null,
        maxCreated:    r.max_created || null
    }));
}

/**
 * Count what a prune would remove, grouped by capability, plus the block span.
 * This is the dry-run and the post-prune verification in one call.
 *
 * @returns {{total:number, blocks:number, minBlock:number|null, maxBlock:number|null,
 *            byCapability:Array<{capability:string, rows:number, minBlock:number, maxBlock:number}>}}
 */
async function summarizeStale(db, opts){
    let range = normalizeRange(opts);
    let where = buildWhere(range);

    let rows = await db.doQuery(
        'SELECT capability, COUNT(*) AS rows_count, MIN(snapshot_block) AS min_block, ' +
        'MAX(snapshot_block) AS max_block, COUNT(DISTINCT snapshot_block) AS block_count, ' +
        'MIN(created_at) AS min_created, MAX(created_at) AS max_created ' +
        'FROM ' + TABLE + ' WHERE ' + where.clause + ' GROUP BY capability ORDER BY capability ASC',
        where.args
    );

    // created_at is what separates a dead incarnation's rows from live ones once
    // the new chain has mined back through the same heights: block numbers alone
    // no longer distinguish them, the write time does.
    let byCapability = (rows || []).map(r => ({
        capability: String(r.capability),
        rows:       Number(r.rows_count),
        blocks:     Number(r.block_count),
        minBlock:   Number(r.min_block),
        maxBlock:   Number(r.max_block),
        minCreated: r.min_created || null,
        maxCreated: r.max_created || null
    }));

    let total    = byCapability.reduce((a, c) => a + c.rows, 0);
    let minBlock = byCapability.length ? Math.min(...byCapability.map(c => c.minBlock)) : null;
    let maxBlock = byCapability.length ? Math.max(...byCapability.map(c => c.maxBlock)) : null;

    // Distinct blocks across capabilities needs its own pass; per-capability
    // block counts overlap and must not be summed.
    let blocks = 0;
    if(total > 0){
        let b = await db.doQuery(
            'SELECT COUNT(DISTINCT snapshot_block) AS block_count FROM ' + TABLE + ' WHERE ' + where.clause,
            where.args
        );
        blocks = (b && b.length && b[0].block_count != null) ? Number(b[0].block_count) : 0;
    }

    return { range, total, blocks, minBlock, maxBlock, byCapability };
}

/**
 * Delete the stale rows in bounded batches.
 *
 * Batching keeps a single statement from holding a long row lock on a table
 * that live consensus writes to; the range is closed so re-running is a no-op
 * once the rows are gone (idempotent by construction).
 *
 * @returns {{deleted:number, batches:number, remaining:number, range:object}}
 */
async function pruneStale(db, opts){
    let range = normalizeRange(opts);
    let where = buildWhere(range);

    let batchSize = (opts && opts.batchSize !== undefined) ? Number(opts.batchSize) : DEFAULT_BATCH_SIZE;
    if(!isWholeNumber(batchSize) || batchSize < 1)
        throw new Error('batchSize must be a positive integer');

    let deleted = 0;
    let batches = 0;

    for(;;){
        let res = await db.doQuery(
            'DELETE FROM ' + TABLE + ' WHERE ' + where.clause + ' LIMIT ?',
            where.args.concat([batchSize])
        );
        let n = Number((res && res.affectedRows) || 0);
        deleted += n;
        batches++;
        if(n < batchSize) break;
    }

    let after = await summarizeStale(db, opts);
    return { deleted, batches, remaining: after.total, range };
}

module.exports = {
    TABLE,
    CAPABILITY_REGEX,
    CREATED_BEFORE_REGEX,
    MAX_BLOCK,
    DEFAULT_BATCH_SIZE,
    normalizeRange,
    buildWhere,
    summarizeStale,
    listStaleBlocks,
    pruneStale
};
