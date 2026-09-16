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
//
// ROLLCALL size-statics dispatch, split out of rollcall_round_canonical.test.js:
// these cases patch RollcallRound statics rather than read the frozen vector, so
// they carry the class rebinding the conformance suite never needs.

const assert = require('assert');

const RollcallRound = require('../../../src/rollcall/round.js');
const wirePart      = require('../../../src/rollcall/round/wire.js');

// The size statics are reached as RollcallRound.<static>, inside maxPairsForGates
// and from the publish path, so a static reassigned on the class (a double, a patch)
// is the one they run, never a module-local copy the reassignment cannot reach.
describe('RollcallRound size statics dispatch through the class', function () {

    const NAMES = ['v1HeaderBytes', 'maxPairsForGates', 'chunkPairs'];
    const saved = {};
    // wire.js dispatches through the class round.js bound when last evaluated, and
    // a suite that proxyquires round.js rebinds it to a copy the require cache no
    // longer holds, so each case binds the class it reassigns and restores after.
    let boundBefore;
    beforeEach(function () {
        for (const n of NAMES) saved[n] = RollcallRound[n];
        boundBefore = wirePart.roundClass();
        wirePart.bindRoundClass(RollcallRound);
    });
    afterEach(function () {
        Object.assign(RollcallRound, saved);
        wirePart.bindRoundClass(boundBefore);
    });

    it('maxPairsForGates sizes the header through RollcallRound.v1HeaderBytes', function () {
        RollcallRound.v1HeaderBytes = () => RollcallRound.ACTION_DATA_CEILING - 5 * RollcallRound.BYTES_PER_PAIR;
        assert.strictEqual(RollcallRound.maxPairsForGates('any'), 5);
    });

    it('publishPairs caps and splits through RollcallRound.maxPairsForGates and chunkPairs', async function () {
        const calls = [], released = [];
        RollcallRound.maxPairsForGates = (gates) => { calls.push(['max', gates]); return 3; };
        RollcallRound.chunkPairs = (pairs, max) => { calls.push(['chunk', pairs.length, max]); return [pairs]; };
        const eng = Object.create(RollcallRound.prototype);
        Object.assign(eng, {
            _committed: new Set(), spendLogPath: 'unused', resolveSigner: () => ({}),
            spendGuard: { check: () => ({ ok: true }), reserve: () => 'token', release: (t) => released.push(t) },
            recordSpend: () => false   // the intent write fails, so nothing is ever sent
        });
        const real = console.error;
        console.error = () => {};
        let res;
        try { res = await eng.publishPairs({ epoch: 60, gates: 'G' }, 'c'.repeat(64), [{}, {}], 'sweep'); }
        finally { console.error = real; }
        assert.strictEqual(res, 'retry');
        assert.deepStrictEqual(calls, [['max', 'G'], ['chunk', 2, 3]]);
        assert.deepStrictEqual(released, ['token']);
    });
});
