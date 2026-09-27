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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

let mockConn, Database, db;

function deadlockOnce(matcher, result) {
    let rejected = false;
    mockConn.query.callsFake(async function (statement) {
        if(!rejected && matcher.test(statement)) {
            rejected = true;
            throw Object.assign(new Error('Deadlock found'), {
                errno: 1213,
                code:  'ER_LOCK_DEADLOCK'
            });
        }
        return result;
    });
}

function registerDatabaseHooks() {
    beforeEach(function () {
        mockConn = {
            query:   sinon.stub(),
            release: sinon.stub().resolves(),
            end:     sinon.stub().resolves()
        };
        const mockPool = {
            getConnection: sinon.stub().resolves(mockConn),
            end:           sinon.stub().resolves()
        };
        const mockMariadb = {
            createPool:       sinon.stub().returns(mockPool),
            createConnection: sinon.stub().resolves(mockConn)
        };
        Database = proxyquire('../../../src/db', {
            mariadb: mockMariadb,
            fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
            path:    require('path')
        });
        db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        sinon.stub(db, 'sleep').resolves();
    });

    afterEach(function () {
        sinon.restore();
    });
}

describe('Database write path deadlock retry', function () {
    registerDatabaseHooks();

    it('retries a capability snapshot insert after one deadlock', async function () {
        deadlockOnce(/^INSERT IGNORE INTO capability_snapshots/, []);

        const result = await db.createCapabilitySnapshots([{
            snapshot_block: 1,
            capability:     'oracle_publish',
            signing_pubkey:  'aa',
            amount:          '1',
            source:          'x'
        }], null);

        expect(result).to.deep.equal([]);
        expect(mockConn.query.callCount).to.equal(2);
    });

    it('retries a state checkpoint insert after one deadlock', async function () {
        deadlockOnce(/^INSERT IGNORE INTO state_checkpoints/i, [{ insertId: 1 }]);

        const result = await db.createStateCheckpoint(
            'bitcoin', 'regtest', 1, 'h', 'l', 'a', 'c', 1, 1,
            null, null, null, null, '[]');

        expect(result).to.deep.equal([{ insertId: 1 }]);
        expect(mockConn.query.callCount).to.equal(2);
    });
});
