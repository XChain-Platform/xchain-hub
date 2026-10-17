'use strict';

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
