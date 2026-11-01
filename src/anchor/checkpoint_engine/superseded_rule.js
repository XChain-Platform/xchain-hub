'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// In-memory reader rules for append-only checkpoint supersession.

function isSupersedingRow(row) {
    return row.supersedes_from != null;
}

function supersededBySeq(row, rows) {
    let rowSeq = Number(row.checkpoint_seq);
    let blockIndex = Number(row.block_index);
    let lowest = null;

    for (let candidate of rows) {
        let candidateSeq = Number(candidate.checkpoint_seq);
        let supersedesFrom = Number(candidate.supersedes_from);
        if(candidate.chain !== row.chain || candidate.network !== row.network) continue;
        if(!isSupersedingRow(candidate) || !(candidateSeq > rowSeq)) continue;
        if(!(supersedesFrom <= blockIndex)) continue;
        if(lowest == null || candidateSeq < lowest) lowest = candidateSeq;
    }

    return lowest;
}

function markSuperseded(rows) {
    return rows.map((row) => ({
        ...row,
        superseded_by_seq: supersededBySeq(row, rows),
    }));
}

module.exports = { supersededBySeq, markSuperseded, isSupersedingRow };
