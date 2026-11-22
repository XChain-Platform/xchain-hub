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

// The column list the real price presence read selects, captured from its SQL, so an
// in-memory stub of findPriceSnapshotRowsForRounds hands callers the same narrow row
// shape production does instead of whole rows that hide a missing column.

const chainRestoreDb = require('../../../src/db/prices/chain_restore');

async function presenceColumns() {
    let sql = null;
    await chainRestoreDb.findPriceSnapshotRowsForRounds.call({
        doQuery: async (statement) => { sql = statement; return []; }
    }, [1]);
    const match = /^SELECT\s+([\s\S]+?)\s+FROM\s/i.exec(sql || '');
    if (!match || /\*/.test(match[1])) throw new Error('presence read has no explicit column list: ' + sql);
    return match[1].split(',').map(column => column.trim());
}

function projectRow(row, columns) {
    const out = {};
    for (const column of columns) if (Object.prototype.hasOwnProperty.call(row, column)) out[column] = row[column];
    return out;
}

async function projectPresenceRows(rows) {
    const columns = await presenceColumns();
    return rows.map(row => projectRow(row, columns));
}

module.exports = { presenceColumns, projectRow, projectPresenceRows };
