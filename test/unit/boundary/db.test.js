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

// Stub mariadb module
let poolStub, connStub;
const Database = proxyquire('../../../src/db', {
    mariadb: {
        createPool: function (params) {
            return poolStub;
        },
        createConnection: function (params) {
            return Promise.resolve(connStub);
        }
    }
});

describe('Boundary: Database Layer', registerBoundaryDatabaseLayer);

function registerBoundaryDatabaseLayer() {
    beforeEach(function () {
        connStub = {
            query: sinon.stub().resolves([]),
            end:   sinon.stub().resolves()
        };
        poolStub = {
            getConnection: sinon.stub(),
            end:           sinon.stub().resolves()
        };
    });
    afterEach(function () {
        sinon.restore();
    });
    // DB_NAME_REGEX = /^[A-Za-z0-9_]+$/
    describe('database name validation', registerDatabaseNameValidation);
    // Circuit breaker state transitions
    describe('circuit breaker', registerCircuitBreaker);
    // doQuery argument handling
    describe('doQuery boundaries', registerDoQueryBoundaries);
    // Connection pool config
    describe('connection pool configuration', registerConnectionPoolConfiguration);
}

function registerDatabaseNameValidation() {
    it('alphanumeric with underscores → accepted', testAlphanumericWithUnderscoresAccepted);
    it('alphanumeric only → accepted', testAlphanumericOnlyAccepted);
    it('single character → accepted', testSingleCharacterAccepted);
    it('hyphen in name → rejected', testHyphenInNameRejected);
    it('space in name → rejected', testSpaceInNameRejected);
    it('dot in name → rejected', testDotInNameRejected);
    it('empty string → rejected', testEmptyStringRejected);
    it('SQL injection attempt → rejected', testSQLInjectionAttemptRejected);
}
function testAlphanumericWithUnderscoresAccepted() {
    expect(() => new Database('h', 3306, 'xchain_hub_test', 'u', 'p')).to.not.throw();
}
function testAlphanumericOnlyAccepted() {
    expect(() => new Database('h', 3306, 'xchainhub123', 'u', 'p')).to.not.throw();
}
function testSingleCharacterAccepted() {
    expect(() => new Database('h', 3306, 'x', 'u', 'p')).to.not.throw();
}
function testHyphenInNameRejected() {
    expect(() => new Database('h', 3306, 'xchain-hub', 'u', 'p')).to.throw('Invalid database name');
}
function testSpaceInNameRejected() {
    expect(() => new Database('h', 3306, 'xchain hub', 'u', 'p')).to.throw('Invalid database name');
}
function testDotInNameRejected() {
    expect(() => new Database('h', 3306, 'xchain.hub', 'u', 'p')).to.throw('Invalid database name');
}
function testEmptyStringRejected() {
    expect(() => new Database('h', 3306, '', 'u', 'p')).to.throw('Invalid database name');
}
function testSQLInjectionAttemptRejected() {
    expect(() => new Database('h', 3306, "test'; DROP TABLE--", 'u', 'p')).to.throw('Invalid database name');
}

function registerCircuitBreaker() {
    it('initial state is closed', testInitialStateIsClosed);
    it('failures below threshold keep circuit closed', testFailuresBelowThresholdKeepCircuitClosed);
    it('threshold=10 opens circuit after 10 consecutive failures', testThreshold10OpensCircuitAfter10ConsecutiveFailures);
    it('open circuit rejects immediately before cooldown expires', testOpenCircuitRejectsImmediatelyBeforeCooldownExpires);
    it('open circuit transitions to half-open after cooldown', testOpenCircuitTransitionsToHalfOpenAfterCooldown);
}
function testInitialStateIsClosed() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    expect(db.circuitState).to.equal('closed');
    expect(db.circuitFailures).to.equal(0);
}
function testFailuresBelowThresholdKeepCircuitClosed() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    // Manually simulate failures below threshold
    db.circuitFailures = db.circuitThreshold - 1; // 9
    expect(db.circuitState).to.equal('closed');
    expect(db.circuitFailures).to.equal(9);
}
async function testThreshold10OpensCircuitAfter10ConsecutiveFailures() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    db.circuitThreshold = 3; // Lower threshold for test speed
    poolStub.getConnection.rejects(new Error('connection refused'));

    try {
        await db.getConnection();
    } catch (e) {
        expect(e.message).to.include('Circuit breaker opened');
    }
    expect(db.circuitState).to.equal('open');
}
async function testOpenCircuitRejectsImmediatelyBeforeCooldownExpires() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    db.circuitState = 'open';
    db.circuitOpenUntil = Date.now() + 60000; // 60s in future

    try {
        await db.getConnection();
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Circuit breaker open');
    }
}
async function testOpenCircuitTransitionsToHalfOpenAfterCooldown() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    db.circuitState = 'open';
    db.circuitOpenUntil = Date.now() - 1; // Already expired

    let mockConn = { release: sinon.stub() };
    poolStub.getConnection.resolves(mockConn);

    let conn = await db.getConnection();
    expect(db.circuitState).to.equal('closed'); // half-open → successful → closed
    expect(conn).to.equal(mockConn);
}

function registerDoQueryBoundaries() {
    it('null query returns empty array', testNullQueryReturnsEmptyArray);
    it('empty string query returns empty array', testEmptyStringQueryReturnsEmptyArray);
    it('object arguments are serialized via JSON.stringify', testObjectArgumentsAreSerializedViaJSONStringify);
    it('null arguments are preserved (not converted)', testNullArgumentsArePreservedNotConverted);
}
async function testNullQueryReturnsEmptyArray() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    let result = await db.doQuery(null);
    expect(result).to.deep.equal([]);
}
async function testEmptyStringQueryReturnsEmptyArray() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    let result = await db.doQuery('');
    expect(result).to.deep.equal([]);
}
async function testObjectArgumentsAreSerializedViaJSONStringify() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    let mockConn = {
        query: sinon.stub().resolves([{ id: 1 }]),
        release: sinon.stub()
    };
    poolStub.getConnection.resolves(mockConn);

    let warnStub = sinon.stub(console, 'warn');
    await db.doQuery('SELECT ?', [{ key: 'value' }]);
    let passedArgs = mockConn.query.getCall(0).args[1];
    expect(passedArgs[0]).to.equal('{"key":"value"}');
    expect(warnStub.calledWith(sinon.match('object arg serialized'))).to.be.true;
}
async function testNullArgumentsArePreservedNotConverted() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    let mockConn = {
        query: sinon.stub().resolves([]),
        release: sinon.stub()
    };
    poolStub.getConnection.resolves(mockConn);

    await db.doQuery('INSERT INTO t VALUES (?)', [null]);
    let passedArgs = mockConn.query.getCall(0).args[1];
    expect(passedArgs[0]).to.be.null;
}

function registerConnectionPoolConfiguration() {
    it('connectionLimit defaults to 10', testConnectionLimitDefaultsTo10);
    it('connectTimeout defaults to 10000', testConnectTimeoutDefaultsTo10000);
}
function testConnectionLimitDefaultsTo10() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    expect(db.connectionPoolParams.connectionLimit).to.equal(10);
}
function testConnectTimeoutDefaultsTo10000() {
    let db = new Database('h', 3306, 'test_db', 'u', 'p');
    expect(db.connectionPoolParams.connectTimeout).to.equal(10000);
}
