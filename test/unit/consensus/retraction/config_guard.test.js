// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// RetractionConsensus timing knobs: an operator value of 0, a negative number or
// a non-number falls back to the default instead of storming SIGN_REQs, timing
// every round out at once, or pruning every intent before a co-sign can see it.

const assert = require('assert');
const RetractionConsensus = require('../../../../src/consensus/retraction.js');

const KEYS = ['RETRACT_ROUND_TIMEOUT_MS', 'RETRACT_SIGN_RETRY_MS', 'RETRACT_INTENT_TTL_MS'];

function makeConsensus(p2p){
    return new RetractionConsensus({ db: {}, network: 'regtest', p2pConfig: p2p });
}

describe('RetractionConsensus timing config guard', function () {
    let saved = {};
    beforeEach(function () {
        // Read through the p2p config only: an inherited env value would mask the case under test.
        for (let k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(function () {
        for (let k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    for (let bad of ['0', '-5', 'abc', -5]) {
        it('falls back to every default for ' + JSON.stringify(bad), function () {
            let c = makeConsensus({ RETRACT_ROUND_TIMEOUT_MS: bad, RETRACT_SIGN_RETRY_MS: bad, RETRACT_INTENT_TTL_MS: bad });
            assert.strictEqual(c.roundTimeoutMs, 180000);
            assert.strictEqual(c.retrySignReqMs, 15000);
            assert.strictEqual(c.intentTtlMs, 3600000);
        });
    }

    it('keeps valid operator values', function () {
        let c = makeConsensus({ RETRACT_ROUND_TIMEOUT_MS: 40, RETRACT_SIGN_RETRY_MS: '15', RETRACT_INTENT_TTL_MS: '250' });
        assert.strictEqual(c.roundTimeoutMs, 40);
        assert.strictEqual(c.retrySignReqMs, 15);
        assert.strictEqual(c.intentTtlMs, 250);
    });

    it('keeps a fresh intent through pruneIntents when the TTL knob is negative', function () {
        let c = makeConsensus({ RETRACT_INTENT_TTL_MS: '-5' });
        c.localIntents.set('intent-key', Date.now());
        c.pruneIntents();
        assert.ok(c.localIntents.has('intent-key'), 'a negative TTL must not prune an intent the co-sign path still needs');
    });
});
