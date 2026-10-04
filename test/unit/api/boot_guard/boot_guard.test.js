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

const { expect } = require('chai');
const { refuseInvalidNetwork } = require('../../../../src/api/boot_guard.js');

let originalExit;
let exits;
let errors;

function recordExit(code) {
    exits.push(code);
}

function recordError(message) {
    errors.push(message);
}

function setUpExitStub() {
    originalExit = process.exit;
    exits = [];
    errors = [];
    process.exit = recordExit;
}

function restoreExit() {
    process.exit = originalExit;
}

function runGuard(options = {}) {
    const { validator, epochStart, network } = {
        validator: 'validator-address', epochStart: 1, network: undefined, ...options
    };
    refuseInvalidNetwork({
        logger: { error: recordError },
        hubConfig: { ORACLE_EPOCH_START: epochStart },
        P2P_VALIDATOR_ADDR: validator,
        HUB_NETWORK: network
    });
}

function testMissingEpochStart() {
    runGuard({ epochStart: undefined, network: 'testnet' });
    expect(exits).to.deep.equal([1]);
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.contain('ORACLE_EPOCH_START');
}

function testUnsetValidatorNetwork() {
    runGuard();
    expect(exits).to.deep.equal([1]);
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.contain('HUB_NETWORK');
}

function testInvalidValidatorNetwork() {
    runGuard({ network: 'bogus' });
    expect(exits).to.deep.equal([1]);
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.contain('HUB_NETWORK');
}

function testValidValidatorNetwork() {
    runGuard({ network: 'testnet' });
    expect(exits).to.deep.equal([]);
    expect(errors).to.deep.equal([]);
}

function testValidStandaloneNetworks() {
    runGuard({ validator: '', network: undefined });
    runGuard({ validator: '', network: 'regtest' });
    expect(exits).to.deep.equal([]);
    expect(errors).to.deep.equal([]);
}

function testInvalidStandaloneNetwork() {
    runGuard({ validator: '', network: 'bogus' });
    expect(exits).to.deep.equal([1]);
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.contain('HUB_NETWORK');
}

function registerTests() {
    beforeEach(setUpExitStub);
    afterEach(restoreExit);
    it('refuses a validator with no oracle epoch start', testMissingEpochStart);
    it('refuses a validator with HUB_NETWORK unset', testUnsetValidatorNetwork);
    it('refuses a validator with an invalid HUB_NETWORK', testInvalidValidatorNetwork);
    it('accepts a validator on testnet with an oracle epoch start', testValidValidatorNetwork);
    it('accepts a standalone hub with HUB_NETWORK unset or regtest', testValidStandaloneNetworks);
    it('refuses a standalone hub with an invalid HUB_NETWORK', testInvalidStandaloneNetwork);
}

describe('refuseInvalidNetwork()', registerTests);
