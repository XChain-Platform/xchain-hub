'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const checkpointMethods = require('../../../../../src/anchor/checkpoint_engine/sign.js');
const { verifyStateCheckpointCatchupRow } =
    require('../../../../../src/anchor/checkpoint_engine/catchup_verifier.js');

function checkpoint(overrides){
    const snapshotBlock = 1000000;
    return Object.assign({
        chain: 'BTC', network: 'mainnet', block_index: 91,
        block_hash: '11'.repeat(32), ledger_hash: '22'.repeat(32),
        actions_hash: '33'.repeat(32), contract_hash: '44'.repeat(32),
        checkpoint_seq: snapshotBlock, snapshot_block: snapshotBlock,
        state_root: '55'.repeat(32), state_root_version: 1,
        block_merkle_root: '66'.repeat(32), block_merkle_version: 1,
        validator_signatures: '[]'
    }, overrides);
}

function validators(count){
    return Array.from({ length: count }, () => {
        const identity = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
        return { signing_pubkey: identity.getPubkeyHex(), amount: '1' };
    });
}

async function reasonFor(row, context){
    const verdict = await verifyStateCheckpointCatchupRow(row, context);
    expect(verdict).to.deep.include({ ok: false });
    return verdict.reason;
}

describe('state checkpoint catch-up refusal reasons', function () {
    it('names malformed shape, signatures, sequence, and root refusals', async function () {
        expect(await reasonFor(null)).to.equal('malformed state checkpoint row');
        expect(await reasonFor(checkpoint({ validator_signatures: '{' })))
            .to.equal('malformed state checkpoint signatures');
        expect(await reasonFor(checkpoint({ checkpoint_seq: 999999 })))
            .to.equal('checkpoint sequence does not match snapshot block');
        expect(await reasonFor(checkpoint({ state_root: null, block_merkle_root: null })))
            .to.equal('checkpoint has no required light-client roots');
    });

    it('names network drift and a valid proof below quorum', async function () {
        const engine = {
            network: 'mainnet',
            normalizeCheckpoint: checkpointMethods.normalizeCheckpoint,
            assertCheckpointNetwork: checkpointMethods.assertCheckpointNetwork,
            resolveCapabilityValidators: async () => validators(4),
        };
        expect(await reasonFor(checkpoint({ network: 'testnet' }), { stateCheckpoints: engine }))
            .to.include('checkpoint network mismatch in catch-up');
        expect(await reasonFor(checkpoint(), { stateCheckpoints: engine }))
            .to.equal('checkpoint signatures do not meet quorum');
    });
});
