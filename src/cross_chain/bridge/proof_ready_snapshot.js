/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *
 * XChain Hub - Bridge Proof-Ready Snapshot
 *
 * The destination indexer proves a BTC escrow at the first checkpoint at or after a
 * transfer's snapshot_block. Stamping the block of a checkpoint this hub already holds lets
 * it find that checkpoint immediately, so the destination block loop never waits on the next
 * cadence boundary.
 *
 * A DOGE or LTC escrow is proven on the BTC anchor axis instead: from the indexer's
 * BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION it selects the first origin checkpoint whose own
 * snapshot_block is STRICTLY above the row's. A row stamped with the hub's BTC tip has no
 * such checkpoint until the next round, so the destination block stalls for up to a cadence
 * (about an hour). From BRIDGE_ANCHOR_PROOF_READY_ACTIVATION such a lock is stamped one
 * below the snapshot_block of a finalized origin checkpoint that already commits it, so that
 * checkpoint, and only it, is the indexer's pick; the leg is held here until one exists.
 *
 ********************************************************************/

'use strict';

const registry = require('../../consensus/gate_registry.js');

const BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION = 'cross_chain/bridge/proof_ready_snapshot.BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION';
const BRIDGE_ANCHOR_PROOF_READY_ACTIVATION = 'cross_chain/bridge/proof_ready_snapshot.BRIDGE_ANCHOR_PROOF_READY_ACTIVATION';

// The origins whose escrow checkpoint the destination matches on the BTC anchor axis.
const ANCHOR_AXIS_CHAINS = Object.freeze(['DOGE', 'LTC']);

// Whether a source leg of `srcChain` mined at `legBlock` is stamped on a covering checkpoint.
// Only a BTC leg is: its block is a BTC height, the axis snapshot_block lives on.
function proofReadyActive(network, srcChain, legBlock){
    if(String(srcChain) !== 'BTC') return false;
    return registry.activeAt(BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION, network, 'BTC', Number(legBlock), null);
}

// The block of the first finalized BTC checkpoint at or above the leg's own block, or null
// while none exists. The checkpoint at the leg's block already commits the lock's credit.
async function proofReadySnapshot(db, network, legBlock){
    let rows = await db.getFirstStateCheckpointAtOrAbove('BTC', network, Number(legBlock));
    if(!Array.isArray(rows) || rows.length === 0) return null;
    let block = Number(rows[0].block_index);
    return Number.isFinite(block) ? block : null;
}

// Whether the destination proves this leg's escrow at all, by the indexer's own derivation
// from signed fields: only a lock of a bare token native to the source chain mints there.
// XCHAIN keeps its BTC origin and a rooted tick is a burn, so neither is proven on DOGE or LTC.
function escrowProvenLeg(tick){
    let name = String(tick || '');
    return name !== '' && name.toUpperCase() !== 'XCHAIN' && !name.includes('.');
}

/**
 * Whether a DOGE- or LTC-sourced leg is stamped against an origin checkpoint on the BTC
 * anchor axis. Read at the leg's own chain and block, the pair the follower re-reads from
 * its own indexer, so proposer and follower flip on the same leg.
 *
 * @param {string} network - the hub's network
 * @param {string} srcChain - the chain the leg was mined on
 * @param {string} tick - the row's tick, as signed
 * @param {number} legBlock - the leg's block_index on srcChain
 * @returns {boolean}
 */
function anchorProofReadyActive(network, srcChain, tick, legBlock){
    if(!ANCHOR_AXIS_CHAINS.includes(String(srcChain))) return false;
    if(!escrowProvenLeg(tick)) return false;
    return registry.activeAt(BRIDGE_ANCHOR_PROOF_READY_ACTIVATION, network, String(srcChain), Number(legBlock), null);
}

/**
 * The snapshot_block a DOGE- or LTC-sourced lock is stamped with, or null while no finalized
 * origin checkpoint commits it. The covering checkpoint is the lowest one at or above the leg
 * on its own chain, the latest sequence at that height winning as the table's reorg rule
 * does; the stamp is its snapshot_block less one.
 *
 * Why less one: the indexer takes the first checkpoint whose snapshot_block is STRICTLY above
 * the stamp, and checkpoint_seq equals snapshot_block under a unique key, so exactly one
 * checkpoint sits at that height. Stamping the checkpoint's own snapshot_block would skip it.
 *
 * @param {Object} db - the hub Database
 * @param {string} network - the hub's network
 * @param {string} srcChain - DOGE or LTC
 * @param {number} legBlock - the leg's block_index on srcChain
 * @returns {Promise<number|null>}
 */
async function anchorProofReadySnapshot(db, network, srcChain, legBlock){
    let rows = await db.getFirstStateCheckpointAtOrAbove(String(srcChain), network, Number(legBlock));
    if(!Array.isArray(rows) || rows.length === 0) return null;
    let anchor = Number(rows[0].snapshot_block);
    if(!Number.isSafeInteger(anchor) || anchor < 1) return null;
    return anchor - 1;
}

module.exports = {
    BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION, BRIDGE_ANCHOR_PROOF_READY_ACTIVATION,
    proofReadyActive, proofReadySnapshot, anchorProofReadyActive, anchorProofReadySnapshot
};
