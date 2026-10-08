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
 ********************************************************************/

'use strict';

const registry = require('../../consensus/gate_registry.js');

const BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION = 'cross_chain/bridge/proof_ready_snapshot.BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION';

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

module.exports = { BRIDGE_PROOF_READY_SNAPSHOT_ACTIVATION, proofReadyActive, proofReadySnapshot };
