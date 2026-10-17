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

const sinon = require('sinon');
const { expect } = require('chai');
const hubConfig = require('../../../src/config');
const { getLogger } = require('../../../src/observability');
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

// The env-backed config module as cfg: its getters read process.env, so it must not be a second env arm.
function configModuleSuite() {
    describe('the env-backed config module as cfg', function () {
        for (const network of ['mainnet', 'testnet', undefined]) {
            it(`pins the defaults on ${network || 'an unset network'}`, function () {
                if (network) process.env.HUB_NETWORK = network;
                process.env.ORACLE_ROUND_INTERVAL = '5000';
                process.env.ORACLE_SUBMISSION_WINDOW = '2000';
                expect(resolveRoundCadence(hubConfig)).to.deep.equal({ roundInterval: 600000, submissionWindow: 180000 });
            });
        }

        it('still honours the env on regtest', function () {
            process.env.HUB_NETWORK = 'regtest';
            process.env.ORACLE_ROUND_INTERVAL = '5000';
            process.env.ORACLE_SUBMISSION_WINDOW = '2000';
            expect(resolveRoundCadence(hubConfig)).to.deep.equal({ roundInterval: 5000, submissionWindow: 2000 });
        });
    });
}

// Off regtest a set value that would have moved the cadence is named, once per key.
function ignoredWarningSuite() {
    describe('the set-but-IGNORED warning', function () {
        let warn;
        beforeEach(function () { warn = sinon.stub(getLogger(), 'warn'); });
        afterEach(function () { warn.restore(); });

        it('names each divergent key off regtest', function () {
            process.env.HUB_NETWORK = 'mainnet';
            process.env.ORACLE_ROUND_INTERVAL = '5000';
            process.env.ORACLE_SUBMISSION_WINDOW = '2000';
            resolveRoundCadence({});
            const lines = warn.getCalls().map((c) => String(c.args[0]));
            expect(lines.filter((l) => /ORACLE_ROUND_INTERVAL=5000 is set but IGNORED on mainnet/.test(l))).to.have.length(1);
            expect(lines.filter((l) => /ORACLE_SUBMISSION_WINDOW=2000 is set but IGNORED on mainnet/.test(l))).to.have.length(1);
        });

        it('stays quiet for the default value, on regtest, and when unset', function () {
            process.env.HUB_NETWORK = 'testnet';
            process.env.ORACLE_ROUND_INTERVAL = '600000';
            resolveRoundCadence({});
            resetRoundCadence();
            process.env.HUB_NETWORK = 'regtest';
            process.env.ORACLE_ROUND_INTERVAL = '5000';
            resolveRoundCadence({});
            resetRoundCadence();
            delete process.env.ORACLE_ROUND_INTERVAL;
            process.env.HUB_NETWORK = 'mainnet';
            resolveRoundCadence({});
            expect(warn.getCalls().map((c) => String(c.args[0])).filter((l) => /IGNORED/.test(l))).to.deep.equal([]);
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
    configModuleSuite();
    ignoredWarningSuite();
    onceSuite();
});
