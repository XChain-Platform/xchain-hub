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
 * State checkpoint engine - canonical forms
 *
 * The checkpoint signing string and the pure predicates over a checkpoint record.
 * StateCheckpointEngine carries them as its statics, and the part modules call them
 * here, so no part has to require the class file back.
 *
 ********************************************************************/

'use strict';

const eq   = require('../../equivocation_header.js');
const ckpt = require('../../checkpoint_commitment_activation.js');

const forms = {

    // RAW (ungated) v0 checkpoint canonical: the bare pipe-join. The v1 archive
    // (StateAnchorPublisher.archiveCanonical) nests THIS, not the gated form, so the
    // EQUIV header is applied exactly once around the whole archive content.
    rawCanonicalCheckpoint(cp){
        // The bare v0 checkpoint canonical, WITHOUT the SPV roots: the v1 archive
        // (archiveCanonical) nests THIS and must stay byte-identical to its pre-SPV
        // shape, so the root-append lives in canonicalCheckpoint (checkpoint family
        // only), never here.
        return ['XCHECKPOINT', cp.chain, cp.network, String(cp.block_index), cp.block_hash,
                cp.ledger_hash, cp.actions_hash, cp.contract_hash,
                String(cp.checkpoint_seq), String(cp.snapshot_block)].join('|');
    },

    // The SPV Phase 2 (spec §6.1) root suffix appended to the checkpoint-family
    // canonical at/above the CHECKPOINT_COMMITMENT flag-day. Kept as one helper so
    // the hub / SDK / indexer-anchor / explorer all build byte-identical bytes.
    checkpointRootSuffix(cp){
        if(!ckpt.isCheckpointCommitmentActive(cp.snapshot_block, cp.network)) return '';
        // Append only when the roots are actually present. Post-flag-day the engine
        // refuses to sign a checkpoint that lacks them (runRound throws), so for every
        // REAL post-flag-day checkpoint this is always true and the suffix is byte-
        // deterministic; the guard only keeps legacy/pre-Phase-1 rows (null roots) on
        // their original rootless canonical, so old signatures still verify.
        if(cp.state_root == null || cp.block_merkle_root == null ||
           cp.state_root_version == null || cp.block_merkle_version == null) return '';
        return '|' + [String(cp.state_root).toLowerCase(), String(cp.state_root_version),
                      String(cp.block_merkle_root).toLowerCase(), String(cp.block_merkle_version)].join('|');
    },

    // Byte-identical to the indexer ANCHOR verifier + SDK CheckpointVerifier. At/above
    // the EQUIV flag-day (gated on the BTC snapshot_block + network) the v0 canonical is
    // wrapped in the uniform signed header (TAG=XCHECKPOINT, ROUND_ID=v0 round id,
    // VIEW=0: checkpoints have no view change); below it, the bare raw bytes (regression-safe).
    canonicalCheckpoint(cp){
        // Checkpoint family (v0/v3): the bare canonical PLUS the SPV root suffix
        // (post-flag-day), appended to the RAW string BEFORE the EQUIV wrap. The v1
        // archive uses archiveCanonical (rootless) instead, so archives are untouched.
        let raw = forms.rawCanonicalCheckpoint(cp) + forms.checkpointRootSuffix(cp);
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq, 0, raw);
        return raw;
    },

    // The checkpoint_seq is derived purely from the round's BTC snapshot_block.
    // snapshot_block is the single consensus field every hub already agrees on, and
    // cadence leader election (rank == btcBlock % N over each hub's OWN BTC tip) makes
    // at most one honest leader per BTC block; so tying seq to snapshot_block guarantees
    // two honest leaders cannot mint divergent payloads under one seq (a shared seq
    // implies a shared snapshot_block implies a shared tip implies one payload). It is
    // monotonic across cadences (snapshot_block only advances by intervalBlocks), so the
    // readers' MAX(checkpoint_seq) supersession and the co-sign replay guard still hold,
    // and it strictly exceeds any legacy COALESCE(MAX)+1 dense seq (a count of prior
    // checkpoints <= snapshot_block/interval), so a mid-upgrade hub never stalls.
    // Every hub (leader, follower, finalizer) computes the identical value with no DB read.
    deriveCheckpointSeq(snapshotBlock){
        return Number(snapshotBlock);
    },

    // True when checkpoint-commitment is active for this checkpoint's
    // snapshot_block/network but the light-client roots are missing.
    //
    // The propose path always refused to SIGN such a checkpoint, but that was the only
    // place the rule lived, and it is the one path an attacker does not control. The
    // canonical hides the gap: _rootSuffix() contributes the EMPTY STRING when the
    // roots are null, so a rootless proposal and a rootless self-derivation produce
    // BYTE-IDENTICAL canonicals. A follower's "does the proposer's canonical match
    // mine?" check therefore passes, and it co-signs a post-flag-day checkpoint
    // carrying no roots at all. Quorum then forms and every hub persists it, so the
    // light-client commitment the flag-day exists to guarantee is silently absent from
    // the checkpoint chain, and an SPV client has nothing to verify against.
    //
    // One predicate, three call sites (propose, co-sign, persist), so the rule cannot
    // be enforced on one path and quietly skipped on the others again.
    isRootless(cp){
        if(!cp) return false;
        if(!ckpt.isCheckpointCommitmentActive(cp.snapshot_block, cp.network)) return false;
        return (!cp.state_root || !cp.block_merkle_root ||
                cp.state_root_version == null || cp.block_merkle_version == null);
    },

    // Does a seated row name a DIFFERENT payload than `cp`? Identity is block_index plus
    // the four chained hashes, which every checkpoint version carries; the light-client
    // roots are derived from that same block and are deliberately left out, so a NULL/''
    // normalization difference can never read a re-delivery as an equivocation. Hashes
    // compare case-insensitively (the driver's serialization need not match ours).
    checkpointRowDiffers(row, cp){
        // Not comparable is not a conflict. Every identity column is NOT NULL in
        // state_checkpoints, so a row missing one did not come from the table and reading
        // its absence as an equivocation would refuse a legitimate checkpoint.
        if(!row || row.block_index == null || row.block_hash == null) return false;
        let hx = (a, b) => String(a == null ? '' : a).toLowerCase() !== String(b == null ? '' : b).toLowerCase();
        return Number(row.block_index) !== Number(cp.block_index) ||
               hx(row.block_hash,    cp.block_hash)    ||
               hx(row.ledger_hash,   cp.ledger_hash)   ||
               hx(row.actions_hash,  cp.actions_hash)  ||
               hx(row.contract_hash, cp.contract_hash);
    }

};

module.exports = forms;
