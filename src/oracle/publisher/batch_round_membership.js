/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const MAX_BATCH_ROUNDS = 256;

function batchBounds(batch) {
    let first = Number(batch && batch.first_round);
    let last = Number(batch && batch.last_round);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return null;
    return { first, last };
}

function fullBatchRounds(batch) {
    let bounds = batchBounds(batch);
    let count = Number(batch && batch.round_count);
    if (!bounds || !Number.isSafeInteger(count) || count < 1 || count > MAX_BATCH_ROUNDS ||
        count !== bounds.last - bounds.first + 1) return null;
    return new Set(Array.from({ length: bounds.last - bounds.first + 1 }, (_, i) => bounds.first + i));
}

function payloadRounds(batch, fetched) {
    let bounds = batchBounds(batch);
    if (!bounds || !fetched || !fetched.payload || !Array.isArray(fetched.payload.rounds)) return new Set();
    let rounds = new Set();
    for (let entry of fetched.payload.rounds) {
        let round = Number(entry && entry.round);
        if (Number.isSafeInteger(round) && round >= bounds.first && round <= bounds.last) rounds.add(round);
    }
    return rounds;
}

async function resolveBatchRounds(batch, fetchPayload) {
    let full = fullBatchRounds(batch);
    if (full) return full;
    let action = Number(batch && batch.action_index);
    if (!Number.isSafeInteger(action) || typeof fetchPayload !== 'function') return new Set();
    return payloadRounds(batch, await fetchPayload(action));
}

module.exports = { resolveBatchRounds };
