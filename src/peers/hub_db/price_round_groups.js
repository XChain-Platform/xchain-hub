'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// A producer round is one finalized, unsourced BTC-anchored round whose pair rows share a signature set.
function isProducerRoundRow(row) {
    return Boolean(row) && typeof row === 'object' && row.status === 'finalized' &&
        (row.source_chain === null || row.source_chain === undefined) &&
        row.reference_chain === 'BTC' && typeof row.consensus_proof === 'string' &&
        row.consensus_proof.startsWith('[');
}

function groupKey(row) {
    if (!isProducerRoundRow(row)) return null;
    return JSON.stringify([Number(row.round_number), row.consensus_proof]);
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

// Splits off the group that ends a full page, since its remaining pair rows may start the next page.
function holdTrailingGroup(rows, pageIsFull) {
    const key = rows.length > 0 ? groupKey(rows[rows.length - 1]) : null;
    if (!pageIsFull || key === null) return { ready: rows, held: [] };
    let start = rows.length;
    while (start > 0 && groupKey(rows[start - 1]) === key) start -= 1;
    return { ready: rows.slice(0, start), held: rows.slice(start) };
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

function storePriceSnapshot(db, row) {
    const pairs = [{ pair: row.coin_pair, coinPair: row.coin_pair, price: row.price }];
    if (row.status === 'skipped') {
        return db.setSkippedPriceSnapshotRound(
            row.round_number, [row.coin_pair], row.reference_block, row.block_timestamp);
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

module.exports = { advanceCursor, storePriceSnapshot, isProducerRoundRow, groupKey, indexGroups, holdTrailingGroup };
