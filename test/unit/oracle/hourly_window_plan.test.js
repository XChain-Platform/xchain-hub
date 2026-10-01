/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const OracleBatchSigner = require('../../../src/oracle/batch_signer.js');
const scheduler = require('../../../src/oracle/publisher/scheduler.js');
const stats = require('../../../src/oracle/publisher/stats.js');
const { createWindowPlan, createHourlyWindowPlan } =
    require('../../../src/oracle/publisher/window_plan.js');

function switchedPlan() {
    return createWindowPlan({
        firstRound: 120,
        smallRounds: 2,
        largeRounds: 6,
        alignmentRounds: 6
    });
}

describe('hourly window plan boundaries', function() {
    it('keeps small windows below S and begins the first hourly window at S', function() {
        const plan = switchedPlan();

        assert.strictEqual(plan.windowOf(118), 59);
        assert.strictEqual(plan.windowOf(119), 59);
        assert.deepStrictEqual(plan.rangeOf(59), { first: 118, last: 119 });
        assert.strictEqual(plan.windowOf(120), 60);
        assert.strictEqual(plan.windowOf(125), 60);
        assert.deepStrictEqual(plan.rangeOf(60), { first: 120, last: 125 });
    });

    it('rearms the same hourly window after a restart in its middle', function() {
        const target = {
            windowPlan: switchedPlan(),
            _buffer: new Map([[123, { round: 123 }]]),
            _windows: new Map(),
            _assembledWindows: new Map()
        };
        target.windowIndexOf = scheduler.windowIndexOf;

        scheduler.rearmBufferedWindows.call(target);

        assert.deepStrictEqual(Array.from(target._windows.keys()), [60]);
        assert.deepStrictEqual(target.windowPlan.rangeOf(60), { first: 120, last: 125 });
    });

    it('elects successive leaders from the unique indices on either side of S', function() {
        const plan = switchedPlan();
        const publisherCount = 2;
        const before = plan.windowOf(119) % publisherCount;
        const after = plan.windowOf(120) % publisherCount;

        assert.strictEqual(before, 1);
        assert.strictEqual(after, 0);
        assert.notStrictEqual(plan.windowOf(119), plan.windowOf(120));
    });
});

function signerFixture() {
    const state = { broadcasts: 0, reasons: [] };
    const signer = new OracleBatchSigner({
        network: 'mainnet',
        p2pConfig: {}
    });
    signer.windowPlan = switchedPlan();
    signer.canonical = (first, last, anchor, rounds) =>
        JSON.stringify({ first, last, anchor, rounds });
    signer.refuse = (first, last, reason) => {
        signer.stats.batchSignRefusals++;
        state.reasons.push(reason);
    };
    signer.identity = { sign: () => 'signature' };
    signer.peerManager = { broadcast: () => state.broadcasts++ };
    return { signer, state };
}

function propose(signer, proposedRounds, mineRounds) {
    signer.signIfReproduced({
        first_round: 119,
        last_round: 120,
        btc_block_height: 5000,
        rounds: proposedRounds
    }, 119, 120, mineRounds, 5000, 'publisher');
}

function assertRefused() {
    const { signer, state } = signerFixture();
    const rounds = [{ round: 119 }, { round: 120 }];

    propose(signer, rounds, rounds);

    assert.strictEqual(signer.getStats().batchSignRefusals, 1);
    assert.strictEqual(state.broadcasts, 0);
    assert.deepStrictEqual(state.reasons, ['range straddles the hourly window activation']);
}

function assertExistingRefusalWins() {
    const { signer, state } = signerFixture();
    signer.describeMismatch = () => 'existing mismatch';

    propose(signer, [{ round: 119 }], [{ round: 120 }]);

    assert.deepStrictEqual(state.reasons, [
        'proposal does not match this hub\'s own finalized rounds (existing mismatch)'
    ]);
}

describe('hourly window plan signer refusals', function() {
    it('refuses a reproduced signer proposal whose range straddles S', function() {
        assertRefused();
    });

    it('keeps an established refusal reason ahead of the hourly boundary', function() {
        assertExistingRefusalWins();
    });

});

describe('hourly window plan configuration', function() {
    it('reports the window size in force for the oracle current round', function() {
        const target = {
            hub: { oracle: { getCurrentRound: () => 123 } },
            windowPlan: switchedPlan(),
            batchWindowRounds: 2,
            _lastRankState: null
        };
        target.windowRoundsInForce = stats.windowRoundsInForce;

        assert.strictEqual(target.windowRoundsInForce(), 6);
        target.hub.oracle.getCurrentRound = () => 119;
        assert.strictEqual(target.windowRoundsInForce(), 2);
    });

    it('derives the armed regtest window from the hourly pinned age bound', function() {
        const hourly = createHourlyWindowPlan({
            network: 'regtest',
            smallRounds: 2,
            roundIntervalMs: 600000,
            graceMs: 300000,
            landingReserveMs: 300000
        });

        assert.strictEqual(hourly.firstRound, 0);
        assert.strictEqual(hourly.largeRounds, 6);
        assert.strictEqual(hourly.hourlyMaxPriceAgeMs, 4500000);
    });

    it('keeps legacy windows when the publisher has no oracle round source', function() {
        const hourly = createHourlyWindowPlan({
            network: 'regtest',
            enabled: false,
            smallRounds: 2,
            roundIntervalMs: 600000,
            graceMs: 300000,
            landingReserveMs: 300000
        });

        assert.strictEqual(hourly.firstRound, undefined);
        assert.deepStrictEqual(hourly.plan.rangeOf(0), { first: 0, last: 1 });
    });

    it('requires S to align to six even when the hourly age bound is tighter', function() {
        assert.throws(() => createWindowPlan({
            firstRound: 10,
            smallRounds: 2,
            largeRounds: 2,
            alignmentRounds: 6
        }), RangeError);
    });
});
