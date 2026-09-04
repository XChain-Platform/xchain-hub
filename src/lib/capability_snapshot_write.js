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
 * XChain Hub - atomic capability_snapshots mirror write
 *
 * Six engines mirror a validator set into the shared capability_snapshots table
 * (StateCheckpointEngine, CrossChainDexEngine, CrossChainCallEngine, OracleConsensus,
 * RetractionConsensus, AttestationRelay) and every one of them wrote it one autocommit
 * INSERT at a time. db.doQuery takes a pooled connection per call and this hub sets no
 * transactionConnection anywhere, so a throw on any single row (deadlock, lock-wait
 * timeout, connection drop) left the earlier rows committed and the set for that
 * (snapshot_block, capability) permanently PARTIAL.
 *
 * That contradicts the fail-closed posture each writer's own truncation guard states: a
 * partial set carries no completeness marker, so an off-BTC verifier reads it as COMPLETE
 * and clears the strict 2/3 bar against an under-counted stake denominator, finalizing
 * what a correctly-mirrored node rejects.
 *
 * The whole set therefore goes in ONE statement. InnoDB rolls a failed statement back
 * whole and, under autocommit, the statement IS the transaction, so the mirror is
 * all-or-nothing without introducing a transaction idiom this repo does not have (its
 * transactionConnection is a per-Db global that would capture unrelated concurrent
 * queries). Do NOT chunk the statement: the set is capped at VALIDATOR_QUERY_LIMIT and
 * each writer refuses an over-cap set outright, so it fits one statement, and chunking
 * would silently reintroduce the partial-commit window this module exists to close.
 *
 * Broadcast stays with the callers: each engine reaches its subscribers differently, and
 * delivery is deliberately non-fatal where the committed write is not.
 *
 ********************************************************************/

const TABLE   = 'capability_snapshots';
const COLUMNS = '(snapshot_block, capability, signing_pubkey, amount, source)';

/**
 * Normalize a resolved validator set into snapshot rows, exactly as the six in-loop
 * copies did. Split out so a caller can broadcast the same values it wrote without
 * re-deriving them (and so the normalization is testable on its own).
 *
 * @returns {Array<{snapshot_block:number, capability:string, signing_pubkey:string,
 *                  amount:string, source:string}>}
 */
function normalizeCapabilitySnapshotRows(capability, block, validators){
    return (validators || []).map(v => ({
        snapshot_block: block,
        capability:     capability,
        signing_pubkey: String(v.pubkey).toLowerCase(),
        amount:         String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')),
        source:         String(v.source != null ? v.source : '')
    }));
}

/**
 * Write the whole validator set in one INSERT IGNORE, all-or-nothing.
 *
 * Returns the normalized rows so the caller can broadcast them; an empty set writes
 * nothing and returns [], which is what the truncation guard's "no rows mirrored" and an
 * empty capability set both want.
 */
async function writeCapabilitySnapshotRows(db, capability, block, validators){
    let rows = normalizeCapabilitySnapshotRows(capability, block, validators);
    if(rows.length === 0) return rows;

    let args = [];
    for(let r of rows)
        args.push(r.snapshot_block, r.capability, r.signing_pubkey, r.amount, r.source);

    await db.doQuery(
        'INSERT IGNORE INTO ' + TABLE + ' ' + COLUMNS + ' VALUES ' +
        rows.map(() => '(?, ?, ?, ?, ?)').join(', '),
        args);

    return rows;
}

module.exports = { TABLE, COLUMNS, normalizeCapabilitySnapshotRows, writeCapabilitySnapshotRows };
