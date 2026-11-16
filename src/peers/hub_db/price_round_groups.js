'use strict';

const { samePriceKey } = require('../../anchor/publisher/archive/unheld_row.js');

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grouping helpers for price snapshot rows: one signed round is the rows that
// share a round number and consensus proof, and a page that ends mid-round
// must not release that round until the rows after it have arrived.

// The row fields a signed round fixes: every row of one round must agree on all of them.
const ROUND_AGREEMENT_KEYS = Object.freeze(['round_number', 'reference_block', 'block_timestamp',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'consensus_proof']);

function sameValue(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return a == null && b == null;
    return String(a) === String(b);
}

// A producer round is one finalized, unsourced BTC-anchored round whose pair rows share a signature set.
// The producer insert names no source_chain, so a stored row carries the column default ('DOGE')
// beside reference_chain 'BTC', never NULL. Every pushed or batch writer stores source_chain equal
// to reference_chain and names a source action, so those two tests keep the forms apart.
function isProducerRoundRow(row) {
    return Boolean(row) && typeof row === 'object' && row.status === 'finalized' &&
        row.reference_chain === 'BTC' && row.source_chain !== row.reference_chain &&
        (row.source_action_index === null || row.source_action_index === undefined) &&
        (row.push_generation === null || row.push_generation === undefined || Number(row.push_generation) === 0) &&
        typeof row.consensus_proof === 'string' && row.consensus_proof.startsWith('[');
}

function groupKey(row) {
    if (!isProducerRoundRow(row)) return null;
    return JSON.stringify([Number(row.round_number), row.consensus_proof]);
}

// True when every member is a producer row of one signed round: the same signed fields, the same
// validator_count (one insert wrote them all) and no coin pair twice.
function groupAgrees(first, group) {
    const pairs = new Set();
    for (const member of group) {
        if (!isProducerRoundRow(member) || pairs.has(member.coin_pair)) return false;
        pairs.add(member.coin_pair);
        if (!ROUND_AGREEMENT_KEYS.every(key => sameValue(first[key], member[key])) ||
            !sameValue(first.validator_count, member.validator_count)) return false;
    }
    return true;
}

function indexGroups(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = groupKey(row);
        if (key === null) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}

// Holding the group that ends a full page avoids the common boundary split. It is only a shortcut:
// upgraded placeholders retain earlier ids, so the walk-wide refusal pool joins fragments this window
// cannot hold together.
function holdTrailingGroup(rows, pageIsFull) {
    const key = rows.length > 0 ? groupKey(rows[rows.length - 1]) : null;
    if (!pageIsFull || key === null) return { ready: rows, held: [] };
    return { ready: rows.filter(row => groupKey(row) !== key), held: rows.filter(row => groupKey(row) === key) };
}

function advanceCursor(start, rows) {
    let cursor = start;
    for (const row of rows) {
        const wireId = Number(row && row.id);
        if (!Number.isSafeInteger(wireId) || wireId <= cursor) {
            throw new Error('Snapshot row has a non-advancing wire id');
        }
        cursor = wireId;
    }
    return cursor;
}

function admissionBlocks(row) {
    return { admit_block_btc: row.admit_block_btc, admit_block_ltc: row.admit_block_ltc,
        admit_block_doge: row.admit_block_doge };
}

function priceSnapshotAlreadyHeld(rows, row) {
    const held = Array.isArray(rows) && rows.find(candidate =>
        candidate && samePriceKey(candidate, row));
    return Boolean(held) && !(held.status === 'skipped' && row.status === 'finalized');
}

function storePriceSnapshot(db, row) {
    const pairs = [{ pair: row.coin_pair, coinPair: row.coin_pair, price: row.price }];
    if (row.status === 'skipped' || row.status === 'disputed') {
        throw new Error('Only finalized price snapshots are mirrored by catch-up');
    }
    // A missed producer round is stored as its producer stored it. The landing clock is not
    // signed, so it stays 0 here and this hub's own batch ingest stamps it.
    if (isProducerRoundRow(row)) {
        return db.setFinalizedPriceSnapshotRound(row.round_number, [{ coinPair: row.coin_pair, price: row.price }],
            row.reference_block, row.block_timestamp, row.validator_count, row.consensus_proof, admissionBlocks(row));
    }
    const common = [row.round_number, pairs, row.reference_block, row.reference_chain, row.block_timestamp,
        row.validator_count, row.consensus_proof, row.source_action_index, row.push_generation, row.created_at];
    if (row.batch_block_time !== null && row.batch_block_time !== undefined) {
        common.splice(9, 0, row.batch_block_time);
        return db.setBatchPriceSnapshotRound(...common, admissionBlocks(row));
    }
    if (row.source_chain !== null && row.source_chain !== undefined) {
        return db.setPushedPriceSnapshotRound(...common, admissionBlocks(row));
    }
    return db.setFinalizedPriceSnapshotRound(row.round_number,
        [{ coinPair: row.coin_pair, price: row.price }], row.reference_block,
        row.block_timestamp, row.validator_count, row.consensus_proof, admissionBlocks(row));
}

module.exports = {
    ROUND_AGREEMENT_KEYS, sameValue, groupAgrees,
    advanceCursor, storePriceSnapshot, priceSnapshotAlreadyHeld,
    isProducerRoundRow, groupKey, indexGroups, holdTrailingGroup
};
