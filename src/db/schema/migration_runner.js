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
 * The same ledgered runner the indexer and decoder use, cut to what the hub's
 * files need: a database-scoped advisory lock, the schema_migrations ledger, the
 * files under src/sql/migrations in lexical (authored) order, the immutability
 * checksum, the mode gate, and the apply-then-record of each pending file.
 *
 * A file tagged `-- xchain:runbook` is a one-off operator script and is only ever applied
 * by a run that names it (`npm run migrate -- --file <name>`); a blanket run lists it under
 * runbooks and touches nothing.
 *
 * Every other hub file is tagged mode=manual, so a boot never runs one. Before the mode
 * gate a pending file whose end state the live schema already holds is BASELINED:
 * recorded as applied with no statement run (see schema/migration_end_state.js).
 * That is how a fresh hub, whose src/sql tables already carry every shape, and a
 * deployed hub, whose earlier boots already made those changes, both come to
 * record the files on first run; a file the schema does not yet satisfy stays
 * pending until an operator applies it with `npm run migrate`.
 *
 * The file readers come off Database.io.migrationFiles, the same seam bootstrap
 * reaches its driver and fs through, so a test can hand the runner its own.
 *
 ********************************************************************/

'use strict';

const path = require('path');
const nodeUtil = require('node:util');
const { planEndState, schemaModel, unmetEndState } = require('./migration_end_state.js');
const { getLogger } = require('../../observability');
const hubConfig = require('../../config');
const logger = getLogger();

const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 3600000;
const LEDGER_DDL =
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    'name VARCHAR(255) NOT NULL PRIMARY KEY, ' +
    'checksum VARCHAR(64) NOT NULL, ' +
    "mode VARCHAR(10) NOT NULL DEFAULT 'manual', " +
    'applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' +
    ') ENGINE=InnoDB';
const RECORD_SQL = 'INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())';
const APPLY_HINT = 'apply it with `npm run migrate` (node src/db/migration/migrate.js).';

// A DDL rebuild of a large table can outlast the runtime per-query timeout, so a
// file's statements run under MIGRATE_QUERY_TIMEOUT instead (0 means no limit).
function migrationStatementTimeoutMs(){
    const raw = hubConfig.MIGRATE_QUERY_TIMEOUT;
    if(raw === undefined || raw === null || String(raw).trim() === '')
        return DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS;
}

function setSessionStatementTime(conn, ms){
    return conn.query('SET SESSION max_statement_time = ?', [ms / 1000]);
}

// The tables a plan's statements touch, in first-seen order.
function touchedTables(plan){
    const tables = plan.columns.map(c => c.table).concat([...plan.indexes.values()].map(i => i.table));
    return [...new Set(tables)];
}

// A name that matches no committed file is almost always a typo, and applying
// nothing would look like a clean run, so it is refused with the list of names.
function assertTargetsKnown(only, files, dir){
    if(!only) return;
    if(only.size === 0)
        throw new Error('runDatedMigrations: opts.only was provided but empty; pass at least one migration filename.');
    const unknown = [...only].filter(name => files.indexOf(name) === -1);
    if(unknown.length > 0)
        throw new Error('runDatedMigrations: target(s) not found in ' + dir + ': ' + unknown.join(', ') +
            '. Available: ' + files.join(', '));
}

// Migrations are immutable once applied. The operator path fails closed on an
// edited file; a boot logs it loudly and carries on rather than take the hub down.
function checkAppliedChecksum(file, recorded, checksum, includeManual){
    if(recorded === checksum) return;
    const msg = 'runDatedMigrations: ' + file + ' was already applied but its content CHANGED (recorded ' +
        recorded + ', current ' + checksum + '). Migrations are immutable once applied.';
    if(includeManual) throw new Error(msg + ' Revert the file to the applied content and add a new dated file instead.');
    logger.error(msg + ' Continuing on the recorded schema; review by hand.');
}

