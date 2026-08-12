/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available - contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/XchainPriceActivation.test.js
 *
 * XCHAIN/USD round-composition gate.
 *
 * The gate decides one thing - does this round carry the derived pair - and both
 * ways of getting it wrong are federation-scale. Composing too early puts a pair in
 * a signed round that peers reject wholesale, taking the other 36 pairs down with
 * it; composing inconsistently across hubs strands followers with no local
 * submission for a pair that has no finalized history either, which is exactly the
 * state the unverifiable-pair gate withholds co-sign on.
 */

'use strict';

const { expect } = require('chai');

const {
    XCHAIN_PRICE_ACTIVATION,
    isXchainPriceActive,
    roundStartSeconds,
    widenPrecedesComposition,
} = require('../../src/xchain_price_activation.js');
const { PRICE_PAIR_WIDEN_ACTIVATION } = require('../../src/price_pair_activation.js');

describe('XCHAIN/USD composition gate @regression', function () {

    describe('the activation map', function () {
        it('is UNARMED on mainnet, at a sentinel rather than a schedule', function () {
            // D6 (the pre-launch arming instant) is an open operator decision. This
            // asserting a far-future value is the point: nothing composes the pair on
            // mainnet until someone deliberately edits it.
            expect(XCHAIN_PRICE_ACTIVATION.mainnet).to.equal(9999999999);
        });

        it('is genesis-on for testnet and regtest', function () {
            // §8: genesis-on for the test networks, so every venue and every suite
            // exercises the composed pair rather than a special-cased absence.
            expect(XCHAIN_PRICE_ACTIVATION.testnet).to.equal(0);
            expect(XCHAIN_PRICE_ACTIVATION.regtest).to.equal(0);
        });

        it('covers exactly the networks the wire-format gate covers', function () {
            // A network present in one map and missing from the other fails closed in
            // one place and not the other, which is the shape of a one-sided rollout.
            expect(Object.keys(XCHAIN_PRICE_ACTIVATION).sort())
                .to.deep.equal(Object.keys(PRICE_PAIR_WIDEN_ACTIVATION).sort());
        });
    });

    describe('the rollout ordering invariant', function () {
        it('widens the wire format at or before composition begins, on every network', function () {
            // THE invariant. Reversed on any network, a hub composes a pair the on-chain
            // PRICE v0 parser still rejects as malformed, and every round carrying it
            // dies at ingest - stalling all 36 pairs and failing fee validation on every
            // chain 1800s later.
            expect(widenPrecedesComposition()).to.equal(true);
        });

        it('states the invariant per network, so a bad edit names the network', function () {
            for (const net of Object.keys(XCHAIN_PRICE_ACTIVATION)) {
                expect(PRICE_PAIR_WIDEN_ACTIVATION[net],
                    'widen must not postdate composition on ' + net)
                    .to.be.at.most(XCHAIN_PRICE_ACTIVATION[net]);
            }
        });
    });

    describe('isXchainPriceActive()', function () {
        it('is inclusive at the threshold instant', function () {
            expect(isXchainPriceActive(9999999999, 'mainnet')).to.equal(true);
            expect(isXchainPriceActive(9999999998, 'mainnet')).to.equal(false);
        });

        it('is active from genesis on the test networks', function () {
            expect(isXchainPriceActive(0, 'regtest')).to.equal(true);
            expect(isXchainPriceActive(1750000000, 'testnet')).to.equal(true);
        });

        it('fails CLOSED on an unrecognized network', function () {
            // Omitting the pair costs one round of carry-forward that the next round
            // repairs. Including it when it was not due kills the whole round.
            expect(isXchainPriceActive(1750000000, 'signet')).to.equal(false);
            expect(isXchainPriceActive(1750000000, undefined)).to.equal(false);
        });

        it('fails CLOSED on empty-ish times that Number() would turn into 0', function () {
            // The trap this guard exists for: on a genesis-on network a threshold of 0
            // means Number(null) === 0 reads as ACTIVE, so a missing time would silently
            // compose the pair. Same trap price_pair_activation.js documents.
            for (const bad of [null, undefined, '', false, true, NaN, 'soon']) {
                expect(isXchainPriceActive(bad, 'regtest'), String(bad)).to.equal(false);
            }
        });
    });

    describe('roundStartSeconds(): the key the gate reads', function () {
        const EPOCH = 1785000000000;   // ms
        const INTERVAL = 600000;       // 10 minutes

        it('is a pure function of the shared epoch, interval and round number', function () {
            expect(roundStartSeconds(0, EPOCH, INTERVAL)).to.equal(1785000000);
            expect(roundStartSeconds(1, EPOCH, INTERVAL)).to.equal(1785000600);
            expect(roundStartSeconds(100, EPOCH, INTERVAL)).to.equal(1785060000);
        });

        it('is identical on two hubs computing the same round, which is the whole point', function () {
            // A locally-observed BTC tip is NOT identical across hubs, and two hubs
            // straddling the gate instant would disagree about whether the pair belongs
            // in the round. The round's start instant has no such skew.
            const hubA = roundStartSeconds(4242, EPOCH, INTERVAL);
            const hubB = roundStartSeconds(4242, EPOCH, INTERVAL);
            expect(hubA).to.equal(hubB);
        });

        it('accepts the STRING config values a real hub actually passes', function () {
            // Regression. OracleRound reads ORACLE_ROUND_INTERVAL straight from config
            // without parsing, so it is the string '600000' in every real deployment.
            // A strict Number.isFinite() check rejected that and held the gate shut on
            // EVERY network - invisible on mainnet, which is shut anyway, and caught
            // only because regtest is genesis-on and should have been open.
            expect(roundStartSeconds(1, EPOCH, '600000')).to.equal(1785000600);
            expect(roundStartSeconds(1, String(EPOCH), '600000')).to.equal(1785000600);
        });

        it('returns null rather than 0 on unusable inputs', function () {
            // Returning 0 would read as "genesis" and open the gate on a test network.
            expect(roundStartSeconds(-1, EPOCH, INTERVAL)).to.equal(null);
            expect(roundStartSeconds(1.5, EPOCH, INTERVAL)).to.equal(null);
            expect(roundStartSeconds(1, NaN, INTERVAL)).to.equal(null);
            expect(roundStartSeconds(1, EPOCH, 0)).to.equal(null);
            expect(roundStartSeconds(1, EPOCH, -600000)).to.equal(null);
            expect(roundStartSeconds(1, EPOCH, '')).to.equal(null);
            expect(roundStartSeconds(1, EPOCH, null)).to.equal(null);
            expect(roundStartSeconds(1, EPOCH, true)).to.equal(null);
            expect(roundStartSeconds(1, EPOCH, 'ten minutes')).to.equal(null);
        });

        it('advances monotonically with the round number', function () {
            let prev = roundStartSeconds(0, EPOCH, INTERVAL);
            for (let r = 1; r < 10; r++) {
                let now = roundStartSeconds(r, EPOCH, INTERVAL);
                expect(now).to.be.above(prev);
                prev = now;
            }
        });
    });
});
