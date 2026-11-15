'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The two round timers read from config must never resolve to a non-positive value: a negative
// finalization timeout evicts every round at once, and a negative leader timeout opens the
// fallback-proposer grace the moment a round is ready, letting a fallback usurp a live leader.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../helpers/mockHub');

const KNOBS = ['ORACLE_FINALIZATION_TIMEOUT', 'ORACLE_LEADER_TIMEOUT_MS'];

function construct() {
    const warnings = [];
    const logStub  = sinon.stub(console, 'log');
    const warnStub = sinon.stub(console, 'warn').callsFake(m => warnings.push(String(m)));
    let oc;
    try {
        oc = new OracleConsensus(createMockHub(), { getSubmissions: sinon.stub().returns(new Map()) });
    } finally { logStub.restore(); warnStub.restore(); }
    return { oc: oc, warnings: warnings.join('\n') };
}

describe('OracleConsensus: round timer config', function () {
    let saved;

    beforeEach(function () {
        saved = {};
        for (const k of KNOBS) { saved[k] = process.env[k]; delete process.env[k]; }
    });

    afterEach(function () {
        for (const k of KNOBS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });

    it('uses the defaults when both knobs are unset', function () {
        const r = construct();
        expect(r.oc.finalizationTimeout).to.equal(120000);
        expect(r.oc.leaderTimeout).to.equal(30000);
    });

    it('honors positive overrides', function () {
        process.env.ORACLE_FINALIZATION_TIMEOUT = '90000';
        process.env.ORACLE_LEADER_TIMEOUT_MS = '15000';
        const r = construct();
        expect(r.oc.finalizationTimeout).to.equal(90000);
        expect(r.oc.leaderTimeout).to.equal(15000);
    });

    it('falls back to the default leader grace on a negative value and warns', function () {
        process.env.ORACLE_LEADER_TIMEOUT_MS = '-1';
        const r = construct();
        expect(r.oc.leaderTimeout).to.equal(30000);
        expect(r.warnings).to.contain('ORACLE_LEADER_TIMEOUT_MS');
    });

    it('falls back to the default finalization window on a negative value and warns', function () {
        process.env.ORACLE_FINALIZATION_TIMEOUT = '-5000';
        const r = construct();
        expect(r.oc.finalizationTimeout).to.equal(120000);
        expect(r.warnings).to.contain('ORACLE_FINALIZATION_TIMEOUT');
    });

    it('falls back to the defaults on unparseable values', function () {
        process.env.ORACLE_FINALIZATION_TIMEOUT = 'soon';
        process.env.ORACLE_LEADER_TIMEOUT_MS = 'later';
        const r = construct();
        expect(r.oc.finalizationTimeout).to.equal(120000);
        expect(r.oc.leaderTimeout).to.equal(30000);
    });
});
