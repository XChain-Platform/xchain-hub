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

// Database.withTransaction against a stub pool: the connection lifecycle and the
// commit/rollback calls it makes. InnoDB's own rollback is proven on a DB venue by
// test/integration/anchor/anchor_reward_supersede_atomic.test.js.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const RewardTracker = require('../../../../src/anchor/reward_tracker');

const PK_LOW  = 'aa'.repeat(32);
const PK_HIGH = 'bb'.repeat(32);

let mockConn, mockPool, db, deadlock;

function registerHooks() {
    beforeEach(function () {
        mockConn = {
            query:            sinon.stub().resolves([]),
            beginTransaction: sinon.stub().resolves(),
            commit:           sinon.stub().resolves(),
            rollback:         sinon.stub().resolves(),
            release:          sinon.stub().resolves(),
            end:              sinon.stub().resolves()
        };
        mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
        const Database = proxyquire('../../../../src/db', {
            mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
            fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
            path:    require('path')
        });
        db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        sinon.stub(db, 'sleep').resolves();
        deadlock = Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
    });
    afterEach(function () { sinon.restore(); });
}

async function rejectionOf(promise) {
    try { await promise; } catch (e) { return e; }
    return null;
}

function registerCommitAndRollbackTests() {
    it('runs the body inside BEGIN and COMMIT on its own connection and returns its result', async function () {
        let result = await db.withTransaction(async conn => {
            await conn.query('DELETE 1');
            await conn.query('INSERT 2');
            return 'done';
        });

        expect(result).to.equal('done');
        sinon.assert.callOrder(mockConn.beginTransaction, mockConn.query, mockConn.commit, mockConn.release);
        expect(mockConn.rollback.called).to.equal(false);
        expect(db.transactionConnection).to.equal(null);
    });

    it('rolls back, never commits and rethrows when a statement fails', async function () {
        let boom = new Error('insert failed');
        mockConn.query.onSecondCall().rejects(boom);

        let err = await rejectionOf(db.withTransaction(async conn => {
            await conn.query('DELETE 1');
            await conn.query('INSERT 2');
        }));

        expect(err).to.equal(boom);
        expect(mockConn.rollback.calledOnce).to.equal(true);
        expect(mockConn.commit.called).to.equal(false);
        expect(mockConn.release.calledOnce).to.equal(true);
        expect(mockPool.getConnection.calledOnce).to.equal(true);
    });

    it('rethrows the original error when the rollback itself fails', async function () {
        let boom = new Error('insert failed');
        mockConn.rollback.rejects(new Error('connection lost'));

        let err = await rejectionOf(db.withTransaction(async () => { throw boom; }));

        expect(err).to.equal(boom);
        expect(mockConn.release.calledOnce).to.equal(true);
    });

    it('refuses to run while a per-Db transactionConnection is open', async function () {
        db.transactionConnection = mockConn;

        let err = await rejectionOf(db.withTransaction(async () => 'never'));

        expect(err && err.message).to.match(/transactionConnection is already open/);
        expect(mockConn.beginTransaction.called).to.equal(false);
    });
}

function registerDeadlockTests() {
    it('reruns the whole body after a deadlock, on a fresh connection', async function () {
        let bodies = 0;
        let result = await db.withTransaction(async conn => {
            bodies++;
            if (bodies < 3) throw deadlock;
            await conn.query('INSERT 2');
            return bodies;
        });

        expect(result).to.equal(3);
        expect(mockPool.getConnection.callCount).to.equal(3);
        expect(mockConn.rollback.callCount).to.equal(2);
        expect(mockConn.commit.callCount).to.equal(1);
        expect(db.sleep.firstCall.calledWithExactly(25)).to.equal(true);
        expect(db.sleep.secondCall.calledWithExactly(50)).to.equal(true);
    });

    it('gives up after the third deadlock and rethrows it', async function () {
        let err = await rejectionOf(db.withTransaction(async () => { throw deadlock; }));

        expect(err).to.equal(deadlock);
        expect(mockPool.getConnection.callCount).to.equal(3);
        expect(mockConn.release.callCount).to.equal(3);
        expect(mockConn.commit.called).to.equal(false);
    });
}

// The reward supersede composed on the real withTransaction: the incumbent read goes
// through doQuery, then the DELETE and the winner's INSERT share one transaction.
function registerSupersedeTests() {
    function trackerOver(insertError) {
        mockConn.query.callsFake(async sql => {
            if (/^SELECT validator_pubkey, batch_seq FROM validator_rewards/.test(sql))
                return [{ validator_pubkey: PK_HIGH, batch_seq: null }];
            if (insertError && /^INSERT IGNORE INTO validator_rewards/.test(sql)) throw insertError;
            return [];
        });
        return new RewardTracker({ db, network: '', p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: '10.00000000' } });
    }

    it('supersedes the incumbent with the DELETE and INSERT inside one committed transaction', async function () {
        await trackerOver(null).recordAnchorReward('anchor_BTC', 42, PK_LOW, 100, '');

        let txSql = mockConn.query.getCalls().map(c => c.args[0]).filter(s => !/^SELECT/.test(s));
        expect(txSql.map(s => s.split(' ').slice(0, 2).join(' '))).to.deep.equal(['DELETE FROM', 'INSERT IGNORE']);
        expect(mockConn.beginTransaction.calledOnce).to.equal(true);
        expect(mockConn.commit.calledOnce).to.equal(true);
        sinon.assert.callOrder(mockConn.beginTransaction, mockConn.commit);
    });

    it('rolls the DELETE back and rejects when the winner\'s INSERT fails', async function () {
        let boom = new Error('insert failed');
        let err = await rejectionOf(trackerOver(boom).recordAnchorReward('anchor_BTC', 42, PK_LOW, 100, ''));

        expect(err).to.equal(boom);
        expect(mockConn.rollback.calledOnce).to.equal(true);
        expect(mockConn.commit.called).to.equal(false);
    });
}

describe('Database withTransaction', function () {
    registerHooks();
    registerCommitAndRollbackTests();
    registerDeadlockTests();
    registerSupersedeTests();
});
