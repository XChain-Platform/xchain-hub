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

// The dated .sql migration runner: lock, ledger, baseline, mode gate, apply and
// record, against a scripted connection and a migration directory made fresh per
// test under os.tmpdir(), so no database and no committed fixture is involved.

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { migrationChecksum } = require('../../../../src/db/schema/sql_migration_files.js');

const MANUAL = '-- xchain:migration mode=manual\n';
const AUTO   = '-- xchain:migration mode=auto\n';
const WIDEN_TICK = 'ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL;\n';
const ADD_INDEX  = 'ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_status_created` (status, created_at);\n';

let Database, db, conn, pool, dir, live, ledger, executed, failOn, lockAnswer, savedTimeout;

function makeDir(files) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-dated-migrations-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
}

// A connection that answers the runner's own statements and records the rest.
function scriptedConnection() {
    return {
        release: sinon.stub().resolves(),
        destroy: sinon.stub().resolves(),
        query: sinon.stub().callsFake(async (sql, args) => {
            if (/GET_LOCK/.test(sql)) return [{ l: lockAnswer }];
            if (/RELEASE_LOCK/.test(sql)) return [{ l: 1 }];
            if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return {};
            if (/^SELECT name, checksum FROM schema_migrations/.test(sql)) return ledger.slice();
            if (/INSERT INTO schema_migrations/.test(sql)) { ledger.push({ name: args[0], checksum: args[1], mode: args[2] }); return {}; }
            if (/max_statement_time/.test(sql)) { executed.push('timeout ' + args[0]); return {}; }
            if (/information_schema\.columns/.test(sql)) return live.columns;
            if (/information_schema\.statistics/.test(sql)) return live.indexes;
            if (failOn && sql.indexOf(failOn) !== -1) throw new Error('scripted failure');
            executed.push(sql);
            return {};
        })
    };
}

// oracle_prices.tick at the given width, plus price_snapshots with or without the index.
function liveSchema(tickWidth, withIndex) {
    return {
        columns: [
            { t: 'oracle_prices', c: 'tick', dt: 'varchar', ct: 'varchar(' + tickWidth + ')', cs: 'utf8mb4', len: tickWidth },
            { t: 'price_snapshots', c: 'status', dt: 'varchar', ct: 'varchar(20)', cs: 'utf8mb4', len: 20 },
            { t: 'price_snapshots', c: 'created_at', dt: 'datetime', ct: 'datetime', cs: null, len: null }
        ],
        indexes: withIndex ? [
            { t: 'price_snapshots', i: 'idx_status_created', c: 'status', nu: 1 },
            { t: 'price_snapshots', i: 'idx_status_created', c: 'created_at', nu: 1 }
        ] : []
    };
}

function registerHooks() {
    beforeEach(function () {
        conn = scriptedConnection();
        pool = { getConnection: sinon.stub().resolves(conn), end: sinon.stub().resolves() };
        Database = proxyquire('../../../../src/db', {
            mariadb: { createPool: sinon.stub().returns(pool), createConnection: sinon.stub().resolves(conn) }
        });
        db = new Database('h', 3306, 'hubdb', 'u', 'p');
        ledger = []; executed = []; failOn = null; lockAnswer = '1';
        live = liveSchema(50, false);
        savedTimeout = Object.prototype.hasOwnProperty.call(process.env, 'MIGRATE_QUERY_TIMEOUT')
            ? process.env.MIGRATE_QUERY_TIMEOUT : undefined;
        delete process.env.MIGRATE_QUERY_TIMEOUT;
    });
    afterEach(function () {
        if (savedTimeout === undefined) delete process.env.MIGRATE_QUERY_TIMEOUT;
        else process.env.MIGRATE_QUERY_TIMEOUT = savedTimeout;
        sinon.restore();
    });
}

function registerBootTests() {
    describe('a boot (no includeManual)', function () {
        it('leaves a manual file pending, unrecorded and unrun, when the schema lacks its end state', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir });
            expect(result.pending).to.deep.equal(['2026-10-19-widen-tick.sql']);
            expect(result.pendingTables).to.deep.equal({ '2026-10-19-widen-tick.sql': ['oracle_prices'] });
            expect(result.applied).to.deep.equal([]);
            expect(ledger).to.deep.equal([]);
            expect(executed).to.deep.equal([]);
            expect(conn.release.calledOnce).to.equal(true);
        });

        it('baselines a manual file whose end state already holds, running no statement', async function () {
            live = liveSchema(250, true);
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK, '2026-10-19-index.sql': MANUAL + ADD_INDEX });
            const result = await db.runDatedMigrations({ dir });
            expect(result.baselined).to.deep.equal(['2026-10-19-index.sql', '2026-10-19-widen-tick.sql']);
            expect(executed).to.deep.equal([]);
            expect(ledger.map(r => r.name)).to.deep.equal(['2026-10-19-index.sql', '2026-10-19-widen-tick.sql']);
            expect(ledger[1].checksum).to.equal(migrationChecksum(MANUAL + WIDEN_TICK));
            expect(ledger[1].mode).to.equal('manual');
        });

        it('treats an untagged file as manual', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir });
            expect(result.pending).to.deep.equal(['2026-10-19-widen-tick.sql']);
            expect(executed).to.deep.equal([]);
        });

        it('applies an auto file and records it', async function () {
            makeDir({ '2026-10-19-index.sql': AUTO + ADD_INDEX });
            const result = await db.runDatedMigrations({ dir });
            expect(result.applied).to.deep.equal(['2026-10-19-index.sql']);
            expect(executed.filter(s => /^ALTER/.test(s))).to.have.lengthOf(1);
            expect(ledger.map(r => r.mode)).to.deep.equal(['auto']);
        });

    });
}

