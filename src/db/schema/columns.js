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
 * XChain Hub - COLUMN migrations, as a Database.prototype mixin.
 *
 * Every step that changes a column rather than a key: adding one, widening a type,
 * a charset or an ENUM, and back-filling a value a later column made recoverable.
 * Each one is idempotent from information_schema, so the whole set runs on every
 * boot, and each one swallows its own failure loudly for the reason runMigrations
 * states: one sequential pass, so a throw here takes every later migration and the
 * hub boot with it.
 *
 * src/db/index.js installs these on Database.prototype, so `this` is the Database.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const ark = require('../../anchor/anchor_reward_key.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {


    // Add the per-chain admission height columns to every mirrored table that carries one.
    //
    // The column set per table is the row's measured READ SET, not a uniform three: attest
    // responses and anchor-reward attestations are read on BTC alone by the indexer's own
    // call-site guard, so a second column there would be a column nothing could ever set.
    //
    // Every column is nullable with no default, per C28 and the one mirror .sql that is
    // byte-identical across both repos (attestation_responses.request_block_index). NULL is
    // the legacy row and binds by effective_time at every height, so an existing row needs
    // no backfill and a node that has not crossed the flag day is byte-identical to today.
    // No index: the barrier compares a per-table watermark, not this column, and the
    // consuming selects already have their own covering keys.
    async migrateAdmissionColumns(){
        const TABLES = {
            cross_chain_matches:        ['btc', 'ltc', 'doge'],
            cross_chain_calls:          ['btc', 'ltc', 'doge'],
            bridge_transfers:           ['btc', 'ltc', 'doge'],
            policy_snapshots:           ['btc', 'ltc', 'doge'],
            price_snapshots:            ['btc', 'ltc', 'doge'],
            attestation_responses:      ['btc'],
            anchor_reward_attestations: ['btc'],
        };
        for(let table of Object.keys(TABLES))
            for(let chain of TABLES[table])
                await this.migrateAddNullableColumn(table, 'admit_block_' + chain, 'BIGINT UNSIGNED DEFAULT NULL');

        // oracle_prices takes ONE unqualified column, not the per-chain map. It is the only
        // unsigned rail: no signatures, no canonical, nothing to stamp a map into. Its height
        // is the PUBLISHING chain's, which source_chain already names, so the barrier certifies
        // it against heights[oracle_prices][source_chain] rather than against the reading
        // chain's own B, and every chain reads the row without needing an entry of its own.
        await this.migrateAddNullableColumn('oracle_prices', 'admit_block', 'BIGINT UNSIGNED DEFAULT NULL');
    },


    // Add one nullable column if the table exists and does not already carry it.
    //
    // Idempotent from information_schema, so it runs on every boot at the cost of one read
    // per column. A table with NO columns is one this node has not created yet; the CREATE
    // TABLE from src/sql covers it, so this returns rather than failing the boot.
    //
    // A failure is logged and swallowed, as _migrateColumnType's is and for the same
    // reason: runMigrations is one sequential pass, so a throw here takes every migration
    // after it and the hub boot down with it. The consequence of the column being absent is
    // bounded and stated: this hub cannot stamp admission heights, so above the activation
    // it refuses to finalize those rows rather than producing rows no verifier can rebuild.
    async migrateAddNullableColumn(table, column, columnDef){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT column_name AS c FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ?",
                [this.dbName, table]
            );
            if(!rows || rows.length === 0) return;   // table not here yet; CREATE TABLE covers it
            for(let r of rows)
                if(String(r.c).toLowerCase() === String(column).toLowerCase()) return;   // already migrated
            await db.query('ALTER TABLE `' + table + '` ADD COLUMN `' + column + '` ' + columnDef);
            logger.info('Migration: added ' + table + '.' + column + ' ' + columnDef);
        } catch(e){
            logger.error(nodeUtil.format('MIGRATION FAILED: ' + table + '.' + column + ' is absent. Until it exists this hub ' +
                'cannot stamp an admission height for that table, so above the mirror admission activation it ' +
                'will REFUSE to finalize those rows. Run by hand: ALTER TABLE `' + table + '` ADD COLUMN `' +
                column + '` ' + columnDef, e));
        } finally {
            await db.release();
        }
    },


    // Widen a column's character set in place. Idempotent: reads the live
    // CHARACTER_SET_NAME from information_schema and no-ops once it matches, so a fresh
    // install (which gets the charset from the CREATE TABLE) and an already-migrated node
    // both skip it. It reads the positive case rather than comparing against a legacy
    // spelling because MariaDB 10.6 renamed utf8 to utf8mb3.
    //
    // WIDENING ONLY. `columnDef` restates the whole column, so it must name the same type
    // and nullability the definition file declares; a narrowing here would fail on stored
    // rows rather than converting them. A widen rewrites no stored value: utf8mb3 is a
    // strict subset of utf8mb4, and utf8mb4_general_ci orders BMP characters exactly as
    // utf8_general_ci does.
    async migrateColumnCharset(table, column, targetCharset, columnDef){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT CHARACTER_SET_NAME FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                [this.dbName, table, column]
            );
            if(!rows[0]) return; // table/column not present yet; CREATE TABLE covers it
            let liveCharset = String(rows[0].CHARACTER_SET_NAME || '').toLowerCase();
            if(liveCharset === String(targetCharset).toLowerCase()) return; // already widened
            await db.query('ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef);
            logger.info('Migration: widened ' + table + '.' + column + ' ' + liveCharset + ' -> ' + targetCharset);
        } catch(e){
            // Swallowed loudly, as _migrateColumnType is and for the same reason: runMigrations
            // is one sequential pass at startup, and a throw takes the remaining migrations and
            // the hub boot with it. A narrow column stores every BMP body exactly as it does
            // now, so booting is the better trade - but the line has to name what stays broken
            // and the statement that finishes the job.
            logger.error(nodeUtil.format('MIGRATION FAILED: ' + table + '.' + column + ' is still ' + targetCharset +
                '-incapable. Until it is widened, a provider body carrying a 4-byte character ' +
                'cannot be stored and the response never reaches an indexer. Run by hand: ' +
                'ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef, e));
        } finally {
            await db.release();
        }
    },


    // Convert a column to a new type in place. Idempotent: reads the live DATA_TYPE from
    // information_schema and no-ops when it already matches `targetType`, so a fresh install
    // (which gets the type from the CREATE TABLE) and an already-migrated node both skip it.
    //
    // Safe for the TIMESTAMP -> DATETIME conversion it was added for: TIMESTAMP is stored
    // UTC-normalized and rendered through the SESSION time zone while DATETIME stores the
    // literal, so the conversion preserves the instant only under a UTC session. It is one:
    // the pool pins timezone 'Z' and the driver issues SET time_zone='+00:00' per connection
    // (connectionPoolParams), so no host's local zone can shift a stored value here.
    async _migrateColumnType(table, column, targetType, columnDef){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT DATA_TYPE FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                [this.dbName, table, column]
            );
            if(!rows[0]) return; // table/column not present yet; CREATE TABLE covers it
            let liveType = String(rows[0].DATA_TYPE || '').toLowerCase();
            if(liveType === String(targetType).toLowerCase()) return; // already converted
            await db.query('ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef);
            logger.info('Migration: converted ' + table + '.' + column + ' ' + liveType + ' -> ' + targetType);
        } catch(e){
            // Swallowed on purpose, and loudly. runMigrations runs every migration in one
            // sequential pass at startup, so a throw here would take the remaining migrations
            // and the hub boot down with it - the wrong trade for a column that fails in 2038,
            // not today. What it must never be is invisible, so the line names the consequence
            // and the exact statement an operator runs to finish the job by hand.
            logger.error(nodeUtil.format('MIGRATION FAILED: ' + table + '.' + column + ' is still ' +
                'the old type. Until it is converted, any value past the TIMESTAMP epoch ' +
                'limit (2038-01-19 03:14:07 UTC) cannot be stored. Run by hand: ' +
                'ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + columnDef, e));
        } finally {
            await db.release();
        }
    },


    // Stamp the archive-leg round qualifier onto reward rows written before the column
    // existed. block_index IS the archive leg's snapshot_block at both writers, so the
    // value is recoverable in place. Scoped to anchor_archive, so no other reward type's
    // key can move, and idempotent (a stamped row no longer matches round_qualifier = 0).
    async backfillArchiveRoundQualifier(){
        let db = await this.getConnection();
        try {
            let result = await db.query(
                'UPDATE validator_rewards SET round_qualifier = block_index ' +
                'WHERE reward_type = ? AND round_qualifier = 0 AND block_index IS NOT NULL AND block_index > 0',
                [ark.ARCHIVE_REWARD_TYPE]);
            let changed = (result && result.affectedRows) ? Number(result.affectedRows) : 0;
            if(changed > 0)
                logger.info('Migration: qualified ' + changed + ' archive reward row(s) by snapshot block');
        } catch(e){
            logger.error(nodeUtil.format('Migration error qualifying archive rewards:', e));
        } finally {
            await db.release();
        }
    },


    // Widen an ENUM column in place to the target value set. Idempotent: skips
    // when the live COLUMN_TYPE already contains every target value, so it is a
    // no-op on fresh installs (which get the full set from the CREATE TABLE) and
    // on already-migrated nodes. It rolls out new capability tiers without a
    // manual ALTER on every deployed hub.
    async migrateEnumColumn(table, column, enumValues, nullClause){
        let db = await this.getConnection();
        try {
            let rows = await db.query(
                "SELECT COLUMN_TYPE FROM information_schema.columns " +
                "WHERE table_schema = ? AND table_name = ? AND column_name = ?",
                [this.dbName, table, column]
            );
            if(!rows[0]) return; // table/column not present yet; CREATE TABLE covers it
            let liveType = String(rows[0].COLUMN_TYPE || '').toLowerCase();
            let missing = enumValues.filter(v => liveType.indexOf("'" + v.toLowerCase() + "'") === -1);
            if(missing.length === 0) return; // already covers every target value
            let enumDef = 'ENUM(' + enumValues.map(v => "'" + v + "'").join(',') + ')';
            await db.query('ALTER TABLE `' + table + '` MODIFY `' + column + '` ' + enumDef + ' ' + (nullClause || ''));
            logger.info('Migration: widened ' + table + '.' + column + ' ENUM (added ' + missing.join(', ') + ')');
        } catch(e){
            logger.error(nodeUtil.format('Migration error widening ' + table + '.' + column + ':', e));
        } finally {
            await db.release();
        }
    },

};
