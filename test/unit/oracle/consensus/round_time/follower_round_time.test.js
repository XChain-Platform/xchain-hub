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
const proxyquire = require('proxyquire').noPreserveCache();
const { makeProposeTimeHarness } = require('./helpers/propose_time_harness');

const EPOCH_START = 1704067200000;
const ROUND_INTERVAL = 10 * 60 * 1000;
const ROUND = 12;
const NOW_MS = EPOCH_START + ROUND * ROUND_INTERVAL + 60 * 1000;
const NOMINAL_TIME = Math.floor((EPOCH_START + ROUND * ROUND_INTERVAL) / 1000);

function createHarness(gateActive, overrides = {}) {
    let harness = makeProposeTimeHarness({
        network:       'mainnet',
        round:         overrides.round === undefined ? ROUND : overrides.round,
        epochStart:    overrides.epochStart === undefined ? EPOCH_START : overrides.epochStart,
        roundInterval: ROUND_INTERVAL,
        nowMs:         overrides.nowMs === undefined ? NOW_MS : overrides.nowMs
    });
    let methods = proxyquire('../../../../../src/oracle/consensus/propose/handle_propose', {
        '../round_time/round_time_gate.js': {
            roundTimeGateActive: () => gateActive
        }
    });
    harness.oc.handlePropose = methods.handlePropose;
    return harness;
}

let harness;

afterEach(function () {
    if (harness) harness.restore();
    harness = null;
});

describe('OracleConsensus active follower PROPOSE round time', function () {
    it('accepts and signs the nominal timestamp when the gate is active', async function () {
        harness = createHarness(true);

        let result = await harness.deliver({ btcBlockTime: NOMINAL_TIME });
        let pending = harness.oc.pendingRounds.get(ROUND);

        expect(result.reachedSnapshot).to.equal(true);
        expect(result.pendingTime).to.equal(NOMINAL_TIME);
        expect(pending.signatures.has(harness.oc.selfPubkey())).to.equal(true);
    });

    it('accepts an absent timestamp and signs the nominal timestamp when the gate is active', async function () {
        harness = createHarness(true);

        let result = await harness.deliver({ omitTime: true });
        let pending = harness.oc.pendingRounds.get(ROUND);

        expect(result.reachedSnapshot).to.equal(true);
        expect(result.pendingTime).to.equal(NOMINAL_TIME);
        expect(pending.signatures.has(harness.oc.selfPubkey())).to.equal(true);
    });

    const offsets = [
        ['one second', 1],
        ['one hour and 43 minutes', 60 * 60 + 43 * 60]
    ];
    for (const [label, offset] of offsets) {
        it('drops a timestamp ' + label + ' off before snapshot locking', async function () {
            harness = createHarness(true);

            let result = await harness.deliver({ btcBlockTime: NOMINAL_TIME + offset });

            expect(result.reachedSnapshot).to.equal(false);
            expect(result.pendingTime).to.equal(null);
        });
    }
});

describe('OracleConsensus follower PROPOSE round time compatibility', function () {
    it('accepts an arbitrary supplied timestamp while the gate is inactive', async function () {
        harness = createHarness(false);
        let arbitraryTime = NOMINAL_TIME + 60 * 60 + 43 * 60;

        let result = await harness.deliver({ btcBlockTime: arbitraryTime });

        expect(result.reachedSnapshot).to.equal(true);
        expect(result.pendingTime).to.equal(arbitraryTime);
    });

    it('keeps a zero nominal timestamp instead of substituting the follower clock', async function () {
        harness = createHarness(true, { round: 0, epochStart: 0, nowMs: 60 * 1000 });

        let result = await harness.deliver({ btcBlockTime: 0 });

        expect(result.reachedSnapshot).to.equal(true);
        expect(result.pendingTime).to.equal(0);
    });
});
