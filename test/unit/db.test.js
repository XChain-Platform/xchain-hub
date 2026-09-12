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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

describe('Database', function () {

    let mockPool, mockConn, mockMariadb, Database;

    beforeEach(function () {
        mockConn = {
            query:   sinon.stub().resolves([]),
            release: sinon.stub().resolves(),
            end:     sinon.stub().resolves()
        };
        mockPool = {
            getConnection: sinon.stub().resolves(mockConn),
            end:           sinon.stub().resolves()
        };
        mockMariadb = {
            createPool:       sinon.stub().returns(mockPool),
            createConnection: sinon.stub().resolves(mockConn)
        };

        Database = proxyquire('../../src/db', {
            mariadb: mockMariadb,
            fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
            path:    require('path')
        });
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------

    describe('constructor', function () {
        it('creates pool with valid database name', function () {
            let db = new Database('localhost', 3306, 'xchain_hub', 'user', 'pass');
            expect(mockMariadb.createPool.calledOnce).to.be.true;
            expect(db.dbName).to.equal('xchain_hub');
        });

        it('throws on invalid database name (SQL injection)', function () {
            expect(() => new Database('host', 3306, 'DROP TABLE', 'u', 'p')).to.throw('Invalid database name');
        });

        it('throws on database name with special chars', function () {
            expect(() => new Database('host', 3306, 'db;--', 'u', 'p')).to.throw('Invalid database name');
        });

        it('accepts alphanumeric and underscore names', function () {
            expect(() => new Database('host', 3306, 'XChain_Hub_Test_123', 'u', 'p')).to.not.throw();
        });
    });

    // -----------------------------------------------------------------
    // Circuit breaker
    // -----------------------------------------------------------------

    describe('circuit breaker', function () {
        let db;

        beforeEach(function () {
            db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        });

        it('opens after threshold consecutive failures', async function () {
            mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
            db.circuitThreshold = 3; // lower for test speed
            db.circuitCooldown  = 100;

            try {
                await db.getConnection();
            } catch (e) {
                expect(e.message).to.include('Circuit breaker opened');
            }
            expect(db.circuitState).to.equal('open');
            expect(db.circuitFailures).to.equal(3);
        });

        it('rejects immediately when circuit is open', async function () {
            db.circuitState     = 'open';
            db.circuitOpenUntil = Date.now() + 60000;

            try {
                await db.getConnection();
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Circuit breaker open');
            }
        });

        it('transitions to half-open after cooldown', async function () {
            db.circuitState     = 'open';
            db.circuitOpenUntil = Date.now() - 1; // cooldown expired

            let conn = await db.getConnection();
            expect(db.circuitState).to.equal('closed');
            expect(db.circuitFailures).to.equal(0);
            expect(conn).to.equal(mockConn);
        });

        it('resets failure count on successful connection', async function () {
            db.circuitFailures = 5;
            let conn = await db.getConnection();
            expect(db.circuitFailures).to.equal(0);
            expect(conn).to.equal(mockConn);
        });
    });

    // -----------------------------------------------------------------
    // doQuery()
    // -----------------------------------------------------------------

    describe('doQuery()', function () {
        let db;

        beforeEach(function () {
            db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        });

        it('executes parameterized query and releases connection', async function () {
            mockConn.query.resolves([{ id: 1 }]);
            let result = await db.doQuery('SELECT * FROM foo WHERE id = ?', [1]);
            expect(mockConn.query.calledWith('SELECT * FROM foo WHERE id = ?', [1])).to.be.true;
            expect(mockConn.release.calledOnce).to.be.true;
            expect(result).to.deep.equal([{ id: 1 }]);
        });

        it('returns empty results for null query', async function () {
            let result = await db.doQuery(null);
            expect(result).to.deep.equal([]);
            expect(mockConn.query.called).to.be.false;
        });

        it('serializes object args to JSON strings', async function () {
            let objArg = { key: 'value' };
            await db.doQuery('INSERT INTO foo VALUES (?)', [objArg]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('{"key":"value"}');
        });

        it('binds a Date as a UTC datetime literal', async function () {
            // Two bugs met here: JSON.stringify quoted the ISO string, which MariaDB
            // rejected outright (errno 1292), and the driver's own encoder writes a
            // Date in the PROCESS's local timezone against a UTC-pinned session, which
            // silently stored the wrong instant. A UTC literal settles both.
            let when = new Date('2026-07-29T23:24:46.579Z');
            await db.doQuery('INSERT INTO foo (created_at) VALUES (?)', [when]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('2026-07-29 23:24:46.579');
        });

        it('binds a Date identically whatever the host timezone is', async function () {
            // Same instant, formatted from a Date object: the bound value must depend
            // only on the instant, never on where the hub runs.
            let when = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
            await db.doQuery('INSERT INTO foo (created_at) VALUES (?)', [when]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('2026-01-02 03:04:05.006');
        });

        it('passes Buffer args through untouched', async function () {
            let blob = Buffer.from('deadbeef', 'hex');
            await db.doQuery('INSERT INTO foo (payload) VALUES (?)', [blob]);
            let bound = mockConn.query.getCall(0).args[1][0];
            expect(Buffer.isBuffer(bound)).to.be.true;
            expect(bound.equals(blob)).to.be.true;
        });

        it('still JSON-serializes arrays mixed alongside a Date', async function () {
            let when = new Date('2026-07-29T23:24:46.579Z');
            await db.doQuery('INSERT INTO foo (proof, created_at) VALUES (?, ?)', [['a', 'b'], when]);
            let args = mockConn.query.getCall(0).args[1];
            expect(args[0]).to.equal('["a","b"]');
            expect(args[1]).to.equal('2026-07-29 23:24:46.579');
        });

        it('throws on query error and still releases the connection (H-9: no false write success)', async function () {
            mockConn.query.rejects(new Error('syntax error'));
            let thrown = null;
            try {
                await db.doQuery('BAD SQL');
            } catch (e) {
                thrown = e;
            }
            expect(thrown).to.be.an('error');
            expect(thrown.message).to.equal('syntax error');
            expect(mockConn.release.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Config methods
    // -----------------------------------------------------------------

    describe('setParam()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('executes upsert query', async function () {
            mockConn.query.resolves([]);
            await db.setParam('BTC', 'mainnet', 'indexer', 'host', 'localhost');
            expect(mockConn.query.calledOnce).to.be.true;
            let sql = mockConn.query.getCall(0).args[0];
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
        });
    });

    describe('setParams()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('executes a single multi-row upsert', async function () {
            mockConn.query.resolves([]);
            let n = await db.setParams([
                { coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'host', paramValue: 'h1' },
                { coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'port', paramValue: '3309' },
                { coin: 'LTC', network: 'testnet', module: 'encoder', paramName: 'host', paramValue: 'h2' }
            ]);
            expect(n).to.equal(3);
            expect(mockConn.query.calledOnce).to.be.true;
            let [sql, args] = mockConn.query.getCall(0).args;
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
            expect(sql).to.include('VALUES(param_value)');
            // 3 rows × 5 placeholders each
            expect(args).to.have.length(15);
            expect(args.slice(0, 5)).to.deep.equal(['BTC', 'mainnet', 'indexer', 'host', 'h1']);
        });

        it('is a no-op on empty input', async function () {
            let n = await db.setParams([]);
            expect(n).to.equal(0);
            expect(mockConn.query.called).to.be.false;
        });

        it('is a no-op on null/undefined input', async function () {
            expect(await db.setParams(null)).to.equal(0);
            expect(await db.setParams(undefined)).to.equal(0);
            expect(mockConn.query.called).to.be.false;
        });
    });

    describe('getConfig()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns config as key-value object', async function () {
            mockConn.query.resolves([
                { param_name: 'host', param_value: 'localhost' },
                { param_name: 'port', param_value: '3306' }
            ]);

            let config = await db.getConfig('BTC', 'mainnet', 'indexer');
            expect(config).to.deep.equal({ host: 'localhost', port: '3306' });
        });

        it('returns empty object when no config', async function () {
            mockConn.query.resolves([]);
            let config = await db.getConfig('BTC', 'mainnet', 'encoder');
            expect(config).to.deep.equal({});
        });
    });

    describe('getAllConfigs()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('reconstructs nested hierarchy', async function () {
            mockConn.query.resolves([
                { coin: 'BTC', network: 'mainnet', module: 'indexer', param_name: 'host', param_value: 'idx-host' },
                { coin: 'BTC', network: 'mainnet', module: 'indexer', param_name: 'port', param_value: '3309' },
                { coin: 'LTC', network: 'testnet', module: 'decoder', param_name: 'host', param_value: 'dec-host' }
            ]);

            let configs = await db.getAllConfigs();
            expect(configs.BTC.mainnet.indexer.host).to.equal('idx-host');
            expect(configs.BTC.mainnet.indexer.port).to.equal('3309');
            expect(configs.LTC.testnet.decoder.host).to.equal('dec-host');
        });

        it('returns empty object when no configs', async function () {
            mockConn.query.resolves([]);
            let configs = await db.getAllConfigs();
            expect(configs).to.deep.equal({});
        });
    });

    describe('getLastSeq()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns the persisted last_seq as an integer', async function () {
            mockConn.query.resolves([{ value: '42' }]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(42);
        });

        it('returns 0 when no consensus_state row exists', async function () {
            mockConn.query.resolves([]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(0);
        });

        it('returns 0 when the stored value is unparseable', async function () {
            mockConn.query.resolves([{ value: 'not-a-number' }]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Price ingest watermark (HUB-RETRACT-4)
    // -----------------------------------------------------------------

    describe('getPriceIngestWatermark() / bumpPriceIngestWatermark()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns null when no watermark row exists for the chain (so pre-reorg pushes are never rejected)', async function () {
            mockConn.query.resolves([]);
            expect(await db.getPriceIngestWatermark('BTC', 'regtest')).to.equal(null);
        });

        it('returns the parsed generation + orphaned-range bound when a row exists', async function () {
            mockConn.query.resolves([{ retraction_generation: '5', from_action_index: '100' }]);
            expect(await db.getPriceIngestWatermark('BTC', 'regtest'))
                .to.deep.equal({ retraction_generation: 5, from_action_index: 100 });
        });

        // The whole point of the network column: the read must not be able to see another
        // network's fence for the same chain. Anything but a bound network in the WHERE
        // clause is the chain-keyed bug coming back.
        it('scopes the read to the asked-for network (plus the legacy unset bucket)', async function () {
            mockConn.query.resolves([]);
            await db.getPriceIngestWatermark('BTC', 'regtest');
            let call = mockConn.query.getCalls().find(c => /FROM price_ingest_watermarks/.test(c.args[0]));
            expect(call, 'select issued').to.exist;
            expect(call.args[0]).to.match(/source_chain = \?\s+AND network IN \(\?, ''\)/);
            expect(call.args[1]).to.deep.equal(['BTC', 'regtest']);
        });

        it('normalizes the network the same way on read and write, so casing cannot split a row', async function () {
            mockConn.query.resolves([]);
            await db.getPriceIngestWatermark('BTC', '  ReGtest ');
            let read = mockConn.query.getCalls().find(c => /FROM price_ingest_watermarks/.test(c.args[0]));
            expect(read.args[1]).to.deep.equal(['BTC', 'regtest']);

            await db.bumpPriceIngestWatermark('BTC', 4, 9, '  ReGtest ');
            let write = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(write.args[1]).to.deep.equal(['regtest', 'BTC', 4, 9]);
        });

        // A hub with HUB_NETWORK unset keys the legacy '' bucket, which is where its
        // pre-migration rows already live, so its own fence keeps working unchanged.
        it('falls back to the legacy unset bucket when no network is supplied', async function () {
            mockConn.query.resolves([]);
            await db.getPriceIngestWatermark('LTC');
            let read = mockConn.query.getCalls().find(c => /FROM price_ingest_watermarks/.test(c.args[0]));
            expect(read.args[1]).to.deep.equal(['LTC', '']);

            await db.bumpPriceIngestWatermark('LTC', 2, 3);
            let write = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(write.args[1]).to.deep.equal(['', 'LTC', 2, 3]);
        });

        // The ambiguous legacy row and this network's row can both exist between the
        // migration and its backfill. Folding them must take the STRICTER fence, never the
        // first row MariaDB happens to hand back: a fence silently lowered admits exactly
        // the orphan replay it exists to stop.
        it('takes the strictest fence when the legacy bucket and this network both have a row', async function () {
            mockConn.query.resolves([]);
            await db.getPriceIngestWatermark('DOGE', 'testnet');
            let call = mockConn.query.getCalls().find(c => /FROM price_ingest_watermarks/.test(c.args[0]));
            expect(call.args[0]).to.match(/ORDER BY retraction_generation DESC, from_action_index ASC/);
            expect(call.args[0]).to.match(/LIMIT 1/);
        });

        it('issues a generation-monotonic upsert (GREATEST generation, LEAST from at equal generation)', async function () {
            await db.bumpPriceIngestWatermark('DOGE', 7, 50, 'mainnet');
            let call = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(call, 'upsert issued').to.exist;
            expect(call.args[0]).to.match(/ON DUPLICATE KEY UPDATE/);
            expect(call.args[0]).to.match(/retraction_generation = GREATEST\(retraction_generation, VALUES\(retraction_generation\)\)/);
            expect(call.args[0]).to.match(/LEAST\(from_action_index, VALUES\(from_action_index\)\)/);
            expect(call.args[1]).to.deep.equal(['mainnet', 'DOGE', 7, 50]);
        });

        // The write names a network too, so a retraction on one network can no longer raise
        // a fence that drops a different network's healthy pushes for the same chain.
        it('writes the network into the row rather than upserting a chain-only key', async function () {
            await db.bumpPriceIngestWatermark('DOGE', 7, 50, 'regtest');
            let call = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(call.args[0]).to.match(/INSERT INTO price_ingest_watermarks \(network, source_chain, retraction_generation, from_action_index\)/);
            expect(call.args[1][0]).to.equal('regtest');
        });

        it('ignores a negative/non-finite generation without touching the DB', async function () {
            await db.bumpPriceIngestWatermark('BTC', -1, 10, 'regtest');
            expect(mockConn.query.called).to.equal(false);
        });

        it('coerces a negative from_action_index to 0', async function () {
            await db.bumpPriceIngestWatermark('BTC', 3, -9, 'regtest');
            let call = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(call.args[1]).to.deep.equal(['regtest', 'BTC', 3, 0]);
        });
    });

    // The column reaches an already-deployed hub through alterTableForDrift,
    // which never touches keys: without this step a migrated hub carries `network` and
    // still collapses every network onto one row per chain, because the upsert keys on
    // the PRIMARY. The re-key IS the fix; the column alone is not.
    describe('_migratePriceFencePrimaryKey()', function () {

        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        // information_schema.statistics answers for PRIMARY; everything else is empty.
        function primaryKeyOf(columns, tableColumns) {
            mockConn.query.callsFake(async (sql, args) => {
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return columns.map(c => ({ col: c }));
                if (/information_schema\.columns/.test(sql))
                    return (tableColumns || ['network', 'source_chain']).map(c => ({ col: c }));
                return [];
            });
        }

        it('re-keys a chain-only PRIMARY onto (network, source_chain)', async function () {
            // First read: the legacy key. Read-back after the ALTER: the new one.
            let reads = 0;
            mockConn.query.callsFake(async (sql, args) => {
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return (reads++ === 0 ? ['source_chain'] : ['network', 'source_chain']).map(c => ({ col: c }));
                if (/information_schema\.columns/.test(sql))
                    return [{ col: 'network' }, { col: 'source_chain' }];
                return [];
            });
            await db._migratePriceFencePrimaryKey();
            let alter = mockConn.query.getCalls().find(c => /ALTER TABLE/.test(c.args[0]));
            expect(alter, 'ALTER issued').to.exist;
            expect(alter.args[0]).to.match(/DROP PRIMARY KEY, ADD PRIMARY KEY \(network, source_chain\)/);
        });

        // One statement, never a DROP followed by a separate ADD: MariaDB DDL is not
        // transactional, and a table left keyless would seat two divergent fence rows for
        // the same (network, chain) instead of failing loudly.
        it('drops and adds in a single ALTER so the table is never left keyless', async function () {
            let reads = 0;
            mockConn.query.callsFake(async (sql, args) => {
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return (reads++ === 0 ? ['source_chain'] : ['network', 'source_chain']).map(c => ({ col: c }));
                if (/information_schema\.columns/.test(sql))
                    return [{ col: 'network' }, { col: 'source_chain' }];
                return [];
            });
            await db._migratePriceFencePrimaryKey();
            let alters = mockConn.query.getCalls().filter(c => /ALTER TABLE/.test(c.args[0]));
            expect(alters.length).to.equal(1);
        });

        it('no-ops once the key already covers both columns', async function () {
            primaryKeyOf(['network', 'source_chain']);
            await db._migratePriceFencePrimaryKey();
            expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
        });

        it('no-ops when the table is not there yet (a fresh install ships the right key)', async function () {
            primaryKeyOf([]);
            await db._migratePriceFencePrimaryKey();
            expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
        });

        // Re-keying onto a column the table does not have would drop the existing key and
        // fail the add, leaving the fence unconstrained. Refuse before touching it.
        it('refuses to touch the key when the network column has not landed', async function () {
            primaryKeyOf(['source_chain'], ['source_chain', 'retraction_generation']);
            let err = sinon.stub(console, 'error');
            await db._migratePriceFencePrimaryKey();
            expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
            expect(err.getCalls().map(c => String(c.args[0])).join('\n')).to.contain('missing network');
        });

        // A statement that did not throw is not proof the key is there.
        it('reports loudly when the re-key did not take', async function () {
            primaryKeyOf(['source_chain']);
            let err = sinon.stub(console, 'error');
            await db._migratePriceFencePrimaryKey();
            expect(err.getCalls().map(c => String(c.args[0])).join('\n')).to.contain('did not take');
        });

        // The chain-keyed fence still rejects stale replays, over-broadly. Failing hub boot
        // over a scoping defect would trade it for an outage.
        it('logs instead of throwing when the ALTER fails', async function () {
            let reads = 0;
            mockConn.query.callsFake(async (sql, args) => {
                if (/ALTER TABLE/.test(sql)) throw new Error('DDL refused');
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return [{ col: 'source_chain' }];
                if (/information_schema\.columns/.test(sql))
                    return [{ col: 'network' }, { col: 'source_chain' }];
                reads++;
                return [];
            });
            let err = sinon.stub(console, 'error');
            await db._migratePriceFencePrimaryKey();
            expect(err.called).to.equal(true);
            expect(mockConn.release.called, 'connection released').to.equal(true);
        });
    });

    // -----------------------------------------------------------------
    // close()
    // -----------------------------------------------------------------

    describe('close()', function () {
        it('closes the pool', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            await db.close();
            expect(mockPool.end.calledOnce).to.be.true;
        });
    });
});