function registerBootLedgerTests() {
    describe('a boot, against the ledger and the lock', function () {
        it('skips a file already in the ledger with a matching checksum', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            ledger.push({ name: '2026-10-19-widen-tick.sql', checksum: migrationChecksum(MANUAL + WIDEN_TICK) });
            const result = await db.runDatedMigrations({ dir });
            expect(result).to.include({ lockSkipped: false });
            expect(result.pending.concat(result.applied, result.baselined)).to.deep.equal([]);
        });

        it('logs, and does not throw, on an applied file whose content changed', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            ledger.push({ name: '2026-10-19-widen-tick.sql', checksum: 'f'.repeat(64) });
            const result = await db.runDatedMigrations({ dir });
            expect(result.applied).to.deep.equal([]);
            expect(executed).to.deep.equal([]);
        });

        it('skips the run when another process holds the lock', async function () {
            lockAnswer = '0';
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir });
            expect(result.lockSkipped).to.equal(true);
            expect(conn.query.calledWithMatch(/schema_migrations/)).to.equal(false);
            expect(conn.release.calledOnce).to.equal(true);
        });

        it('takes no connection when the directory is missing or empty', async function () {
            const result = await db.runDatedMigrations({ dir: path.join(os.tmpdir(), 'hub-no-such-dir-' + process.pid + '-' + Date.now()) });
            expect(result.pending.concat(result.applied, result.baselined)).to.deep.equal([]);
            expect(pool.getConnection.called).to.equal(false);
        });

        it('refuses an undated migration file name', async function () {
            makeDir({ 'widen-tick.sql': MANUAL + WIDEN_TICK });
            let caught = null;
            try { await db.runDatedMigrations({ dir }); } catch (e) { caught = e; }
            expect(caught && caught.message).to.match(/not dated/);
        });
    });
}

function registerOperatorTests() {
    describe('the operator path (includeManual)', function () {
        it('applies a pending manual file under the migration timeout, records it, and restores the pool timeout', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir, includeManual: true });
            expect(result.applied).to.deep.equal(['2026-10-19-widen-tick.sql']);
            expect(executed).to.deep.equal([
                'timeout 3600',
                'ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL',
                'timeout 30'
            ]);
            expect(ledger.map(r => r.name)).to.deep.equal(['2026-10-19-widen-tick.sql']);
            expect(conn.release.calledOnce).to.equal(true);
        });

        it('honors MIGRATE_QUERY_TIMEOUT, zero included', async function () {
            process.env.MIGRATE_QUERY_TIMEOUT = '0';
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            await db.runDatedMigrations({ dir, includeManual: true });
            expect(executed[0]).to.equal('timeout 0');
        });
    });
}

function registerOperatorGuardTests() {
    describe('the operator path: targets and failures', function () {

        it('limits the run to the named files and reports the rest as pending', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK, '2026-10-19-index.sql': MANUAL + ADD_INDEX });
            const result = await db.runDatedMigrations({ dir, includeManual: true, only: ['2026-10-19-index.sql'] });
            expect(result.applied).to.deep.equal(['2026-10-19-index.sql']);
            expect(result.pending).to.deep.equal(['2026-10-19-widen-tick.sql']);
        });

        it('refuses a target that names no committed file', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            let caught = null;
            try { await db.runDatedMigrations({ dir, includeManual: true, only: ['2026-10-19-typo.sql'] }); } catch (e) { caught = e; }
            expect(caught && caught.message).to.match(/not found/);
            expect(pool.getConnection.called).to.equal(false);
        });

        it('fails closed on an applied file whose content changed', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            ledger.push({ name: '2026-10-19-widen-tick.sql', checksum: 'f'.repeat(64) });
            let caught = null;
            try { await db.runDatedMigrations({ dir, includeManual: true }); } catch (e) { caught = e; }
            expect(caught && caught.message).to.match(/CHANGED/);
            expect(conn.release.calledOnce).to.equal(true);
        });

        it('throws on a failed statement, records nothing, and still restores and releases', async function () {
            failOn = 'MODIFY `tick`';
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            let caught = null;
            try { await db.runDatedMigrations({ dir, includeManual: true }); } catch (e) { caught = e; }
            expect(caught && caught.message).to.equal('scripted failure');
            expect(ledger).to.deep.equal([]);
            expect(executed).to.deep.equal(['timeout 3600', 'timeout 30']);
            expect(conn.release.calledOnce).to.equal(true);
        });

        it('destroys instead of releasing a connection whose timeout cannot be restored', async function () {
            makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
            let sets = 0;
            const answer = conn.query;
            conn.query = sinon.stub().callsFake(async (sql, args) => {
                if (/max_statement_time/.test(sql) && ++sets === 2) throw new Error('restore failed');
                return answer(sql, args);
            });
            await db.runDatedMigrations({ dir, includeManual: true });
            expect(conn.destroy.calledOnce).to.equal(true);
            expect(conn.release.called).to.equal(false);
        });
    });
}

