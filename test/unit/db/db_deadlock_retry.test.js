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

let mockPool, mockConn, Database, db, deadlock;

function registerDatabaseHooks() {
    beforeEach(function () {
        mockConn = {
            query:   sinon.stub(),
            release: sinon.stub().resolves(),
            end:     sinon.stub().resolves()
        };
        mockPool = {
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
        deadlock = Object.assign(new Error('Deadlock found'), {
            errno: 1213,
            code:  'ER_LOCK_DEADLOCK'
        });
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerRetryTests() {
    it('retries two deadlocks and returns the third result', async function () {
        mockConn.query.onCall(0).rejects(deadlock);
        mockConn.query.onCall(1).rejects(deadlock);
        mockConn.query.onCall(2).resolves([{ ok: 1 }]);

        const result = await db.doQuery('UPDATE items SET value = 1');

        expect(result).to.deep.equal([{ ok: 1 }]);
        expect(mockConn.query.callCount).to.equal(3);
        expect(mockPool.getConnection.callCount).to.equal(3);
        expect(db.sleep.firstCall.calledWithExactly(25)).to.be.true;
        expect(db.sleep.secondCall.calledWithExactly(50)).to.be.true;
    });

    it('stops after the third deadlock', async function () {
        mockConn.query.rejects(deadlock);
        let thrown;

        try {
            await db.doQuery('UPDATE items SET value = 1');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.equal(deadlock);
        expect(mockConn.query.callCount).to.equal(3);
        expect(mockPool.getConnection.callCount).to.equal(3);
    });
}

function registerNoRetryTests() {
    it('does not retry a non-deadlock error', async function () {
        const nonDeadlock = Object.assign(new Error('Unknown column'), { errno: 1054 });
        mockConn.query.rejects(nonDeadlock);
        let thrown;

        try {
            await db.doQuery('SELECT missing FROM items');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.equal(nonDeadlock);
        expect(mockConn.query.calledOnce).to.be.true;
    });

    it('does not retry a deadlock on a caller-owned transaction', async function () {
        const transactionConnection = { query: sinon.stub().rejects(deadlock) };
        db.transactionConnection = transactionConnection;
        let thrown;

        try {
            await db.doQuery('UPDATE items SET value = 1');
        } catch (error) {
            thrown = error;
        }

        expect(thrown).to.equal(deadlock);
        expect(transactionConnection.query.calledOnce).to.be.true;
        expect(mockConn.query.called).to.be.false;
        expect(mockPool.getConnection.called).to.be.false;
    });
}

describe('Database doQuery deadlock retry', function () {
    registerDatabaseHooks();
    registerRetryTests();
    registerNoRetryTests();
});
