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

            Database = proxyquire('../../../src/db', {
                mariadb: mockMariadb,
                fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
                path:    require('path')
            });
        });

        afterEach(function () {
            sinon.restore();
        });
}

// information_schema.statistics answers for PRIMARY; everything else is empty.
function registerCloseTests() {
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
}

describe('Database', function () {
    registerDatabaseHooks();
    registerCloseTests();
});
