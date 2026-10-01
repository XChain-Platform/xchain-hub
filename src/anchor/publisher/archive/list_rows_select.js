/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

function listRows(rows){
    return Array.isArray(rows) ? rows : [];
}

module.exports = {

    capListRows(found, max){
        let rows = listRows(found);
        return { rows: rows.slice(0, max), capped: rows.length > max };
    },

    sortedListRows(rows){
        return listRows(rows).slice().sort((a, b) => {
            let x = String(a.snapshot_id), y = String(b.snapshot_id);
            return x < y ? -1 : x > y ? 1 : 0;
        });
    },

    listIdsOf(rows){
        return listRows(rows).map(row => ({ snapshot_id: String(row.snapshot_id) }));
    },

    listCapabilityWants(rows){
        return listRows(rows).map(row => ({
            block: Number(row.snapshot_block), capability: 'cross_chain'
        }));
    }

};