module.exports = {

    // Settle every dated migration file. opts.includeManual applies manual files
    // (the operator path); opts.only limits the run to the named files; opts.dir
    // overrides src/sql/migrations. Returns what happened to each file, the tables
    // each gated pending file touches (pendingTables, so a later boot check can name
    // the file that fixes it), and lockSkipped when another process held the lock.
    async runDatedMigrations(opts = {}){
        const files = this.constructor.io.migrationFiles;
        const dir = opts.dir || path.join(this.constructor.io.sqlDir, 'migrations');
        const only = opts.only == null ? null
            : new Set([].concat(opts.only).map(s => String(s).trim()).filter(Boolean));
        const ctx = { dir, only, includeManual: !!opts.includeManual, files,
            result: { applied: [], pending: [], baselined: [], runbooks: [], pendingTables: {}, lockSkipped: false } };

        const names = files.listDatedMigrations(dir);
        assertTargetsKnown(only, names, dir);
        if(names.length === 0) return ctx.result;

        const conn = await this.getConnection();
        const lockName = 'xchain_hub_migrate_' + this.dbName;
        ctx.timeoutChanged = false;
        let returnToPool = true;
        try {
            const got = await conn.query('SELECT GET_LOCK(?, 30) AS l', [lockName]);
            if(!got || !got[0] || String(got[0].l) !== '1'){
                logger.warn('runDatedMigrations: could not take lock ' + lockName +
                    ' (another process is migrating); skipping this run.');
                ctx.result.lockSkipped = true;
                return ctx.result;
            }
            try {
                await conn.query(LEDGER_DDL);
                const rows = await conn.query('SELECT name, checksum FROM schema_migrations');
                ctx.applied = new Map((rows || []).map(r => [r.name, r.checksum]));
                for(const name of names) await this.settleDatedMigration(conn, name, ctx);
            } finally {
                returnToPool = await this.restoreAfterDatedMigrations(conn, lockName, ctx.timeoutChanged);
            }
        } finally {
            if(returnToPool) await conn.release();
        }
        return ctx.result;
    },


    // One file: the checksum guard when it is applied, else baseline, gate or apply.
    async settleDatedMigration(conn, name, ctx){
        const { only, includeManual, files, result } = ctx;
        if(only && !only.has(name)){
            if(!ctx.applied.has(name)) result.pending.push(name);
            return;
        }
        const raw = files.readMigration(ctx.dir, name);
        const checksum = files.migrationChecksum(raw);
        if(ctx.applied.has(name)) return checkAppliedChecksum(name, ctx.applied.get(name), checksum, includeManual);
        if(files.isRunbook(raw) && !(only && only.has(name))){
            result.runbooks.push(name);
            return;
        }

        const mode = files.migrationMode(raw);
        const statements = files.splitMigrationStatements(raw);
        const plan = planEndState(statements);
        const unmet = unmetEndState(plan, await this.readLiveSchemaModel(conn));
        if(unmet.length === 0){
            await conn.query(RECORD_SQL, [name, checksum, mode]);
            result.baselined.push(name);
            logger.info('runDatedMigrations: baselined ' + name + ' (the schema already holds its end state; no statement run).');
            return;
        }
        if(mode !== 'auto' && !includeManual){
            result.pending.push(name);
            result.pendingTables[name] = touchedTables(plan);
            logger.warn('runDatedMigrations: PENDING (mode=' + mode + ') ' + name + ': ' + unmet.slice(0, 3).join('; ') +
                (unmet.length > 3 ? '; and ' + (unmet.length - 3) + ' more' : '') + '. ' + APPLY_HINT);
            return;
        }
        await this.applyDatedMigration(conn, name, statements, checksum, mode, ctx);
    },


    // Run a pending file's statements in order and record it. A failure part way
    // leaves the schema in an unknown state, so it is thrown rather than recorded.
    async applyDatedMigration(conn, name, statements, checksum, mode, ctx){
        if(!ctx.timeoutChanged){
            ctx.timeoutChanged = true;
            await setSessionStatementTime(conn, migrationStatementTimeoutMs());
        }
        logger.info('runDatedMigrations: applying ' + name + ' (mode=' + mode + ', ' + statements.length + ' statement(s))...');
        try {
            for(const stmt of statements) await conn.query(stmt);
        } catch(e){
            logger.error(nodeUtil.format('runDatedMigrations: FAILED applying ' + name + ':', e));
            throw e;
        }
        await conn.query(RECORD_SQL, [name, checksum, mode]);
        ctx.result.applied.push(name);
        logger.info('runDatedMigrations: applied ' + name);
    },


    // The live columns and indexes of this database, in the shape the end-state
    // check reads. Read per file, since an applied file changes what the next sees.
    async readLiveSchemaModel(conn){
        const columns = await conn.query(
            'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt, COLUMN_TYPE AS ct, ' +
            'CHARACTER_SET_NAME AS cs, CHARACTER_MAXIMUM_LENGTH AS len ' +
            'FROM information_schema.columns WHERE table_schema = ?', [this.dbName]);
        const indexes = await conn.query(
            'SELECT TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c, NON_UNIQUE AS nu ' +
            'FROM information_schema.statistics WHERE table_schema = ? ' +
            'ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', [this.dbName]);
        return schemaModel(columns, indexes);
    },


    // Put the session timeout back and release the lock. A connection whose timeout
    // could not be restored is destroyed rather than handed back to the pool, and
    // false tells the caller not to release it.
    async restoreAfterDatedMigrations(conn, lockName, timeoutChanged){
        let restored = true;
        if(timeoutChanged){
            const runtimeMs = (this.connectionPoolParams && this.connectionPoolParams.queryTimeout) || 0;
            try {
                await setSessionStatementTime(conn, runtimeMs);
            } catch(e){
                restored = false;
                logger.error(nodeUtil.format('runDatedMigrations: could not restore max_statement_time:', e));
            }
        }
        try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch(_){ /* released with the session */ }
        if(restored || typeof conn.destroy !== 'function') return true;
        try { await conn.destroy(); } catch(_){ /* already gone */ }
        return false;
    }

};
