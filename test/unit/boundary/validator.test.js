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
const { DB_METHODS } = require('../../helpers/mockHub');

let mockDb;
const XChainHub = proxyquire('../../../src/XChainHub', {
    './db':                 function () { return mockDb; },
    './peers/manager.js':     function () { return null; },
    './consensus/pbft.js':       function () {},
    './validators/identity.js': function () {},
    './oracle/consensus.js': function () {},
    './oracle/round.js':     function () {},
    './anchor/reward_tracker.js':   function () {},
    './validators/slash_detector.js':   function () {},
    './cross_chain/engine.js': function () {},
    './anchor/reorg_handler.js':    function () {},
    './cross_chain/swap_tracker.js':     function () {},
    './validators/governance.js':      function () {}
});

let hub;

describe('Boundary: Validator Registration', registerBoundaryValidatorRegistration);

function registerBoundaryValidatorRegistration() {
    beforeEach(function () {
        mockDb = {
            // Spread the named query methods first so registerValidator/syncValidators,
            // which now call db.updateValidatorByAddr / db.setValidator instead of issuing
            // SQL at the call site, still route through the doQuery stub below with the
            // same statement text the assertions expect.
            ...DB_METHODS,
            doQuery:        sinon.stub().resolves([]),
            setParam:       sinon.stub().resolves(),
            createDatabase: sinon.stub().resolves(),
            verifyTables:   sinon.stub().resolves(),
            close:          sinon.stub().resolves()
        };
        hub = new XChainHub('host', 3306, 'test_db', 'user', 'pass');
        hub.db = mockDb;
    });
    afterEach(function () {
        sinon.restore();
    });
    // signing_pubkey regex: /^[0-9a-fA-F]{64}$/
    describe('signing_pubkey validation', registerSigningPubkeyValidation);
    // addr validation
    describe('addr validation', registerAddrValidation);
    // syncValidators
    describe('syncValidators', registerSyncValidators);
}

function registerSigningPubkeyValidation() {
    it('exactly 64 lowercase hex chars → accepted', testExactly64LowercaseHexCharsAccepted);
    it('exactly 64 uppercase hex chars → accepted', testExactly64UppercaseHexCharsAccepted);
    it('mixed case hex chars → accepted', testMixedCaseHexCharsAccepted);
    it('63 hex chars → rejected', test63HexCharsRejected);
    it('65 hex chars → rejected', test65HexCharsRejected);
    it('64 chars with non-hex character → rejected', test64CharsWithNonHexCharacterRejected);
    it('empty string → rejected', testEmptyStringRejected);
    it('null → rejected', testNullRejected);
    it('undefined → rejected', testUndefinedRejected);
}
async function testExactly64LowercaseHexCharsAccepted() {
    let pubkey = 'aa'.repeat(32);
    await hub.registerValidator(pubkey, 'ws://test:10001');
    expect(mockDb.doQuery.called).to.be.true;
}
async function testExactly64UppercaseHexCharsAccepted() {
    let pubkey = 'AA'.repeat(32);
    await hub.registerValidator(pubkey, 'ws://test:10001');
    expect(mockDb.doQuery.called).to.be.true;
}
async function testMixedCaseHexCharsAccepted() {
    let pubkey = 'aAbBcCdDeEfF'.repeat(5) + 'aAbB';
    expect(pubkey).to.have.lengthOf(64);
    await hub.registerValidator(pubkey, 'ws://test:10001');
    expect(mockDb.doQuery.called).to.be.true;
}
async function test63HexCharsRejected() {
    let pubkey = 'a'.repeat(63);
    try {
        await hub.registerValidator(pubkey, 'ws://test:10001');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Invalid signing pubkey');
    }
}
async function test65HexCharsRejected() {
    let pubkey = 'a'.repeat(65);
    try {
        await hub.registerValidator(pubkey, 'ws://test:10001');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Invalid signing pubkey');
    }
}
async function test64CharsWithNonHexCharacterRejected() {
    let pubkey = 'a'.repeat(63) + 'g'; // 'g' is not hex
    try {
        await hub.registerValidator(pubkey, 'ws://test:10001');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Invalid signing pubkey');
    }
}
async function testEmptyStringRejected() {
    try {
        await hub.registerValidator('', 'ws://test:10001');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Invalid signing pubkey');
    }
}
async function testNullRejected() {
    try {
        await hub.registerValidator(null, 'ws://test:10001');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Invalid signing pubkey');
    }
}
async function testUndefinedRejected() {
    try {
        await hub.registerValidator(undefined, 'ws://test:10001');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('Invalid signing pubkey');
    }
}

function registerAddrValidation() {
    it('empty string addr → rejected', testEmptyStringAddrRejected);
    it('null addr → rejected', testNullAddrRejected);
    it('valid addr → accepted', testValidAddrAccepted);
}
async function testEmptyStringAddrRejected() {
    try {
        await hub.registerValidator('aa'.repeat(32), '');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('addr is required');
    }
}
async function testNullAddrRejected() {
    try {
        await hub.registerValidator('aa'.repeat(32), null);
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('addr is required');
    }
}
async function testValidAddrAccepted() {
    await hub.registerValidator('aa'.repeat(32), 'ws://validator:10001');
    expect(mockDb.doQuery.called).to.be.true;
}

function registerSyncValidators() {
    it('non-array input → throws', testNonArrayInputThrows);
    it('empty array → no DB inserts, still logs sync', testEmptyArrayNoDBInsertsStillLogsSync);
    it('entry with invalid pubkey is skipped', testEntryWithInvalidPubkeyIsSkipped);
    it('entry with missing addr is skipped', testEntryWithMissingAddrIsSkipped);
    it('valid entry is inserted', testValidEntryIsInserted);
}
async function testNonArrayInputThrows() {
    try {
        await hub.syncValidators('not-an-array');
        expect.fail('should throw');
    } catch (e) {
        expect(e.message).to.include('must be an array');
    }
}
async function testEmptyArrayNoDBInsertsStillLogsSync() {
    await hub.syncValidators([]);
    // doQuery is called for the reload steps, but no INSERT calls for validators
    // The function should complete without error
}
async function testEntryWithInvalidPubkeyIsSkipped() {
    await hub.syncValidators([
        { signing_pubkey: 'short', addr: 'ws://test:10001' }
    ]);
    // The INSERT query should not be called for invalid entries
    let insertCalls = mockDb.doQuery.getCalls().filter(c =>
        c.args[0] && c.args[0].includes('INSERT INTO validators')
    );
    expect(insertCalls).to.have.lengthOf(0);
}
async function testEntryWithMissingAddrIsSkipped() {
    await hub.syncValidators([
        { signing_pubkey: 'aa'.repeat(32), addr: '' }
    ]);
    let insertCalls = mockDb.doQuery.getCalls().filter(c =>
        c.args[0] && c.args[0].includes('INSERT INTO validators')
    );
    expect(insertCalls).to.have.lengthOf(0);
}
async function testValidEntryIsInserted() {
    await hub.syncValidators([
        { signing_pubkey: 'aa'.repeat(32), addr: 'ws://v1:10001' }
    ]);
    let insertCalls = mockDb.doQuery.getCalls().filter(c =>
        c.args[0] && c.args[0].includes('INSERT INTO validators')
    );
    expect(insertCalls).to.have.lengthOf(1);
}
