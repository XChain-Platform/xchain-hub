/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ANCHOR publisher - archived shared-list snapshot rows
 *
 ********************************************************************/

'use strict';

const { LIST_SNAPSHOT_KEYS } = require('../../constants.js');

const INTEGER_KEYS = new Set([
    'id', 'snapshot_block', 'home_list_index', 'list_type', 'seq', 'origin_block'
]);
const NULLABLE_INTS = new Set(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']);

function archivedValue(key, value){
    if(INTEGER_KEYS.has(key)) return Number(value);
    if(NULLABLE_INTS.has(key)) return value == null ? null : Number(value);
    if(key === 'finalizing_view') return Number(value) || 0;
    if(key === 'validator_signatures') return value;
    return String(value == null ? '' : value);
}

module.exports = {

    serializeListSnapshot(row){
        const out = {};
        for(const key of LIST_SNAPSHOT_KEYS) out[key] = archivedValue(key, row[key]);
        if(row.meta_hash != null){
            out.name = row.name == null ? null : String(row.name);
            out.description = row.description == null ? null : String(row.description);
            out.meta_hash = String(row.meta_hash);
        }
        return out;
    },

    async backfillListRows(batchSeq, txid, listIds){
        for(const list of (listIds || []))
            await this.db.updateListSnapshotArchiveBatchSeq(batchSeq, txid, list.snapshot_id);
    }

};
