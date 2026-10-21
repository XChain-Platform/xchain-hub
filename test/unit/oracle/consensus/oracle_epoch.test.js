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
const { resolveOracleEpochStart } = require('../../../../src/oracle/oracle_epoch.js');

const PINS = { testnet: 1700000000000 };

function run(network, envRaw, pins) {
    const warnings = [];
    const value = resolveOracleEpochStart(network, envRaw, pins, (s) => warnings.push(s));
    return { value, warnings };
}

describe('resolveOracleEpochStart', function () {
    describe('a network the pin table names', function () {
        it('returns the pin and stays silent when the env matches', function () {
            const r = run('testnet', String(PINS.testnet), PINS);
            expect(r.value).to.equal(PINS.testnet);
            expect(r.warnings).to.have.length(0);
        });

        it('returns the pin and warns once when the env differs', function () {
            const r = run('testnet', '5', PINS);
            expect(r.value).to.equal(PINS.testnet);
            expect(r.warnings).to.have.length(1);
            expect(r.warnings[0]).to.include('ORACLE_EPOCH_START=5').and.include('testnet').and.include(String(PINS.testnet));
        });

        it('returns the pin and stays silent when the env is absent', function () {
            for (const absent of [undefined, null, '']) {
                const r = run('testnet', absent, PINS);
                expect(r.value).to.equal(PINS.testnet);
                expect(r.warnings).to.have.length(0);
            }
        });
    });

    describe('networks the pin table does not govern', function () {
        it('honours the env on regtest even when the table names it', function () {
            const r = run('regtest', '5', { regtest: 9 });
            expect(r.value).to.equal(5);
            expect(r.warnings).to.have.length(0);
        });

        it('honours the env on mainnet when the table has no entry for it', function () {
            const r = run('mainnet', '5', PINS);
            expect(r.value).to.equal(5);
            expect(r.warnings).to.have.length(0);
        });

        it('honours the env on every network when the table is empty', function () {
            for (const net of ['regtest', 'testnet', 'mainnet']) {
                const r = run(net, '5', {});
                expect(r.value).to.equal(5);
                expect(r.warnings).to.have.length(0);
            }
        });
    });

    it('parses the env as parseInt does today', function () {
        expect(run('mainnet', '12abc', {}).value).to.equal(12);
        expect(run('mainnet', undefined, {}).value).to.be.NaN;
    });
});
