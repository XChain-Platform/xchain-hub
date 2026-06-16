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

const { expect } = require('chai');

/**
 * Assert a finalized price snapshot exists for the given round and coin pair.
 */
async function assertPriceSnapshot(db, round, coinPair, expected) {
    let rows = await db.doQuery(
        "SELECT * FROM price_snapshots WHERE round_number = ? AND coin_pair = ? AND status = 'finalized'",
        [round, coinPair]
    );
    expect(rows.length, 'Expected finalized snapshot for round ' + round + ' ' + coinPair).to.be.greaterThan(0);
    let row = rows[0];
    if (expected) {
        if (expected.price) expect(row.price).to.equal(expected.price);
        if (expected.validatorCount) expect(row.validator_count).to.equal(expected.validatorCount);
    }
    return row;
}

/**
 * Assert a skipped price snapshot exists for the given round.
 */
async function assertSkippedRound(db, round) {
    let rows = await db.doQuery(
        "SELECT * FROM price_snapshots WHERE round_number = ? AND status = 'skipped'",
        [round]
    );
    expect(rows.length, 'Expected skipped snapshot for round ' + round).to.be.greaterThan(0);
    return rows;
}

/**
 * Assert an attestation exists with expected fields.
 */
async function assertAttestationStored(db, attestationId, expected) {
    let rows = await db.doQuery(
        "SELECT * FROM attestations WHERE attestation_id = ?",
        [attestationId]
    );
    expect(rows.length, 'Expected attestation ' + attestationId).to.equal(1);
    let row = rows[0];
    if (expected) {
        if (expected.status) expect(row.status).to.equal(expected.status);
        if (expected.validatorCount) expect(row.validator_count).to.equal(expected.validatorCount);
    }
    return row;
}

/**
 * Assert a swap record has the expected status.
 */
async function assertSwapStatus(db, sourceChain, sourceActionIndex, expectedStatus) {
    let rows = await db.doQuery(
        "SELECT * FROM swap_records WHERE source_chain = ? AND source_action_index = ?",
        [sourceChain, sourceActionIndex]
    );
    expect(rows.length, 'Expected swap ' + sourceChain + ':' + sourceActionIndex).to.equal(1);
    expect(rows[0].status).to.equal(expectedStatus);
    return rows[0];
}

/**
 * Assert rewards were distributed for a round.
 */
async function assertRewardDistributed(db, round, validatorCount) {
    let rows = await db.doQuery(
        "SELECT * FROM validator_rewards WHERE round_number = ?",
        [round]
    );
    expect(rows.length, 'Expected ' + validatorCount + ' reward entries for round ' + round).to.equal(validatorCount);
    return rows;
}

/**
 * Assert a slash proposal exists for a validator.
 */
async function assertSlashProposal(db, pubkey, offenseType) {
    let rows = await db.doQuery(
        "SELECT * FROM slash_proposals WHERE validator_pubkey = ? AND offense_type = ?",
        [pubkey, offenseType]
    );
    expect(rows.length, 'Expected slash proposal for ' + pubkey.substring(0, 16) + ' type=' + offenseType).to.be.greaterThan(0);
    return rows;
}

/**
 * Assert a reorg attestation is confirmed.
 */
async function assertReorgConfirmed(db, reorgId) {
    let rows = await db.doQuery(
        "SELECT * FROM reorg_attestations WHERE reorg_id = ? AND status = 'confirmed'",
        [reorgId]
    );
    expect(rows.length, 'Expected confirmed reorg ' + reorgId).to.equal(1);
    return rows[0];
}

module.exports = {
    assertPriceSnapshot,
    assertSkippedRound,
    assertAttestationStored,
    assertSwapStatus,
    assertRewardDistributed,
    assertSlashProposal,
    assertReorgConfirmed
};
