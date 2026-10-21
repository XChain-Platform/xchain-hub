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
const { ORACLE_EPOCH_START_PINS } = require('../../../src/constants');
const { resolveOracleEpochStart } = require('../../../src/oracle/oracle_epoch.js');

describe('ORACLE_EPOCH_START_PINS and the default resolver table', function () {
    it('is a frozen table of lowercase network keys to non-negative integer ms', function () {
        expect(Object.isFrozen(ORACLE_EPOCH_START_PINS)).to.equal(true);
        for (const [net, pin] of Object.entries(ORACLE_EPOCH_START_PINS)) {
            expect(net).to.equal(net.toLowerCase());
            expect(net).to.not.equal('regtest');
            expect(Number.isInteger(pin) && pin >= 0).to.equal(true);
        }
    });

    it('resolves every pinned network to its pin and warns on a mismatched env', function () {
        for (const [net, pin] of Object.entries(ORACLE_EPOCH_START_PINS)) {
            const warnings = [];
            expect(resolveOracleEpochStart(net, String(pin + 1), undefined, (m) => warnings.push(m))).to.equal(pin);
            expect(warnings).to.have.length(1);
            expect(resolveOracleEpochStart(net, String(pin), undefined, (m) => warnings.push(m))).to.equal(pin);
            expect(warnings).to.have.length(1);
        }
    });

    it('honours the env on an unpinned network when no table is passed', function () {
        const warnings = [];
        expect(resolveOracleEpochStart('unpinned-net', '7', undefined, (m) => warnings.push(m))).to.equal(7);
        expect(warnings).to.have.length(0);
    });
});
