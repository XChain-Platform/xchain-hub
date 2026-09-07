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

// CHECKPOINT_INTERVAL_BLOCKS has two readers, StateCheckpointEngine's cadence latch
// and StateAnchorPublisher's anchor-eligibility divisor, and they must resolve the
// SAME step for any operator value: a divisor the engine is not using selects every
// checkpoint or none. The other cadence knobs are guarded here too, because a NaN
// pollMs makes setInterval clamp to ~1ms and storm.

const { expect } = require('chai');
const { resolveCheckpointIntervalBlocks } = require('../../src/lib/checkpoint_cadence.js');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine.js');
const StateAnchorPublisher  = require('../../src/StateAnchorPublisher.js');

const KNOBS = ['CHECKPOINT_INTERVAL_BLOCKS', 'CHECKPOINT_POLL_MS',
               'CHECKPOINT_ROUND_TIMEOUT_MS', 'CHECKPOINT_CONFIRMATIONS'];

function makeHub(p2pConfig) {
    return { db: { doQuery: async () => [] }, p2pConfig: p2pConfig || {} };
}

describe('checkpoint cadence config guards', function () {
    let saved = {};
    let warn;
    beforeEach(function () {
        for (let k of KNOBS) { saved[k] = process.env[k]; delete process.env[k]; }
        warn = console.warn;
        console.warn = () => {};
    });
    afterEach(function () {
        for (let k of KNOBS) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
        console.warn = warn;
    });

    describe('resolveCheckpointIntervalBlocks()', function () {
        it('defaults to 6 with nothing configured', function () {
            expect(resolveCheckpointIntervalBlocks({})).to.equal(6);
        });

        it('honours a positive operator value from env and from p2pConfig', function () {
            expect(resolveCheckpointIntervalBlocks({ CHECKPOINT_INTERVAL_BLOCKS: '12' })).to.equal(12);
            process.env.CHECKPOINT_INTERVAL_BLOCKS = '9';
            expect(resolveCheckpointIntervalBlocks({ CHECKPOINT_INTERVAL_BLOCKS: '12' })).to.equal(9);
        });

        it('falls back to 6 on a malformed, zero or negative value', function () {
            for (let bad of ['abc', '0', '-3', '']) {
                expect(resolveCheckpointIntervalBlocks({ CHECKPOINT_INTERVAL_BLOCKS: bad }), bad).to.equal(6);
            }
        });
    });

    // The drift the publisher's own comment claims cannot happen. Before both readers
    // shared one resolver, 'abc' gave the engine NaN against the publisher's 6, and
    // '-3' gave the engine -3 against the publisher's floor of 1.
    describe('engine and anchor publisher resolve the same step', function () {
        for (let raw of ['6', '12', 'abc', '0', '-3']) {
            it('agrees on CHECKPOINT_INTERVAL_BLOCKS=' + JSON.stringify(raw), function () {
                process.env.CHECKPOINT_INTERVAL_BLOCKS = raw;
                let engine    = new StateCheckpointEngine(makeHub());
                let publisher = new StateAnchorPublisher(makeHub());
                expect(engine.intervalBlocks).to.equal(publisher.checkpointIntervalBlocks);
                expect(engine.intervalBlocks).to.be.a('number').and.to.be.above(0);
            });
        }
    });

    describe('StateCheckpointEngine cadence knobs', function () {
        it('never leaves pollMs or roundTimeoutMs NaN or non-positive', function () {
            for (let bad of ['abc', '0', '-1']) {
                process.env.CHECKPOINT_POLL_MS = bad;
                process.env.CHECKPOINT_ROUND_TIMEOUT_MS = bad;
                let eng = new StateCheckpointEngine(makeHub());
                expect(eng.pollMs, 'pollMs for ' + bad).to.equal(60000);
                expect(eng.roundTimeoutMs, 'roundTimeoutMs for ' + bad).to.equal(60000);
            }
        });

        it('keeps CHECKPOINT_CONFIRMATIONS=0 (checkpoint the tip) but rejects NaN and negatives', function () {
            let eng = new StateCheckpointEngine(makeHub({ CHECKPOINT_CONFIRMATIONS: '0' }));
            expect(eng.confirmations).to.equal(0);
            expect(new StateCheckpointEngine(makeHub({ CHECKPOINT_CONFIRMATIONS: 'abc' })).confirmations).to.equal(6);
            expect(new StateCheckpointEngine(makeHub({ CHECKPOINT_CONFIRMATIONS: '-2' })).confirmations).to.equal(6);
        });
    });
});
