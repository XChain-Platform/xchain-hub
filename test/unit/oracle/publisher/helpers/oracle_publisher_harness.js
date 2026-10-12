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
//
// Shared fixtures for the OraclePublisher queue and rank-and-balance suites.

const sinon      = require('sinon');
const proxyquire = require('proxyquire');


// Load OraclePublisher over a stubbed fs, so no suite touches the disk.
function loadModule() {
    const fsMock = {
        mkdirSync:     sinon.stub(),
        existsSync:    sinon.stub().returns(true),
        writeFileSync: sinon.stub(),
        openSync:      sinon.stub().returns(99),
        renameSync:    sinon.stub(),
        unlinkSync:    sinon.stub(),
        writeSync:     sinon.stub(),
        fsyncSync:     sinon.stub(),
        closeSync:     sinon.stub(),
        readFileSync:  sinon.stub().returns('')
    };
    const OraclePublisher = proxyquire('../../../../../src/oracle/publisher', {
        fs: fsMock,
        '../peers/encoder_client': function () { return null; }
    });
    return { fsMock, OraclePublisher };
}

function makeIdentity(pubkey) {
    return {
        getPubkeyHex: sinon.stub().returns(pubkey || 'aa'.repeat(32)),
        sign:         sinon.stub().returns('bb'.repeat(64))
    };
}

function makeHub(overrides) {
    return {
        p2pConfig:          overrides && overrides.p2pConfig ? overrides.p2pConfig : {},
        getIdentity:        sinon.stub().returns(makeIdentity()),
        capabilityRegistry: overrides && overrides.capabilityRegistry !== undefined
            ? overrides.capabilityRegistry : null,
        capabilitySnapshot: overrides && overrides.capabilitySnapshot !== undefined
            ? overrides.capabilitySnapshot : null,
        oracleConsensus:    overrides && overrides.oracleConsensus !== undefined
            ? overrides.oracleConsensus : null,
        ...(overrides || {})
    };
}

// Run one OraclePublisher suite, handing `bind` a freshly loaded module before each test.
function describeOraclePublisher(title, bind, registerTests) {
    describe('OraclePublisher', function () {
        beforeEach(function () {
            bind(loadModule());
        });

        afterEach(function () {
            sinon.restore();
        });

        describe(title, registerTests);
    });
}

module.exports = { makeIdentity, makeHub, describeOraclePublisher };
