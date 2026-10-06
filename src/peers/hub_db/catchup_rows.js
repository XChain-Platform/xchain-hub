'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// How catch-up asks whether the hub already holds a peer row, and how it stores one it verified.

const { storePriceSnapshot } = require('./price_round_groups.js');

function withoutWireId(row) {
    return Object.fromEntries(Object.entries(row || {}).filter(([column]) => column !== 'id'));
}

async function hasRows(promise) {
    const rows = await promise;
    return Array.isArray(rows) ? rows.length > 0 : Boolean(rows);
}

const CONTENT_KEY_READERS = Object.freeze({
    price_snapshots: async (db, row) => {
        const rows = await db.findPriceSnapshotsForRound(row.round_number);
        return Array.isArray(rows) && rows.some(held => held && held.coin_pair === row.coin_pair);
    },
    oracle_prices: (db, r) => hasRows(db.getOraclePrice(r.source_address, r.source_chain, r.action_index)),
    cross_chain_matches: (db, r) => hasRows(db.getCrossChainMatchByMatchId(r.match_id)),
    capability_snapshots: (db, r) => hasRows(db.getCapabilitySnapshot(
        r.snapshot_block, r.capability, r.signing_pubkey, r.source)),
    cross_chain_calls: (db, r) => hasRows(db.getCrossChainCallByCallIdAndPhase(r.call_id, r.phase)),
    state_checkpoints: (db, r) => hasRows(db.getStateCheckpointByChainAndNetworkAndCheckpointSeq(
        r.chain, r.network, r.checkpoint_seq)),
    anchor_reward_attestations: (db, r) => hasRows(db.getAnchorRewardAttestation(
        r.chain, r.network, r.reward_type, r.round_reference, r.snapshot_block, r.publisher)),
    attestation_responses: (db, r) => hasRows(db.getAttestationResponse(r.network, r.request_id, r.effective_time)),
    bridge_transfers: (db, r) => hasRows(db.getBridgeTransferByTransferId(r.transfer_id)),
    policy_snapshots: (db, r) => hasRows(db.getPolicySnapshotAtSeq(r.network, r.origin_chain, r.tick, r.policy_seq)),
    list_snapshots: (db, r) => hasRows(db.getListSnapshotAtSeq(r.network, r.home_chain, r.home_list_index, r.seq))
});

async function rowAlreadyHeld(db, table, row) {
    const reader = CONTENT_KEY_READERS[table];
    if (!reader) throw new Error('No hub DB catch-up content reader for table: ' + table);
    return reader(db, row);
}

const ROW_WRITERS = Object.freeze({
    price_snapshots: storePriceSnapshot,
    oracle_prices: (db, row) => db.setOraclePriceByGeneration(row),
    cross_chain_matches: (db, row) => db.createCrossChainMatch(row, row.btc_chain_id),
    capability_snapshots: (db, row) => db.createCapabilitySnapshots([row], row.btc_chain_id),
    cross_chain_calls: (db, row) => db.setCrossChainCallFinalized(row, row.btc_chain_id),
    state_checkpoints: (db, r) => db.createStateCheckpoint(r.chain, r.network, r.block_index, r.block_hash,
        r.ledger_hash, r.actions_hash, r.contract_hash, r.checkpoint_seq, r.snapshot_block, r.state_root,
        r.state_root_version, r.block_merkle_root, r.block_merkle_version, r.validator_signatures),
    anchor_reward_attestations: (db, r) => db.createAnchorRewardAttestation(r.chain, r.network,
        r.reward_type, r.round_reference, r.snapshot_block, r.publisher, r.reward_amount,
        r.publisher_attestations, r.doge_anchor_txid),
    attestation_responses: (db, row) => db.createAttestationResponseMirrorRow(row),
    bridge_transfers: (db, row) => db.insertBridgeTransfer(row),
    policy_snapshots: (db, row) => db.insertPolicySnapshot(row),
    list_snapshots: (db, row) => db.insertListSnapshot(row)
});

function storeVerifiedRow(db, table, row) {
    const writer = ROW_WRITERS[table];
    if (!writer) throw new Error('No hub DB catch-up writer for table: ' + table);
    return writer(db, withoutWireId(row));
}

module.exports = { withoutWireId, rowAlreadyHeld, storeVerifiedRow };
