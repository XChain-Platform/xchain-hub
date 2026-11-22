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
//
// Answers the post-insert round re-read (findPriceSnapshotsForRound) of a doQuery
// double from the price_snapshots INSERTs that double has recorded, the way the
// table would: each row carries the columns its statement names, literal tuple
// values included, and the read returns one round ordered by coin_pair.

const INSERT_RE = /^INSERT INTO price_snapshots\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/;

function literalValue(token) {
    if (token === 'NULL') return null;
    if (/^'.*'$/.test(token)) return token.slice(1, -1);
    return Number(token);
}

// One multi-row INSERT back into its rows, pairing the declared columns with
// the first VALUES tuple: each ? takes the next bound param, a literal is parsed.
function decodePriceInsert(sql, params) {
    const match = INSERT_RE.exec(String(sql).trim());
    if (!match) return [];
    const columns = match[1].split(',').map(s => s.trim());
    const tuple = match[2].split(',').map(s => s.trim());
    const perRow = tuple.filter(t => t === '?').length;
    const rows = [];
    for (let offset = 0; perRow > 0 && offset < params.length; offset += perRow) {
        let next = offset;
        const row = {};
        columns.forEach((column, i) => {
            row[column] = tuple[i] === '?' ? params[next++] : literalValue(tuple[i]);
        });
        rows.push(row);
    }
    return rows;
}

// Every row the recorded INSERTs stored, later statements replacing earlier ones
// on the (round_number, coin_pair) key.
function insertedRows(doQuery) {
    const table = new Map();
    for (const call of doQuery.getCalls()) {
        for (const row of decodePriceInsert(call.args[0], call.args[1] || []))
            table.set(row.round_number + '|' + row.coin_pair, row);
    }
    return [...table.values()];
}

function answerRoundRereadFromInserts(db) {
    db.findPriceSnapshotsForRound = async round => insertedRows(db.doQuery)
        .filter(row => Number(row.round_number) === Number(round))
        .sort((a, b) => String(a.coin_pair).localeCompare(String(b.coin_pair)))
        .map(row => Object.assign({}, row));
}

module.exports = { decodePriceInsert, answerRoundRereadFromInserts };