function registerTimeoutFallbackTests() {
    describe('the migration statement timeout', function () {
        for (const configured of ['', 'not-a-number', '-1']) {
            it('falls back to one hour for MIGRATE_QUERY_TIMEOUT=' + JSON.stringify(configured), async function () {
                process.env.MIGRATE_QUERY_TIMEOUT = configured;
                makeDir({ '2026-10-19-widen-tick.sql': MANUAL + WIDEN_TICK });
                await db.runDatedMigrations({ dir, includeManual: true });
                expect(executed[0]).to.equal('timeout 3600');
            });
        }
    });
}

function registerEntryPointTests() {
    describe('Database.prototype.runMigrations()', function () {
        it('settles the dated files and then asserts the mirror keys with the pending tables, in that order', async function () {
            const order = [];
            const settled = { applied: [], pendingTables: { 'w.sql': ['capability_snapshots'] } };
            sinon.stub(db, 'runDatedMigrations').callsFake(async (opts) => { order.push(['dated', opts]); return settled; });
            sinon.stub(db, 'assertMirrorKeysWide').callsFake(async (pending) => { order.push(['keys', pending]); });
            const result = await db.runMigrations({ includeManual: true });
            expect(order).to.deep.equal([['dated', { includeManual: true }], ['keys', settled.pendingTables]]);
            expect(result).to.equal(settled);
        });
    });
}

function registerRunbookTests() {
    const RUNBOOK = '-- xchain:runbook\n' + MANUAL;
    const COMMITTED = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql', 'migrations');
    const COMMITTED_RUNBOOKS = [
        '2026-06-02-backfill-price-snapshot-reference-chain.sql',
        '2026-09-11-price-ingest-watermarks-network-column.sql'
    ];

    describe('runbook files', function () {
        it('are skipped by a blanket operator run over the committed directory', async function () {
            const result = await db.runDatedMigrations({ includeManual: true, dir: COMMITTED });
            expect(result.runbooks).to.include.members(COMMITTED_RUNBOOKS);
            for (const name of COMMITTED_RUNBOOKS) {
                expect(result.applied).to.not.include(name);
                expect(result.baselined).to.not.include(name);
                expect(result.pending).to.not.include(name);
                expect(ledger.map(r => r.name)).to.not.include(name);
            }
            expect(executed.filter(s => /^(START TRANSACTION|COMMIT|SET @hub_network|UPDATE (price_snapshots|price_ingest_watermarks))/.test(s))).to.deep.equal([]);
        });

        it('are skipped by a boot', async function () {
            makeDir({ '2026-10-19-runbook.sql': RUNBOOK + WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir });
            expect(result.runbooks).to.deep.equal(['2026-10-19-runbook.sql']);
            expect(result.pending).to.deep.equal([]);
            expect(executed).to.deep.equal([]);
            expect(ledger).to.deep.equal([]);
        });

        it('are applied and recorded by a run that names them', async function () {
            makeDir({ '2026-10-19-runbook.sql': RUNBOOK + WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir, includeManual: true, only: '2026-10-19-runbook.sql' });
            expect(result.applied).to.deep.equal(['2026-10-19-runbook.sql']);
            expect(result.runbooks).to.deep.equal([]);
            expect(executed.filter(s => /^ALTER/.test(s))).to.have.lengthOf(1);
            expect(ledger.map(r => r.name)).to.deep.equal(['2026-10-19-runbook.sql']);
        });

        it('do not hide a later manual file from the same blanket run', async function () {
            makeDir({ '2026-10-19-a-runbook.sql': RUNBOOK + WIDEN_TICK, '2026-10-19-b-widen.sql': MANUAL + WIDEN_TICK });
            const result = await db.runDatedMigrations({ dir, includeManual: true });
            expect(result.runbooks).to.deep.equal(['2026-10-19-a-runbook.sql']);
            expect(result.applied).to.deep.equal(['2026-10-19-b-widen.sql']);
        });
    });
}

describe('dated .sql migration runner', function () {
    registerHooks();
    registerBootTests();
    registerBootLedgerTests();
    registerOperatorTests();
    registerOperatorGuardTests();
    registerTimeoutFallbackTests();
    registerEntryPointTests();
    registerRunbookTests();
});
