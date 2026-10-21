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
const { ORACLE_EPOCH_START_PINS } = require('../../../../src/constants');
const { resolveOracleEpochStart } = require('../../../../src/oracle/oracle_epoch.js');

// The epoch every testnet validator runs today; the pin must match it exactly.
const TESTNET_EPOCH = 1787875200000;

function run(network, envRaw) {
    const warnings = [];
    const value = resolveOracleEpochStart(network, envRaw, undefined, (s) => warnings.push(s));
    return { value, warnings };
}

describe('ORACLE_EPOCH_START_PINS through the default resolver table', function () {
    it('is a frozen table of lowercase network keys with no regtest or mainnet entry', function () {
        expect(Object.isFrozen(ORACLE_EPOCH_START_PINS)).to.equal(true);
        expect(ORACLE_EPOCH_START_PINS).to.not.have.property('regtest');
        expect(ORACLE_EPOCH_START_PINS).to.not.have.property('mainnet');
        for (const [net, pin] of Object.entries(ORACLE_EPOCH_START_PINS)) {
            expect(net).to.equal(net.toLowerCase());
            expect(Number.isSafeInteger(pin) && pin >= 0).to.equal(true);
        }
    });

    it('pins testnet to the epoch the testnet fleet runs', function () {
        expect(ORACLE_EPOCH_START_PINS.testnet).to.equal(TESTNET_EPOCH);
        expect(run('testnet', undefined).value).to.equal(ORACLE_EPOCH_START_PINS.testnet);
    });

    it('returns the testnet pin silently when the env matches', function () {
        const r = run('testnet', String(TESTNET_EPOCH));
        expect(r.value).to.equal(TESTNET_EPOCH);
        expect(r.warnings).to.have.length(0);
    });

    it('returns the testnet pin and warns once when the env differs', function () {
        const r = run('testnet', '1700000000000');
        expect(r.value).to.equal(TESTNET_EPOCH);
        expect(r.warnings).to.have.length(1);
        expect(r.warnings[0]).to.include('ORACLE_EPOCH_START=1700000000000').and.include('testnet');
    });

    it('returns the testnet pin silently when the env is absent', function () {
        for (const absent of [undefined, null, '']) {
            const r = run('testnet', absent);
            expect(r.value).to.equal(TESTNET_EPOCH);
            expect(r.warnings).to.have.length(0);
        }
    });

    it('honours the env on regtest and mainnet', function () {
        for (const net of ['regtest', 'mainnet']) {
            const r = run(net, '5');
            expect(r.value).to.equal(5);
            expect(r.warnings).to.have.length(0);
        }
    });
});
