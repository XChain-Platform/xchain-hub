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
 **********************************************************************
 *
 * XChain Hub - post-migration assertions for widened mirror keys.
 *
 ********************************************************************/

'use strict';

const MIRROR_KEYS = [
    {
        table: 'capability_snapshots',
        name: 'uq_cap_snap',
        columns: ['snapshot_block', 'capability', 'signing_pubkey', 'source']
    },
    {
        table: 'attestation_responses',
        name: 'uq_attest_response',
        columns: ['network', 'request_id', 'effective_time']
    }
];

// The operator step that rebuilds a narrow or missing mirror key: the dated widen,
// applied with the migrate command, named by file when the runner reported it pending.
function remedyFor(table, pendingTables){
    const files = Object.keys(pendingTables || {}).filter(file =>
        (pendingTables[file] || []).indexOf(table) !== -1);
    const what = files.length > 0
        ? 'the pending ' + files.join(', ')
        : 'the dated unique-key widen under src/sql/migrations';
    return 'Run `npm run migrate` to apply ' + what + ', then start the hub again.';
}

module.exports = {

    // pendingTables maps each gated pending migration file to the tables it touches
    // (the runner's result), so a refusal can name the file that fixes the key.
    async assertMirrorKeysWide(pendingTables = {}){
        const db = await this.getConnection();
        try {
            for(const key of MIRROR_KEYS){
                const rows = await db.query(
                    "SELECT column_name AS col, non_unique FROM information_schema.statistics " +
                    "WHERE table_schema = ? AND table_name = ? AND index_name = ? ORDER BY seq_in_index",
                    [this.dbName, key.table, key.name]
                );
                const columns = (rows || []).map(row =>
                    String(row.col != null ? row.col : '').toLowerCase()).filter(Boolean);
                const unique = rows && rows.length > 0 && rows.every(row => Number(row.non_unique) === 0);
                if(unique && columns.length === key.columns.length &&
                    columns.every((column, index) => column === key.columns[index])) continue;

                if(columns.length === 0){
                    const tables = await db.query(
                        "SELECT 1 AS present FROM information_schema.tables " +
                        "WHERE table_schema = ? AND table_name = ? LIMIT 1",
                        [this.dbName, key.table]
                    );
                    if(!tables || tables.length === 0) continue;
                }

                throw new Error('Refusing to start: UNIQUE KEY ' + key.name + ' on ' + key.table +
                    ' must cover (' + key.columns.join(', ') + '); found ' +
                    (columns.length > 0 ? '(' + columns.join(', ') + ')' : 'no index') +
                    (rows && rows.length > 0 && !unique ? ' and it is not unique' : '') + '. ' +
                    remedyFor(key.table, pendingTables));
            }
        } finally {
            await db.release();
        }
    }

};
