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

// The breaker's open window anchors on the first opening, and a waiter that
// was already in the retry loop and succeeds closes it without a half-open pass.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

describe('db circuit breaker cooldown anchoring', function () {
    let mockPool, mockConn, db, clock;

    beforeEach(function () {
        mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves(), end: sinon.stub().resolves() };
        mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
        const Database = proxyquire('../../../src/db', {
            mariadb: { createPool: sinon.stub().returns(mockPool) },
            fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
            path:    require('path')
        });
        db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass');
        db.circuitThreshold = 3;
        db.circuitCooldown  = 30000;
        db.sleep = sinon.stub().resolves();
        clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
    });

    afterEach(function () {
        clock.restore();
        sinon.restore();
    });

    it('a straggler failing after the breaker opened does not re-arm the cooldown', async function () {
        mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
        await db.getConnection().then(() => expect.fail('should throw'), (e) => {
            expect(e.message).to.include('Circuit breaker opened');
        });
        const anchored = db.circuitOpenUntil;
        expect(anchored).to.equal(1000000 + 30000);

        // A waiter that was inside the loop before the opening keeps failing.
        db.circuitState = 'closed'; // models the straggler's entry before the opening
        mockPool.getConnection = sinon.stub().callsFake(async () => {
            db.circuitState = 'open';
            clock.tick(10000);
            throw new Error('conn failed');
        });
        await db.getConnection().then(() => expect.fail('should throw'), (e) => {
            expect(e.message).to.include('Circuit breaker opened');
        });
        expect(db.circuitState).to.equal('open');
        expect(db.circuitOpenUntil).to.equal(anchored);
    });

    it('a failed half-open probe re-arms the cooldown', async function () {
        db.circuitState     = 'open';
        db.circuitOpenUntil = 1000000 - 1;
        db.circuitFailures  = 3;
        mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
        await db.getConnection().then(() => expect.fail('should throw'), () => {});
        expect(db.circuitState).to.equal('open');
        expect(db.circuitOpenUntil).to.equal(1000000 + 30000);
    });

    it('a waiter that succeeds while the breaker is open closes it', async function () {
        db.circuitState    = 'closed';
        db.circuitFailures = 7;
        mockPool.getConnection = sinon.stub().callsFake(async () => {
            db.circuitState     = 'open'; // opened by a sibling while this acquire was in flight
            db.circuitOpenUntil = Date.now() + 30000;
            return mockConn;
        });
        const conn = await db.getConnection();
        expect(conn).to.equal(mockConn);
        expect(db.circuitState).to.equal('closed');
        expect(db.circuitFailures).to.equal(0);
    });
});
