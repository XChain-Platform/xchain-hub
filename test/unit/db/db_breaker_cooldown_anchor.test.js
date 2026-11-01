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

function registerBreakerHooks(state) {
    beforeEach(function () {
        state.mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves(), end: sinon.stub().resolves() };
        state.mockPool = { getConnection: sinon.stub().resolves(state.mockConn), end: sinon.stub().resolves() };
        const Database = proxyquire('../../../src/db', {
            mariadb: { createPool: sinon.stub().returns(state.mockPool) },
            fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
            path:    require('path')
        });
        state.db = new Database('127.0.0.1', 3306, 'test_db', 'user', 'pass');
        state.db.circuitThreshold = 3;
        state.db.circuitCooldown  = 30000;
        state.db.sleep = sinon.stub().resolves();
        state.clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
    });

    afterEach(function () {
        state.clock.restore();
        sinon.restore();
    });
}

function registerBreakerCases(state) {
    it('a straggler failing after the breaker opened does not re-arm the cooldown', async function () {
        state.mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
        await state.db.getConnection().then(() => expect.fail('should throw'), (e) => {
            expect(e.message).to.include('Circuit breaker opened');
        });
        const anchored = state.db.circuitOpenUntil;
        expect(anchored).to.equal(1000000 + 30000);

        // A waiter that was inside the loop before the opening keeps failing.
        state.db.circuitState = 'closed'; // models the straggler's entry before the opening
        state.mockPool.getConnection = sinon.stub().callsFake(async () => {
            state.db.circuitState = 'open';
            state.clock.tick(10000);
            throw new Error('conn failed');
        });
        await state.db.getConnection().then(() => expect.fail('should throw'), (e) => {
            expect(e.message).to.include('Circuit breaker opened');
        });
        expect(state.db.circuitState).to.equal('open');
        expect(state.db.circuitOpenUntil).to.equal(anchored);
    });

    it('a failed half-open probe re-arms the cooldown', async function () {
        state.db.circuitState     = 'open';
        state.db.circuitOpenUntil = 1000000 - 1;
        state.db.circuitFailures  = 3;
        state.mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
        await state.db.getConnection().then(() => expect.fail('should throw'), () => {});
        expect(state.db.circuitState).to.equal('open');
        expect(state.db.circuitOpenUntil).to.equal(1000000 + 30000);
    });

    it('a waiter that succeeds while the breaker is open closes it', async function () {
        state.db.circuitState    = 'closed';
        state.db.circuitFailures = 7;
        state.mockPool.getConnection = sinon.stub().callsFake(async () => {
            state.db.circuitState     = 'open'; // opened by a sibling while this acquire was in flight
            state.db.circuitOpenUntil = Date.now() + 30000;
            return state.mockConn;
        });
        const conn = await state.db.getConnection();
        expect(conn).to.equal(state.mockConn);
        expect(state.db.circuitState).to.equal('closed');
        expect(state.db.circuitFailures).to.equal(0);
    });
}

describe('db circuit breaker cooldown anchoring', function () {
    const state = {};
    registerBreakerHooks(state);
    registerBreakerCases(state);
});
