'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// (reviews-store seq 2400): ONE mean-relative deviation band shared by the
// publish-side 2-source liveness gate, the co-sign admission gate, and SlashDetector.
// Pre-fix the co-sign gate divided by the follower's LOCAL value while the publish
// gate was mean-relative, so a price ratio r in (1.10, 1.10526] at the 5% band made
// the leader publish a pair the follower then withheld the whole round over.

const sinon           = require('sinon');
const { expect }      = require('chai');
const devband         = require('../../src/lib/deviation_band');
const bcmath          = require('../../src/bcmath');
const OracleConsensus = require('../../src/OracleConsensus');
const { ORACLE_DEVIATION_THRESHOLD } = require('../../src/constants');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('deviation_band helper (shared band)', function () {

    describe('deviationFrom / exceedsBand', function () {
        it('computes |value - reference| / reference symmetrically in sign', function () {
            expect(bcmath.bcstr(devband.deviationFrom('105', '100', 18))).to.equal('0.05');
            expect(bcmath.bcstr(devband.deviationFrom('95', '100', 18))).to.equal('0.05');
        });

        it('is reference-relative, not value-relative', function () {
            // 5200/105200 = 0.049429..., NOT 5200/100000 = 0.052
            let d = devband.deviationFrom('100000', '105200', 18);
            expect(bcmath.bcgt(d, '0.0494')).to.be.true;
            expect(bcmath.bclt(d, '0.0495')).to.be.true;
        });

        it('exactly-at-threshold is INSIDE the band (strict >)', function () {
            expect(devband.exceedsBand('105', '100', 0.05, 18)).to.be.false;
            expect(devband.exceedsBand('105.0000001', '100', 0.05, 18)).to.be.true;
        });
    });

    describe('twoSourceSpread', function () {
        it('equals each submitter\'s mean-relative deviation ((hi-lo)/(hi+lo))', function () {
            // lo=100, hi=110.4: mean=105.2, per-submitter deviation 5.2/105.2
            let spread = devband.twoSourceSpread('100', '110.4', 8);
            let perSub = devband.deviationFrom('110.4', '105.2', 8);
            expect(bcmath.bcstr(spread)).to.equal(bcmath.bcstr(perSub));
        });

        it('is byte-identical to the original publish-gate arithmetic at scale 8', function () {
            let lo = '100.12345678', hi = '110.87654321';
            let original = bcmath.bcdiv(bcmath.bcsub(hi, lo, 8), bcmath.bcadd(lo, hi, 8), 8);
            expect(bcmath.bcstr(devband.twoSourceSpread(lo, hi, 8))).to.equal(bcmath.bcstr(original));
        });

        it('gates strictly above the threshold', function () {
            // r = 1.10526...: (hi-lo)/(hi+lo) crosses 0.05 just above hi=110.526...
            expect(devband.twoSourceSpreadExceeds('100', '110.4', 0.05, 8)).to.be.false;
            expect(devband.twoSourceSpreadExceeds('100', '110.6', 0.05, 8)).to.be.true;
        });
    });

    // The seq-2400 divergence window itself, end to end through _handlePropose:
    // leader's 2-source gate accepts {100000, 110400} (spread 0.04943 <= 0.05) and
    // proposes the mean 105200; the low-side follower (local 100000) must now
    // co-sign it instead of withholding the round.
    describe('co-sign gate aligned to the publish-side band', function () {
        let hub, pm, oc, oracleRound, leader;
        const ROUND = 1;

        beforeEach(function () {
            hub = createMockHub();
            pm  = hub._peerManager;
            pm.validatorPubkeys = new Set();
            oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
            oc = new OracleConsensus(hub, oracleRound);
            oc.setValidatorSet(VALIDATORS_3);
            leader = oc._getLeader(ROUND);
            pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]));
        });

        afterEach(function () { sinon.restore(); });

        function proposeEnvelope(prices, round = ROUND) {
            return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
                round, prices, digest: oc._digest(round, prices),
                btcBlockHeight: 100, btcBlockTime: 1700000000
            } };
        }

        it('co-signs a proposed mean the publish-side 2-source gate accepted (window closed)', async function () {
            // proposed = mean(100000, 110400) = 105200; local = 100000.
            // Old behavior: 5200/100000 = 0.052 > 0.05 -> withheld the whole round.
            // Canonical:  5200/105200 = 0.04943 <= 0.05 -> co-signs.
            await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '105200' }]));
            expect(oc.pendingRounds.has(ROUND)).to.be.true;
        });

        it('still withholds a proposal outside the canonical band', async function () {
            // 10600/110600 = 0.0958 > 0.05 on the canonical denominator.
            let events = [];
            oc.on('oracle:propose-rejected', e => events.push(e));
            await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '110600' }]));
            expect(oc.pendingRounds.has(ROUND)).to.be.false;
            expect(events.map(e => e.reason)).to.include('deviation');
        });

        it('withholds a low-side proposal just outside the band (reference = proposed)', async function () {
            // proposed 95000 vs local 100000: 5000/95000 = 0.05263 > 0.05.
            await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '95000' }]));
            expect(oc.pendingRounds.has(ROUND)).to.be.false;
        });
    });

    describe('SlashDetector alignment (behavior-preserving)', function () {
        it('slash band formula matches devband.deviationFrom against the finalized price', function () {
            // The same 105200-finalized round: the 100000 submitter is INSIDE the 5%
            // band (0.04943), so it is co-signed and not slashed; publish, co-sign and
            // slash now agree on one boundary.
            expect(devband.exceedsBand('100000', '105200', ORACLE_DEVIATION_THRESHOLD, 18)).to.be.false;
            // 5400/105200 = 0.05133 > 0.05: outside the band on every site.
            expect(devband.exceedsBand('110600', '105200', ORACLE_DEVIATION_THRESHOLD, 18)).to.be.true;
        });
    });
});
