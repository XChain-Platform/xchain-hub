'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function capabilityProofReply(snapshotBlock, capability, checkpointRow, rpc) {
    if (checkpointRow === null || checkpointRow === undefined) {
        return { status: 404, body: { error: 'SNAPSHOT_NOT_YET_CHECKPOINTED' } };
    }

    const proof = rpc && rpc.answer;
    if (!rpc || rpc.error != null || proof === null || typeof proof !== 'object' || proof.error != null) {
        return { status: 503, body: { error: 'PROOF_UNAVAILABLE' } };
    }

    return {
        status: 200,
        body: {
            snapshot_block: snapshotBlock,
            capability,
            checkpoint: {
                chain: checkpointRow.chain,
                network: checkpointRow.network,
                block_index: Number(checkpointRow.block_index),
                block_hash: checkpointRow.block_hash,
                state_root: checkpointRow.state_root,
                state_root_version: Number(checkpointRow.state_root_version),
                validator_signatures: checkpointRow.validator_signatures
            },
            proof
        }
    };
}

module.exports = { capabilityProofReply };
