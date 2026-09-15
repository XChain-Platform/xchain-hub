'use strict';

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots'];

function makeDb(fsOverrides) {
    const mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves(), end: sinon.stub().resolves() };
    const mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
    const Database = proxyquire('../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs: Object.assign({ readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') }, fsOverrides || {}),
        path: require('path')
    });
    return { db: new Database('localhost', 3306, 'test_db', 'user', 'pass'), mockConn, mockPool };
}

describe('cross-chain chain identity (btc_chain_id)', function () {
    afterEach(function () { sinon.restore(); });

describe('schema: the column ships as DDL drift', function () {
        for (const table of CROSS_CHAIN_TABLES) {
            it(table + ' declares btc_chain_id CHAR(64) NULL', function () {
                const src = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
                expect(src).to.match(/^\s*btc_chain_id\s+CHAR\(64\)\s+NULL,/m);
            });

            it(table + ': an existing install gets the column by ALTER at startup', async function () {
                const src = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
                const { db, mockConn } = makeDb({ readFileSync: sinon.stub().returns(src) });
                // The live table is the pre-column shape: every source column present
                // EXCEPT btc_chain_id.
                const expected = db.parseExpectedColumns(src).filter(c => c.name !== 'btc_chain_id');
                const conn = {
                    query: sinon.stub().callsFake(async (sql) => {
                        if (/information_schema/.test(sql))
                            return expected.map(c => ({ COLUMN_NAME: c.name, IS_NULLABLE: c.nullable ? 'YES' : 'NO', COLUMN_TYPE: 'varchar(20)' }));
                        return [];
                    })
                };
                sinon.stub(console, 'log');
                await db.alterTableForDrift(table + '.sql', conn);
                const alters = conn.query.getCalls().map(c => String(c.args[0])).filter(s => /ALTER TABLE/.test(s));
                expect(alters, table + ': expected exactly one ALTER').to.have.lengthOf(1);
                expect(alters[0]).to.match(new RegExp('ALTER TABLE `' + table + '` ADD COLUMN btc_chain_id\\s+CHAR\\(64\\)\\s+NULL'));
                expect(mockConn.query.called, 'the drift ALTER must reuse the caller connection').to.be.false;
            });
        }
    });
});
