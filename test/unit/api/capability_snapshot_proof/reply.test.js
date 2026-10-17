'use strict';

const { expect } = require('chai');
const {
    capabilityProofReply
} = require('../../../../src/api/rest/capability_snapshot_proof/reply.js');

const SNAPSHOT_BLOCK = 106;
const CAPABILITY = 'oracle_publish';
const CHECKPOINT = {
    id: 9,
    chain: 'BTC',
    network: 'testnet',
    block_index: '100',
    block_hash: 'a'.repeat(64),
    state_root: 'b'.repeat(64),
    state_root_version: '2',
    validator_signatures: 'signature-text',
    created_at: '2026-10-17 00:00:00'
};
const NOT_CHECKPOINTED = {
    status: 404,
    body: { error: 'SNAPSHOT_NOT_YET_CHECKPOINTED' }
};
const PROOF_UNAVAILABLE = {
    status: 503,
    body: { error: 'PROOF_UNAVAILABLE' }
};

function reply(checkpointRow, rpc) {
    return capabilityProofReply(SNAPSHOT_BLOCK, CAPABILITY, checkpointRow, rpc);
}

describe('capabilityProofReply', function () {
    for (const checkpointRow of [null, undefined]) {
        const kind = checkpointRow === null ? 'null' : 'undefined';
        it('reports checkpoint absence for ' + kind + ' before inspecting an RPC failure', function () {
            expect(reply(checkpointRow, { error: new Error('RPC unavailable') }))
                .to.deep.equal(NOT_CHECKPOINTED);
        });
    }

    it('reports a missing RPC outcome', function () {
        expect(reply(CHECKPOINT)).to.deep.equal(PROOF_UNAVAILABLE);
        expect(reply(CHECKPOINT, null)).to.deep.equal(PROOF_UNAVAILABLE);
    });

    it('reports a thrown RPC call captured as an error', function () {
        expect(reply(CHECKPOINT, { error: new Error('RPC unavailable') }))
            .to.deep.equal(PROOF_UNAVAILABLE);
    });

    for (const answer of [null, undefined, 'proof', 1, true]) {
        it('reports a non-object proof answer ' + String(answer), function () {
            expect(reply(CHECKPOINT, { answer })).to.deep.equal(PROOF_UNAVAILABLE);
        });
    }

    it('reports an error carried by a proof answer', function () {
        expect(reply(CHECKPOINT, { answer: { error: 'NO_BLOCK' } }))
            .to.deep.equal(PROOF_UNAVAILABLE);
    });

    it('returns the proof and only the public checkpoint fields', function () {
        const proof = {
            block_index: 100,
            sub_roots: { stakes_root: 'c'.repeat(64) },
            members: []
        };
        const result = reply(CHECKPOINT, { answer: proof });

        expect(result).to.deep.equal({
            status: 200,
            body: {
                snapshot_block: SNAPSHOT_BLOCK,
                capability: CAPABILITY,
                checkpoint: {
                    chain: 'BTC',
                    network: 'testnet',
                    block_index: 100,
                    block_hash: 'a'.repeat(64),
                    state_root: 'b'.repeat(64),
                    state_root_version: 2,
                    validator_signatures: 'signature-text'
                },
                proof
            }
        });
        expect(result.body.proof).to.equal(proof);
        expect(result.body.checkpoint).not.to.have.keys('id', 'created_at');
    });

    it('accepts an answer whose error is explicitly null', function () {
        const proof = { error: null, members: [] };
        expect(reply(CHECKPOINT, { error: null, answer: proof }).body.proof).to.equal(proof);
    });
});
