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
const { resolveRoundCadence, resetRoundCadence } = require('../../../src/oracle/round_cadence.js');

const ENV = ['HUB_NETWORK', 'ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW'];

function withCleanEnv(saved) {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    resetRoundCadence();
}

function restoreEnv(saved) {
    for (const k of ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
    resetRoundCadence();
}

function defaultsSuite() {
    describe('defaults and config', function () {
        it('falls back to 10 min / 3 min', function () {
            expect(resolveRoundCadence({})).to.deep.equal({ roundInterval: 600000, submissionWindow: 180000 });
        });

        it('uses p2pConfig values', function () {
            const r = resolveRoundCadence({ ORACLE_ROUND_INTERVAL: 1000, ORACLE_SUBMISSION_WINDOW: 400 });
            expect(r).to.deep.equal({ roundInterval: 1000, submissionWindow: 400 });
        });
    });
}

function envSuite() {
    describe('env override', function () {
        it('is ignored off regtest', function () {
            process.env.HUB_NETWORK = 'mainnet';
            process.env.ORACLE_ROUND_INTERVAL = '5000';
            expect(resolveRoundCadence({}).roundInterval).to.equal(600000);
        });

        it('wins on regtest', function () {
            process.env.HUB_NETWORK = 'regtest';
            process.env.ORACLE_ROUND_INTERVAL = '5000';
            process.env.ORACLE_SUBMISSION_WINDOW = '2000';
            expect(resolveRoundCadence({})).to.deep.equal({ roundInterval: 5000, submissionWindow: 2000 });
        });

        it('rejects a malformed regtest value', function () {
            process.env.HUB_NETWORK = 'regtest';
            process.env.ORACLE_ROUND_INTERVAL = '-4';
            expect(resolveRoundCadence({}).roundInterval).to.equal(600000);
        });
    });
}

function onceSuite() {
    describe('once per process', function () {
        it('returns the first resolution until reset', function () {
            const first = resolveRoundCadence({ ORACLE_ROUND_INTERVAL: 1000 });
            expect(resolveRoundCadence({ ORACLE_ROUND_INTERVAL: 2000 })).to.equal(first);
            resetRoundCadence();
            expect(resolveRoundCadence({ ORACLE_ROUND_INTERVAL: 2000 }).roundInterval).to.equal(2000);
        });
    });
}

describe('oracle round cadence resolver', function () {
    const saved = {};
    beforeEach(function () { withCleanEnv(saved); });
    afterEach(function () { restoreEnv(saved); });
    defaultsSuite();
    envSuite();
    onceSuite();
});
