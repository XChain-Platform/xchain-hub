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
const COLUMNS = '(snapshot_block, capability, signing_pubkey, amount, source, btc_chain_id)';

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
 * The chain instance this hub's rows belong to (hash of BTC block 1 on the chain its
 * Bitcoin indexer follows). Resolved here for the callers that do not pass one, so the
 * five writers outside the cross-chain engines keep their four-argument call shape and
 * still stamp the identity. Never throws and never blocks the write: an unknown identity
 * is NULL, which is exactly how every row written before this column reads, and NULL is
 * accepted by every mirror.
 */
async function resolveBtcChainId(db){
    try {
        if(!db || typeof db.getChainTip !== 'function') return null;
        // capability_snapshots has no network column: the set belongs to the hub, so the
        // hub's own network is the one to ask about.
        let tip = await db.getChainTip('bitcoin', process.env.HUB_NETWORK || '');
        return (tip && tip.chainId) ? tip.chainId : null;
    } catch(e){
        return null;
    }
}

/**
 * Write the whole validator set in one INSERT IGNORE, all-or-nothing.
 *
 * Returns the normalized rows so the caller can broadcast them; an empty set writes
 * nothing and returns [], which is what the truncation guard's "no rows mirrored" and an
 * empty capability set both want. A set carrying `truncated` is refused here too, so a
 * writer that never learned the rule still cannot put a partial set in the mirror; a
 * complete set never carries the marker, so nothing legitimate changes shape.
 *
 * `btcChainId` is optional: a caller that already knows the row network's identity passes
 * it, and anyone else lets resolveBtcChainId ask the database. The column is transport,
 * never consensus: it is not in uq_cap_snap and it is in no signed canonical, so stamping
 * it cannot change which set a verifier reads or how the set dedupes.
 */
async function writeCapabilitySnapshotRows(db, capability, block, validators, btcChainId){
    // SWQ-TRUNC-MIRROR held at the choke point, so no writer can forget it in either
    // quorum mode: a truncated set has dropped signers and no completeness column, so a
    // mirror reads it COMPLETE. Refusing leaves S=0, which fails closed like an empty set.
    //
    // RULED 2026-09-11 (operator): acceptable ungated, no activation gate needed. With
    // VALIDATOR_QUERY_LIMIT at 1000 and today's roster of 6, this branch cannot currently
    // fire; it is safe by unreachability, not by design. Revisit when the qualifying
    // roster nears VALIDATOR_QUERY_LIMIT: either gate this refusal behind an activation
    // check at that point, or re-affirm the ungated ruling.
    if(validators && validators.truncated === true){
        console.warn('capability_snapshot_write: refusing to mirror a TRUNCATED ' + capability +
                     ' capability snapshot at block ' + block +
                     ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
        return [];
    }
    let rows = normalizeCapabilitySnapshotRows(capability, block, validators);
    if(rows.length === 0) return rows;

    let chainId = (btcChainId === undefined) ? await resolveBtcChainId(db)
                                             : (btcChainId || null);

    let args = [];
    for(let r of rows)
        args.push(r.snapshot_block, r.capability, r.signing_pubkey, r.amount, r.source, chainId);

    await db.doQuery(
        'INSERT IGNORE INTO ' + TABLE + ' ' + COLUMNS + ' VALUES ' +
        rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', '),
        args);

    return rows;
}

module.exports = { TABLE, COLUMNS, normalizeCapabilitySnapshotRows, resolveBtcChainId, writeCapabilitySnapshotRows };
