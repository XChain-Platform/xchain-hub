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
 * XChain Hub - UNIQUE KEY and INDEX migrations, as a Database.prototype mixin.
 *
 * Every step that changes what a table's keys constrain: adding a key, widening
 * one in place, retiring a superseded index, and moving the price fence's PRIMARY
 * KEY. They are one family because they share one failure mode - a table left
 * unconstrained admits duplicate rows no later read can tell apart - and the
 * add-then-drop discipline and the read-back-after-every-DDL rule that answer it.
 *
 * src/db/index.js installs these on Database.prototype, so `this` is the Database:
 * the connection, the database name and the sibling migration steps are reached
 * exactly as they were when these were class methods.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Column names carried by an index spec such as "(a, b, c)", lowercased, with
// backticks and any prefix length stripped, so they can be matched against
// information_schema.columns before a key that names them is built.
function indexSpecColumns(spec){
    return String(spec == null ? '' : spec)
        .replace(/^\s*\(/, '').replace(/\)\s*$/, '')
        .split(',')
        .map(s => s.trim().replace(/`/g, '').replace(/\(\s*\d+\s*\)$/, '').toLowerCase())
        .filter(Boolean);
}

module.exports = {


    // Move price_ingest_watermarks' PRIMARY KEY onto (network, source_chain).
    //
    // Idempotent: reads the live key first and no-ops once it already names both columns,
    // so this runs on every boot at the cost of one information_schema read.
    //
    // DROP and ADD are issued as ONE ALTER. MariaDB DDL is not transactional, and a table
    // left with no primary key would let two rows for the same (network, chain) seat, which
    // is a silently divergent fence rather than a loud failure. A single statement either
    // lands both halves or neither.
    //
    // No dedup pass is needed: the old key made source_chain unique on its own, and the
    // drift-added column defaults every existing row to '', so (network, source_chain) is
    // already unique across the existing rows. Those rows stay in the '' bucket, which
    // getPriceIngestWatermark folds into every network's read, so the migration cannot
    // lower a live fence; the fleet migration script backfills them onto the owning hub's
    // network to retire the coupling for good.
    //
    // A failure here is logged, not thrown: the pre-migration chain-keyed fence still
    // rejects stale replays (over-broadly, across networks), so refusing to boot would
    // trade a scoping defect for an outage.
    async migratePriceFencePrimaryKey(){
        const table = 'price_ingest_watermarks';
        let db = await this.getConnection();
        try {
            let present = await this.liveIndexColumns(db, table, 'PRIMARY');
            // [] means the table is not here yet (a fresh install creates it from the SQL
            // source, already correctly keyed). Nothing to migrate either way.
            if(present.length === 0 || (present[0] === 'network' && present[1] === 'source_chain')) return;

            let missing = await this.missingIndexColumns(db, table, '(network, source_chain)');
            if(missing.length > 0){
                logger.error('Migration: cannot re-key ' + table + ' on (network, source_chain); the table is '
                    + 'missing ' + missing.join(', ') + '. The fence stays chain-keyed, so one network\'s '
                    + 'retraction still fences every network for that chain. Run the fleet migration '
                    + '(xchain-hub/migrations/2026-09-11-price-ingest-watermarks-network-column.sql) by hand.');
                return;
            }

            await db.query('ALTER TABLE `' + table + '` DROP PRIMARY KEY, ADD PRIMARY KEY (network, source_chain)');
            let after = await this.liveIndexColumns(db, table, 'PRIMARY');
            if(after[0] === 'network' && after[1] === 'source_chain')
                logger.info('Migration: re-keyed ' + table + ' on (network, source_chain); the price ingest '
                    + 'fence is now per network, not shared across every network on this hub DB.');
            else
                logger.error('Migration: the re-key of ' + table + ' did not take (PRIMARY now covers '
                    + (after.join(', ') || 'nothing') + '). The fence is still chain-keyed.');
        } catch(e){
            logger.error(nodeUtil.format('Migration error re-keying ' + table + ':', e));
        } finally {
            await db.release();
        }
    },


    // Drop an index if it exists (idempotent). It retires an index that a
    // later schema revision superseded, so a node created from an older release
    // does not keep carrying it after the migration runs.
    async dropIndexIfExists(table, indexName){
        let db = await this.getConnection();
        try {
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(!existing[0] || Number(existing[0].c) === 0) return;
            await db.query('ALTER TABLE `' + table + '` DROP INDEX `' + indexName + '`');
            logger.info('Migration: dropped redundant INDEX ' + indexName + ' on ' + table);
        } catch(e){
            logger.error(nodeUtil.format('Migration error dropping ' + indexName + ' on ' + table + ':', e));
        } finally {
            await db.release();
        }
    },


    async migrateUniqueKey(table, indexName, indexColumns, columnList){
        let db = await this.getConnection();
        try {
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(existing[0] && Number(existing[0].c) > 0) return;

            let joinClause = columnList.map(c => 't1.' + c + ' = t2.' + c).join(' AND ');
            let deleteSql = 'DELETE t1 FROM ' + table + ' t1 ' +
                            'INNER JOIN ' + table + ' t2 ' +
                            'WHERE t1.id > t2.id AND ' + joinClause;
            let result = await db.query(deleteSql);
            let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
            if(deleted > 0)
                logger.info('Migration: removed ' + deleted + ' duplicate rows from ' + table);

            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
            logger.info('Migration: added UNIQUE KEY ' + indexName + ' on ' + table);
        } catch(e){
            logger.error(nodeUtil.format('Migration error on ' + table + ':', e));
        } finally {
            await db.release();
        }
    },


    // Columns a live index actually covers, lowercased, in key order. [] when the
    // index is absent. Read back after every DDL step in _widenUniqueKey, because a
    // statement that did not throw is not proof that the key is there.
    async liveIndexColumns(db, table, indexName){
        let rows = await db.query(
            "SELECT column_name AS col FROM information_schema.statistics " +
            "WHERE table_schema = ? AND table_name = ? AND index_name = ? ORDER BY seq_in_index",
            [this.dbName, table, indexName]
        );
        return (rows || []).map(r => String(r.col != null ? r.col : '').toLowerCase()).filter(Boolean);
    },


    // Columns named by an index spec that the table does not have. This is the errno
    // 1072 case ("key column doesn't exist in table") read one statement early, which
    // is what lets the widen refuse before it has touched the existing key.
    async missingIndexColumns(db, table, indexColumns){
        let wanted = indexSpecColumns(indexColumns);
        if(wanted.length === 0) return [];
        let rows = await db.query(
            "SELECT column_name AS col FROM information_schema.columns " +
            "WHERE table_schema = ? AND table_name = ?",
            [this.dbName, table]
        );
        let have = new Set((rows || []).map(r => String(r.col != null ? r.col : '').toLowerCase()));
        // An empty column read means information_schema told us nothing about the
        // table, not that the table has no columns; treat it as "cannot judge" and
        // let the ADD speak, rather than blocking a widen on a bad read.
        if(have.size === 0) return [];
        return wanted.filter(c => !have.has(c));
    },


    // Add a column to an existing UNIQUE KEY in place.
    //
    // ADD-THEN-DROP, never drop-then-add. MariaDB DDL is not transactional, so the
    // old order had a window where a failed ADD left the table with NO unique key
    // and only a log line to say so: a duplicate then inserted cleanly, and for the
    // capability snapshot key that reaches the validator set. Here the wider key is
    // built first under a temporary name, so every failure point leaves the table
    // holding a unique key on these columns, and each step is confirmed by re-reading
    // information_schema instead of trusting that the statement did not throw. If the
    // sequence ever ends with no such key at all, the error thrown here takes hub boot
    // down with it, because serving an unconstrained table is the worse outcome.
    // Widening only (add a column), so no row dedup is required.
    async _widenUniqueKey(table, indexName, requiredColumn, indexColumns){
        const tempName = indexName + '_widening';
        const byHand   = 'ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns;
        let db = await this.getConnection();
        let dropped = false;   // set once the original key is gone, which is what arms the guard
        try {
            let present = await this.liveIndexColumns(db, table, indexName);

            // A temporary key means an earlier run died mid-sequence. Finish that run
            // first: promote it to the real name if the real name is free, then retire it.
            if((await this.liveIndexColumns(db, table, tempName)).length > 0){
                if(present.length === 0){
                    dropped = true;
                    await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
                    present = await this.liveIndexColumns(db, table, indexName);
                }
                if(present.length > 0){
                    await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + tempName);
                    logger.info('Migration: completed an interrupted widen of ' + indexName + ' on ' + table);
                }
            }

            if(present.length === 0){
                await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
                logger.info('Migration: added UNIQUE KEY ' + indexName + ' on ' + table);
                return;
            }
            if(present.indexOf(String(requiredColumn).toLowerCase()) !== -1) return;   // already widened

            let missing = await this.missingIndexColumns(db, table, indexColumns);
            if(missing.length > 0){
                // The existing key is untouched, so the table is exactly as constrained as
                // it was; the widen simply does not happen on this boot.
                logger.error('MIGRATION SKIPPED: UNIQUE KEY ' + indexName + ' on ' + table +
                    ' cannot be widened because the table has no ' + missing.join(', ') +
                    ' column. The narrower key is left in place. Add the column, then run: ' + byHand);
                return;
            }

            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + tempName + ' ' + indexColumns);
            if((await this.liveIndexColumns(db, table, tempName)).length === 0)
                throw new Error('the wider key did not appear after ADD ' + tempName);

            dropped = true;
            await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + indexName);
            await db.query('ALTER TABLE ' + table + ' ADD UNIQUE KEY ' + indexName + ' ' + indexColumns);
            if((await this.liveIndexColumns(db, table, indexName)).indexOf(String(requiredColumn).toLowerCase()) === -1)
                throw new Error('the widened key did not appear under its own name');

            await db.query('ALTER TABLE ' + table + ' DROP INDEX ' + tempName);
            logger.info('Migration: widened UNIQUE KEY ' + indexName + ' on ' + table + ' to include ' + requiredColumn);
        } catch(e){
            logger.error(nodeUtil.format('Migration error widening ' + indexName + ' on ' + table + ':', e));
            if(dropped) await this.assertUniqueKeyStillEnforced(db, table, indexName, tempName, byHand);
        } finally {
            await db.release();
        }
    },


    // Boot guard for a widen that failed after the original key was dropped. Passes as
    // soon as either the final or the temporary key is live AND unique, since either one
    // still constrains the same columns. Anything else, a failed probe included, refuses
    // the boot: an unconstrained table admits duplicates no later read can tell apart.
    async assertUniqueKeyStillEnforced(db, table, indexName, tempName, byHand){
        let enforcing = null;
        try {
            for(const name of [indexName, tempName]){
                let rows = await db.query(
                    "SELECT non_unique AS nu FROM information_schema.statistics " +
                    "WHERE table_schema = ? AND table_name = ? AND index_name = ? LIMIT 1",
                    [this.dbName, table, name]
                );
                if(rows && rows[0] && Number(rows[0].nu) === 0){ enforcing = name; break; }
            }
        } catch(probeError){
            logger.error(nodeUtil.format('Could not read the index state of ' + table + ':', probeError));
        }
        if(enforcing === tempName)
            logger.error('WARNING: ' + table + ' is constrained by the temporary key ' + tempName +
                ' rather than ' + indexName + '. The next boot completes the rename; nothing is lost meanwhile.');
        if(enforcing) return;
        throw new Error('Refusing to start: the UNIQUE KEY ' + indexName + ' on ' + table +
            ' was dropped and could not be rebuilt, so the table now accepts duplicate rows. ' +
            'Restore it by hand before starting the hub again: ' + byHand);
    },


    // Mirrors migrateUniqueKey without the dedup step; idempotent once the index exists.
    async migrateIndex(table, indexName, indexColumns){
        let db = await this.getConnection();
        try {
            let existing = await db.query(
                "SELECT COUNT(*) AS c FROM information_schema.statistics " +
                "WHERE table_schema = ? AND table_name = ? AND index_name = ?",
                [this.dbName, table, indexName]
            );
            if(existing[0] && Number(existing[0].c) > 0) return;

            await db.query('ALTER TABLE ' + table + ' ADD INDEX ' + indexName + ' ' + indexColumns);
            logger.info('Migration: added INDEX ' + indexName + ' on ' + table);
        } catch(e){
            logger.error(nodeUtil.format('Migration error on ' + table + ':', e));
        } finally {
            await db.release();
        }
    },

};
