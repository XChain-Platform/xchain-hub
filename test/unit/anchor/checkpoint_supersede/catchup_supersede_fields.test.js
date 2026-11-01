'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const { storeVerifiedRow } = require('../../../../src/peers/hub_db/catchup_rows.js');

const BASE_ARGS = [
    'BTC', 'testnet', 80, 'block-hash', 'ledger-hash', 'actions-hash', 'contract-hash',
    12, 900, 'state-root', 1, 'merkle-root', 2, 'validator-signatures',
];

function checkpoint(overrides = {}) {
    return {
        id: 91,
        chain: BASE_ARGS[0],
        network: BASE_ARGS[1],
        block_index: BASE_ARGS[2],
        block_hash: BASE_ARGS[3],
        ledger_hash: BASE_ARGS[4],
        actions_hash: BASE_ARGS[5],
        contract_hash: BASE_ARGS[6],
        checkpoint_seq: BASE_ARGS[7],
        snapshot_block: BASE_ARGS[8],
        state_root: BASE_ARGS[9],
        state_root_version: BASE_ARGS[10],
        block_merkle_root: BASE_ARGS[11],
        block_merkle_version: BASE_ARGS[12],
        validator_signatures: BASE_ARGS[13],
        ...overrides,
    };
}

describe('checkpoint supersede catch-up persistence @regression', function () {
    it('stores both supersede fields from a caught-up checkpoint row', async function () {
        const db = { createStateCheckpoint: sinon.stub().resolves() };
        const supersedesFrom = 40;
        const rulesDigest = 'ab'.repeat(32);

        await storeVerifiedRow(db, 'state_checkpoints', checkpoint({
            supersedes_from: supersedesFrom,
            rules_digest: rulesDigest,
        }));

        expect(db.createStateCheckpoint.calledOnceWithExactly(
            ...BASE_ARGS, supersedesFrom, rulesDigest
        )).to.equal(true);
    });

    it('stores a plain caught-up checkpoint with the existing argument shape', async function () {
        const db = { createStateCheckpoint: sinon.stub().resolves() };

        await storeVerifiedRow(db, 'state_checkpoints', checkpoint());

        expect(db.createStateCheckpoint.calledOnceWithExactly(...BASE_ARGS)).to.equal(true);
    });
});
