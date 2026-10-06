'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Grouping helpers for price snapshot rows: one signed round is the rows that
// share a round number and consensus proof, and a page that ends mid-round
// must not release that round until the rows after it have arrived.

const SIGNED_FIELDS = ['round_number', 'reference_block', 'block_timestamp',
    'admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'consensus_proof'];

function priceRoundKey(row) {
    return JSON.stringify([Number(row.round_number), row.consensus_proof]);
}

function groupByRound(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = priceRoundKey(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}

// With a full page the last row may be the first of a longer round, so its
// group is held; a short page is the end of the table and releases everything.
function splitRoundGroups(carried, pageRows, pageFull) {
    const page = pageRows || [];
    const groups = groupByRound([...(carried || []), ...page]);
    if (!pageFull || page.length === 0) {
        return { ready: [...groups.values()], held: [] };
    }
    const heldKey = priceRoundKey(page[page.length - 1]);
    const ready = [];
    let held = [];
    for (const [key, rows] of groups) {
        if (key === heldKey) held = rows;
        else ready.push(rows);
    }
    return { ready, held };
}

function signedValue(value) {
    return value === null || value === undefined ? '' : 'v' + String(value);
}

function sameSignedRoundFields(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const first = rows[0];
    return rows.every(row =>
        SIGNED_FIELDS.every(key => signedValue(first[key]) === signedValue(row[key])));
}

module.exports = { priceRoundKey, splitRoundGroups, sameSignedRoundFields };
