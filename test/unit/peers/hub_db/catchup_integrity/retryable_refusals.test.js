'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const ValidatorIdentity = require('../../../../../src/validators/identity.js');
const checkpointForms = require('../../../../../src/anchor/checkpoint_engine/canonical_forms.js');
const ar = require('../../../../../src/consensus/gates/anchor_reward_gate.js');
const remoteTokens = require('../../../../../src/cross_chain/remote_token_snapshots.js');
const registry = require('../../../../../src/peers/hub_db/catchup_verifiers.js');

function checkpointRow(snapshotBlock) {
    return {
        chain: 'BTC', network: 'mainnet', block_index: 91,
        block_hash: 'block', ledger_hash: 'ledger', actions_hash: 'actions',
        contract_hash: 'contract', checkpoint_seq: snapshotBlock,
        snapshot_block: snapshotBlock, state_root: null,
        state_root_version: null, block_merkle_root: null,
        block_merkle_version: null, validator_signatures: '[]'
    };
}

function rewardRow() {
    return {
        chain: 'DOGE', network: 'mainnet', reward_type: 'anchor_bundle',
        round_reference: 100, snapshot_block: 100,
        publisher: 'aa'.repeat(32), reward_amount: ar.ANCHOR_REWARD_AMOUNT,
        publisher_attestations: '[]'
    };
}

function remoteTokenRow() {
    const offer = { give_tick: 'REMOTE', give_decimals: 8,
        give_owner: 'owner-address', action_index: 7 };
    return Object.assign(remoteTokens.buildRemoteTokenSnapshot(
        'mainnet', 1, 'doge', offer), { finalizing_view: 3,
        status: 'finalized', validator_signatures: '[]' });
}

function verifierCases() {
    return [
        ['state_checkpoints', checkpointRow(100)],
        ['anchor_reward_attestations', rewardRow()],
        ['remote_token_snapshots', remoteTokenRow()],
        ['cross_chain_matches', {
            status: 'finalized', snapshot_block: 100,
            network: 'mainnet', validator_signatures: '[]'
        }]
    ];
}

function signingSet(count) {
    const identities = Array.from({ length: count }, () =>
        new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
    return {
        identities,
        validators: identities.map(identity => ({
            signing_pubkey: identity.getPubkeyHex(), amount: '1'
        }))
    };
}

describe('signed-row catch-up retryable refusals', function () {
    afterEach(function () { sinon.restore(); });

    it('marks validator lookup failures retryable with their cause', async function () {
        for (const [table, row] of verifierCases()) {
            const context = {
                db: { findCapabilitySnapshotsBySnapshotBlock:
                    sinon.stub().rejects(new Error('temporary read failure')) }
            };
            const verdict = await registry.getCatchupVerifier(table)(row, context);
            expect(verdict, table).to.deep.include({ ok: false, retry: true });
            expect(verdict.reason, table).to.include('temporary read failure');
        }
    });

    it('accepts the same checkpoint after a transient lookup recovers', async function () {
        const set = signingSet(4);
        const row = checkpointRow(100);
        const canonical = checkpointForms.canonicalCheckpoint(row);
        row.validator_signatures = JSON.stringify(set.identities.slice(0, 3).map(identity => ({
            pubkey: identity.getPubkeyHex(), sig: identity.sign(canonical)
        })));
        const lookup = sinon.stub();
        lookup.onFirstCall().rejects(new Error('database busy'));
        lookup.onSecondCall().resolves(set.validators);
        const context = { db: { findCapabilitySnapshotsBySnapshotBlock: lookup } };
        const first = await registry.getCatchupVerifier('state_checkpoints')(row, context);
        const second = await registry.getCatchupVerifier('state_checkpoints')(row, context);
        expect(first).to.deep.include({ ok: false, retry: true });
        expect(first.reason).to.include('database busy');
        expect(second).to.equal(true);
    });
});
