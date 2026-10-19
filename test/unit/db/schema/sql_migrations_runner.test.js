'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const FILE_A = '-- xchain:migration mode=auto\nALTER TABLE a ADD x INT;\nALTER TABLE a ADD y INT;\n';
const FILE_B = '-- xchain:migration mode=auto on-error=warn\nALTER TABLE b ADD x INT;\nALTER TABLE b ADD y INT;\n';
const FILE_G = '-- xchain:migration mode=auto gate=GATE_FLAG\nALTER TABLE g ADD x INT;\n';

let Database, conn, files, applied, config, db;

function build(){
    conn = {
        query: sinon.stub().callsFake(async (sql) => /FROM schema_migrations/.test(sql) ? applied : []),
        release: sinon.stub().resolves()
    };
    config = { MIGRATE_QUERY_TIMEOUT: undefined, GATE_FLAG: undefined };
    const fs = {
        readdirSync: sinon.stub().callsFake(() => Object.keys(files)),
        readFileSync: sinon.stub().callsFake((p) => files[p.split('/').pop()])
    };
    const runner = proxyquire('../../../../src/db/schema/sql_migrations.js', { '../../config': config });
    db = Object.create({ ...runner });
    Object.defineProperty(db, 'constructor', { value: { io: { fs, migrationsDir: '/m' } } });
    db.getConnection = sinon.stub().resolves(conn);
    db.connectionPoolParams = { queryTimeout: 30000 };
    Database = db;
}

const sqlCalls = () => conn.query.getCalls().map(c => c.args[0]);

function freshFiles(){
    beforeEach(function () {
        files = {
            '2026-10-19-b.sql': FILE_B,
            '2026-10-19-a.sql': FILE_A,
            'README.md': 'ignored'
        };
        applied = [];
        build();
    });
}

describe('runSqlMigrations()', function () {
    freshFiles();

    it('applies files in name order and records each one', async function () {
        await Database.runSqlMigrations();
        const calls = sqlCalls();
        const order = calls.filter(s => /^ALTER/.test(s));
        expect(order).to.deep.equal(['ALTER TABLE a ADD x INT', 'ALTER TABLE a ADD y INT',
            'ALTER TABLE b ADD x INT', 'ALTER TABLE b ADD y INT']);
        const inserts = conn.query.getCalls().filter(c => /INSERT INTO schema_migrations/.test(c.args[0]));
        expect(inserts.map(c => c.args[1][0])).to.deep.equal(['2026-10-19-a.sql', '2026-10-19-b.sql']);
        expect(conn.release.calledOnce).to.equal(true);
    });

    it('creates the ledger first and restores the pool timeout after', async function () {
        await Database.runSqlMigrations();
        const calls = conn.query.getCalls();
        expect(calls[0].args[0]).to.match(/CREATE TABLE IF NOT EXISTS `schema_migrations`/);
        const timeouts = calls.filter(c => /max_statement_time/.test(c.args[0]));
        expect(timeouts[0].args[1]).to.deep.equal([3600]);
        expect(timeouts[timeouts.length - 1].args[1]).to.deep.equal([30]);
    });

    it('honors MIGRATE_QUERY_TIMEOUT', async function () {
        config.MIGRATE_QUERY_TIMEOUT = '900000';
        await Database.runSqlMigrations();
        const first = conn.query.getCalls().find(c => /max_statement_time/.test(c.args[0]));
        expect(first.args[1]).to.deep.equal([900]);
    });
});

describe('runSqlMigrations() skips, failures and gates', function () {
    freshFiles();

    it('skips a file already recorded, whatever its checksum', async function () {
        applied = [{ name: '2026-10-19-a.sql', checksum: 'stale' }];
        await Database.runSqlMigrations();
        expect(sqlCalls().filter(s => /ALTER TABLE a /.test(s))).to.have.length(0);
        expect(sqlCalls().filter(s => /ALTER TABLE b /.test(s))).to.have.length(2);
    });

    it('stops at a failing statement, leaves the file unrecorded and still releases', async function () {
        conn.query.callsFake(async (sql) => {
            if (/FROM schema_migrations/.test(sql)) return [];
            if (/ADD x INT/.test(sql) && /TABLE a /.test(sql)) throw new Error('boom');
            return [];
        });
        let failure = null;
        try { await Database.runSqlMigrations(); } catch (e) { failure = e; }
        expect(failure && failure.message).to.equal('boom');
        expect(sqlCalls().filter(s => /INSERT INTO schema_migrations/.test(s))).to.have.length(0);
        expect(sqlCalls().filter(s => /ADD y INT/.test(s))).to.have.length(0);
        expect(conn.release.calledOnce).to.equal(true);
    });

    it('with on-error=warn keeps going and records the file', async function () {
        applied = [{ name: '2026-10-19-a.sql', checksum: 'x' }];
        conn.query.callsFake(async (sql) => {
            if (/FROM schema_migrations/.test(sql)) return applied;
            if (/TABLE b ADD x/.test(sql)) throw new Error('boom');
            return [];
        });
        await Database.runSqlMigrations();
        expect(sqlCalls().filter(s => /TABLE b ADD y/.test(s))).to.have.length(1);
        expect(sqlCalls().filter(s => /INSERT INTO schema_migrations/.test(s))).to.have.length(1);
    });

    it('defers a gated file without recording it, then runs it once the gate is 1', async function () {
        files = { '2026-10-19-g.sql': FILE_G };
        build();
        await Database.runSqlMigrations();
        expect(sqlCalls().filter(s => /TABLE g/.test(s))).to.have.length(0);
        expect(sqlCalls().filter(s => /INSERT INTO schema_migrations/.test(s))).to.have.length(0);

        build();
        config.GATE_FLAG = '1';
        await Database.runSqlMigrations();
        expect(sqlCalls().filter(s => /TABLE g/.test(s))).to.have.length(1);
        expect(sqlCalls().filter(s => /INSERT INTO schema_migrations/.test(s))).to.have.length(1);
    });
});
