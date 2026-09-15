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

let mockPool, mockConn, mockMariadb, Database, db;

function registerDatabaseHooks() {
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
}

function registerPriceWatermarkReadTests() {
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
}

function registerPriceWatermarkWriteTests() {
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
}

function registerGetPriceIngestWatermarkBumpPriceIngestWatermarkTests() {
    // -----------------------------------------------------------------
    // Price ingest watermark (HUB-RETRACT-4)
    // -----------------------------------------------------------------
    describe('getPriceIngestWatermark() / bumpPriceIngestWatermark()', function () {
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });
        registerPriceWatermarkReadTests();
        registerPriceWatermarkWriteTests();
    });
}

describe('Database', function () {
    registerDatabaseHooks();
    registerGetPriceIngestWatermarkBumpPriceIngestWatermarkTests();
});
