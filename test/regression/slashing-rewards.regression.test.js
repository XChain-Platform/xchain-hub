'use strict';

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
 **********************************************************************
 * Slashing safety + reward-split regression guards.
 *
 * Slashing is the highest-consequence validator action: wrongly slashing an
 * HONEST operator burns real stake for a non-offense. These guards pin the
 * safety boundary (honest-within-threshold is never slashed; only genuine
 * offenders are) and the reward arithmetic (equal split, no leakage).
 *
 * Pure: SlashDetector / RewardTracker are driven with stubbed persistence so
 * no DB / network is needed (runs in CI on every change). The DB write path is
 * covered separately at L2 (xchain-e2e multiHubRewards).
 *
 * Spec: claude/reports/specs/2026-05-30_validator-test-spec.md §2 (#10).
 */

const assert = require('assert');
const SlashDetector = require('../../src/SlashDetector');
const RewardTracker = require('../../src/RewardTracker');

const PK = (c) => c.repeat(64);   // 64-hex pubkey

function makeSlashDetector(threshold = '0.05', missed = '3') {
    const hub = {
        p2pConfig: { SLASH_DEVIATION_THRESHOLD: threshold, SLASH_MISSED_ROUNDS_THRESHOLD: missed },
        db: null,
        getPeerManager: () => ({ validatorPubkeys: new Map() })
    };
    const sd = new SlashDetector(hub);
    sd._resolveValidatorPubkey = (sender) => sender;   // sender IS the pubkey in these tests
    const slashed = [];
    sd._recordSlashProposal = async (pubkey, offenseType, round) => { slashed.push({ pubkey, offenseType, round }); };
    return { sd, slashed };
}

describe('Regression: slashing safety + reward split', function () {

    describe('price-deviation slashing', function () {
        const FINAL = [{ coinPair: 'BTC/USD', price: '60000' }];

        it('honest validators within threshold are NOT slashed @regression-p0', async function () {
            const { sd, slashed } = makeSlashDetector('0.05');
            const subs = new Map([
                [PK('a'), { prices: [{ coinPair: 'BTC/USD', price: '60000' }] }],  // 0%
                [PK('b'), { prices: [{ coinPair: 'BTC/USD', price: '62000' }] }],  // 3.33%
                [PK('c'), { prices: [{ coinPair: 'BTC/USD', price: '58500' }] }]   // 2.5%
            ]);
            await sd._checkDeviations(1, subs, FINAL);
            assert.strictEqual(slashed.length, 0, 'honest validators slashed: ' + JSON.stringify(slashed));
        });

        it('a validator beyond threshold IS slashed for price_deviation @regression-p0', async function () {
            const { sd, slashed } = makeSlashDetector('0.05');
            const subs = new Map([
                [PK('a'), { prices: [{ coinPair: 'BTC/USD', price: '60000' }] }],  // honest
                [PK('d'), { prices: [{ coinPair: 'BTC/USD', price: '66000' }] }]   // 10% > 5%
            ]);
            await sd._checkDeviations(1, subs, FINAL);
            assert.strictEqual(slashed.length, 1);
            assert.strictEqual(slashed[0].pubkey, PK('d'));
            assert.strictEqual(slashed[0].offenseType, 'price_deviation');
        });

        it('a deviation exactly AT the threshold is NOT slashed (strict >) @regression-p1', async function () {
            const { sd, slashed } = makeSlashDetector('0.05');
            // 63000 vs 60000 = exactly 5.00%
            const subs = new Map([[PK('e'), { prices: [{ coinPair: 'BTC/USD', price: '63000' }] }]]);
            await sd._checkDeviations(1, subs, FINAL);
            assert.strictEqual(slashed.length, 0, 'boundary deviation was wrongly slashed');
        });
    });

    describe('non-participation slashing', function () {
        it('slashes only at the missed-rounds threshold; participation resets the counter @regression-p0', async function () {
            const { sd, slashed } = makeSlashDetector('0.05', '3');   // 3 consecutive misses
            const all = [{ pubkey: PK('a') }, { pubkey: PK('b') }];

            await sd._checkParticipation(1, [PK('b')], all);   // a misses (1)
            await sd._checkParticipation(2, [PK('b')], all);   // a misses (2)
            assert.strictEqual(slashed.length, 0, 'slashed before threshold');

            await sd._checkParticipation(3, [PK('b')], all);   // a misses (3 == threshold) → slash
            assert.strictEqual(slashed.length, 1);
            assert.strictEqual(slashed[0].pubkey, PK('a'));
            assert.strictEqual(slashed[0].offenseType, 'non_participation');

            await sd._checkParticipation(4, [PK('a'), PK('b')], all);  // a returns → counter reset
            await sd._checkParticipation(5, [PK('b')], all);           // a misses (back to 1)
            assert.strictEqual(slashed.length, 1, 'counter did not reset — validator re-slashed too soon');
        });
    });

    describe('reward split', function () {
        function makeRewardTracker(perRound) {
            const writes = [];
            const hub = { p2pConfig: { ORACLE_REWARD_PER_ROUND: perRound }, db: { doQuery: async (q, p) => { writes.push(p); } } };
            const rt = new RewardTracker(hub);
            rt._pushRewardsToBtcIndexer = async () => {};   // no network
            return { rt, writes };
        }

        it('splits the per-round reward equally among valid participants @regression-p0', async function () {
            const { rt, writes } = makeRewardTracker('10.00000000');
            await rt.distributeRewards(7, [PK('a'), PK('b'), PK('c'), PK('d')]);
            assert.strictEqual(writes.length, 4, 'expected one reward row per participant');
            for (const w of writes) assert.strictEqual(w[2], '2.50000000', '10/4 should be 2.5 each');
            assert.deepStrictEqual(writes.map((w) => w[0]).sort(),
                [PK('a'), PK('b'), PK('c'), PK('d')].sort());
        });

        it('ignores malformed (non-64-hex) participant ids in the split @regression-p1', async function () {
            const { rt, writes } = makeRewardTracker('9.00000000');
            await rt.distributeRewards(8, [PK('a'), 'not-a-pubkey', PK('b'), PK('c')]);
            assert.strictEqual(writes.length, 3, 'malformed id should be dropped, not rewarded');
            for (const w of writes) assert.strictEqual(w[2], '3.00000000', '9/3 should be 3 each');
        });
    });
});
