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
 * XChain Hub - the dated .sql migration runner, as a Database.prototype mixin.
 *
 * Applies src/sql/migrations/YYYY-MM-DD-*.sql in name order and records each
 * applied file in schema_migrations (name, checksum, applied_at), so a file runs
 * once per database. Replaces the JS step list that used to live in
 * schema/{migrations,columns,keys,datetime_columns}.js; the statements are the
 * ones those helpers issued, written out as IF NOT EXISTS / MODIFY DDL.
 *
 * Runs after verifyTables() in the boot sequence, so a fresh install already has
 * the current DDL and the drift-reconciled columns the key files name. A recorded
 * file whose checksum later differs is logged, never re-run: add a new dated file.
 *
 * See sql_migration_file.js for the per-file directive (on-error, gate).
 *
 ********************************************************************/

'use strict';

const crypto = require('node:crypto');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const hubConfig = require('../../config');
const { parseMigrationFile, isMigrationFileName } = require('./sql_migration_file.js');
const logger = getLogger();

const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 3600000;

const LEDGER_DDL =
    'CREATE TABLE IF NOT EXISTS `schema_migrations` (' +
    '`name` VARCHAR(190) NOT NULL, ' +
    '`checksum` CHAR(64) NOT NULL, ' +
    '`applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
    'PRIMARY KEY (`name`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

function migrationStatementTimeoutMs(){
    const raw = hubConfig.MIGRATE_QUERY_TIMEOUT;
    if(raw === undefined || raw === null || String(raw).trim() === '')
        return DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS;
}

module.exports = {

    // Read, order and parse every dated file. Throws on a malformed one: a file the
    // runner cannot read must stop the boot rather than be skipped.
    loadSqlMigrations(){
        const { fs, migrationsDir } = this.constructor.io;
        return fs.readdirSync(migrationsDir)
            .filter(isMigrationFileName)
            .sort()
            .map(name => {
                const sql = fs.readFileSync(migrationsDir + '/' + name, 'utf8');
                return { ...parseMigrationFile(name, sql),
                    checksum: crypto.createHash('sha256').update(sql).digest('hex') };
            });
    },

    async runSqlMigrations(){
        const files = this.loadSqlMigrations();
        const db = await this.getConnection();
        let timeoutChanged = false;
        try {
            await db.query(LEDGER_DDL);
            const rows = await db.query('SELECT name, checksum FROM schema_migrations');
            const applied = new Map((rows || []).map(r => [String(r.name), String(r.checksum)]));
            const runtimeTimeoutMs = (this.connectionPoolParams && this.connectionPoolParams.queryTimeout) || 0;

            for(const file of files){
                if(applied.has(file.name)){
                    if(applied.get(file.name) !== file.checksum)
                        logger.error('Migration ' + file.name + ' changed after it was applied; it is not re-run. ' +
                            'Put the change in a new dated file.');
                    continue;
                }
                if(file.gate && hubConfig[file.gate] !== '1'){
                    logger.warn('Migration ' + file.name + ' deferred until ' + file.gate + '=1 is set; each boot asks again.');
                    continue;
                }
                timeoutChanged = true;
                await db.query('SET SESSION max_statement_time = ?', [migrationStatementTimeoutMs() / 1000]);
                await this.applySqlMigration(db, file);
                await db.query('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
                    [file.name, file.checksum]);
                logger.info('Migration applied: ' + file.name);
            }
            if(timeoutChanged)
                await db.query('SET SESSION max_statement_time = ?', [runtimeTimeoutMs / 1000]);
            return true;
        } finally {
            await db.release();
        }
    },

    async applySqlMigration(db, file){
        for(const statement of file.statements){
            try {
                await db.query(statement);
            } catch(e){
                if(file.onError === 'fail'){
                    logger.error(nodeUtil.format('MIGRATION FAILED in ' + file.name + '; it is not recorded and the ' +
                        'next boot retries it. Statement: ' + statement, e));
                    throw e;
                }
                logger.error(nodeUtil.format('MIGRATION FAILED in ' + file.name + '; startup continues. ' +
                    'Run by hand: ' + statement, e));
            }
        }
    }

};
