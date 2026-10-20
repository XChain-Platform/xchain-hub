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
 * ANCHOR publisher - archive capability groups
 *
 * The one list of (block, capability) groups an archive must carry. The
 * builder resolves and emits these groups and the follower demands them, so
 * both read it from here and a kind cannot be added or moved on one side only.
 *
 ********************************************************************/

'use strict';

// List every capability group the archive's rows oblige, with each block as archived (unsorted, may repeat).
// A batch-proofed price round carries no signatures to check, so only signature-proofed rounds oblige one.
function archiveCapabilityWants(archive, wrapperSnapshotBlock, isSignatureProofedPrice){
    let wants = (archive.matches || []).map(m => ({ block: m.snapshot_block, capability: 'cross_chain' }))
        .concat((archive.calls || []).map(c => ({ block: c.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.bridge_transfers || []).map(b => ({ block: b.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.policy_snapshots || []).map(p => ({ block: p.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.list_snapshots || []).map(l => ({ block: l.snapshot_block, capability: 'cross_chain' })))
        .concat((archive.state_checkpoints || []).map(c => ({ block: c.snapshot_block, capability: 'oracle_publish' })))
        .concat((archive.price_snapshots || []).filter(p => isSignatureProofedPrice(p))
            .map(p => ({ block: p.reference_block, capability: 'price' })))
        // Verifiers (and recovery) check each rewarded pubkey was an eligible publisher at its earn block
        .concat((archive.rewards || []).map(r => ({ block: r.block_index, capability: 'oracle_publish' })));
    // The wrapper checkpoint's own signatures are re-verified against the oracle_publish set at its block
    if(wrapperSnapshotBlock != null)
        wants.push({ block: wrapperSnapshotBlock, capability: 'oracle_publish' });
    return wants;
}

module.exports = { archiveCapabilityWants };
