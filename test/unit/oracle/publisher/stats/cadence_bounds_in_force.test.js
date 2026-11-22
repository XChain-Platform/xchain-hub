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

const {
    sinon,
    expect,
    makePublisher,
    cleanupPublisherBatch
} = require('../batch/oracle_publisher_batch.test.js');
const { createWindowPlan } = require('../../../../../src/oracle/publisher/window_plan');
const { getLogger } = require('../../../../../src/observability');

// The cadence line and the status block name the ceiling and staleness bound the
// window in force was sized against: the hourly window against the hourly bound,
// the small window against the pre-activation bound. Reading the wrong pair makes a
// correctly sized rail look overrun.

let lines;

function inForce(h, firstRound, round) {
    h.p.windowPlan = createWindowPlan({ firstRound: firstRound, smallRounds: 2, largeRounds: 6, alignmentRounds: 6 });
    h.hub.getOracle = () => ({ getCurrentRound: () => round });
    h.p.logBatchCadence();
    return lines.find(l => l.indexOf('PRICE batch cadence') !== -1);
}

function boundSeconds(line) {
    return Number(line.match(/against a (\d+)s fee-price staleness bound/)[1]);
}

const hourlyAfterActivation = function () {
    let h = makePublisher({ fleetCadence: true });
    let line = inForce(h, 0, 7);

    expect(boundSeconds(line)).to.equal(Math.round(h.p.oracleHourlyMaxPriceAgeMs / 1000));
    expect(boundSeconds(line)).to.not.equal(Math.round(h.p.oracleMaxPriceAgeMs / 1000));
    expect(line).to.contain(', ceiling ' + h.p.oracleHourlyWindowRoundsCeiling + ';');
    expect(h.p.getStats().batchWindowRoundsCeiling).to.equal(h.p.oracleHourlyWindowRoundsCeiling);
};

const smallBeforeActivation = function () {
    let h = makePublisher({ fleetCadence: true });
    let line = inForce(h, 12, 7);

    expect(boundSeconds(line)).to.equal(Math.round(h.p.oracleMaxPriceAgeMs / 1000));
    expect(line).to.contain(', ceiling ' + h.p.batchWindowRoundsCeiling + ';');
    expect(h.p.getStats().batchWindowRoundsCeiling).to.equal(h.p.batchWindowRoundsCeiling);
};

function registerCadenceBounds() {
    beforeEach(function () {
        lines = [];
        sinon.stub(getLogger(), 'info').callsFake((msg) => lines.push(String(msg)));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    it('logs the hourly ceiling and bound once the hourly window is in force', hourlyAfterActivation);
    it('logs the pre-activation ceiling and bound before the hourly window', smallBeforeActivation);
}

describe('OraclePublisher cadence bounds in force', registerCadenceBounds);
