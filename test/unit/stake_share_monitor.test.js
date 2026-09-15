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
// Nothing watched the operator's own share of active stake against the
// STAKE_WEIGHTED_QUORUM commit gate, so on 2026-09-01 a single community STAKE
// dropped the testnet federation under the two-thirds bar and killed every price
// round for 18 hours, discovered by a tester rather than by a monitor.
// These tests pin the forecast: the share, the headroom, and the number of new
// stakes that close it, on the outage's own numbers.

const { expect } = require('chai');

const {
    evaluateStakeShare, normalizeSources, isAlertLevel, LEVELS
} = require('../../src/lib/stake_share_monitor.js');

// One row per staking source, all equal weight, as the outage's set was.
function rows(spec) {
    return spec.map((s, i) => ({ pubkey: 'pk' + i, source: s.source, weight: String(s.weight) }));
}

// The outage federation the moment before the halt: our five validators plus
// two silent community stakes, every stake 25000.
function outageMinusOne() {
    return rows([
        { source: 'ours1', weight: 25000 }, { source: 'ours2', weight: 25000 },
        { source: 'ours3', weight: 25000 }, { source: 'ours4', weight: 25000 },
        { source: 'ours5', weight: 25000 },
        { source: 'community1', weight: 25000 }, { source: 'community2', weight: 25000 }
    ]);
}
const OURS = ['ours1', 'ours2', 'ours3', 'ours4', 'ours5'];

describe('evaluateStakeShare', function () {

    registerOutageForecastTests();
    registerMarginPolicyTests();
    registerSourceAggregationTests();
    registerStakeSizingTests();
    registerBlockedStateTests();
});

function registerOutageForecastTests() {
    it('measures the share, the gate and the headroom on the outage numbers', function () {
        // 125000 of 175000 = 71.43%: above the gate, but only by 12500, which is
        // half of one MIN_STAKE. This is the state that had no signal at all.
        const r = evaluateStakeShare({
            validators: outageMinusOne(), operatorSources: OURS, minStake: '25000'
        });
        expect(r.totalStake).to.equal('175000');
        expect(r.operatorStake).to.equal('125000');
        expect(r.otherStake).to.equal('50000');
        expect(r.meetsGate).to.equal(true);
        expect(r.headroom).to.equal('12500');
        expect(r.sourceCount).to.equal(7);
        expect(r.operatorSourceCount).to.equal(5);
        expect(r.shareRatio).to.be.closeTo(0.714285, 1e-5);
    });

    it('raises CRITICAL while the gate still holds, because ONE more stake closes it', function () {
        const r = evaluateStakeShare({
            validators: outageMinusOne(), operatorSources: OURS, minStake: '25000'
        });
        expect(r.meetsGate).to.equal(true);            // no round has failed yet
        expect(r.stakesToHalt).to.equal(1);
        expect(r.level).to.equal(LEVELS.CRITICAL);
        expect(isAlertLevel(r.level)).to.equal(true);
        expect(r.unitStakeFrom).to.equal('min_stake');
    });

    it('reports HALTED once the eighth stake lands, with the top-up needed to recover', function () {
        // The outage proper: 125000 of 200000 = 62.5%, under the two-thirds bar.
        const set = outageMinusOne().concat(rows([{ source: 'community3', weight: 25000 }]));
        const r = evaluateStakeShare({ validators: set, operatorSources: OURS, minStake: '25000' });
        expect(r.totalStake).to.equal('200000');
        expect(r.meetsGate).to.equal(false);
        expect(r.level).to.equal(LEVELS.HALTED);
        expect(r.stakesToHalt).to.equal(0);
        // (3*125000 - 2*200000)/2 = -12500: 12500 more operator stake restores it.
        expect(r.headroom).to.equal('-12500');
        expect(r.reason).to.contain('12500');
    });
}

function registerMarginPolicyTests() {
    it('shows the 275000 top-up is STILL one stake from the gate', function () {
        // The recovery runbook calls 200000/275000 = 72.7% "the margin
        // worth having" and reads it as two or three stakes of slack. It is not:
        // one more 25000 stake makes it 200000/300000, where 3*tally == 2*S
        // exactly and the STRICT gate fails. Whichever number an operator would
        // have eyeballed, this is the answer the monitor gives instead.
        const set = rows([
            { source: 'ours1', weight: 25000 }, { source: 'ours2', weight: 25000 },
            { source: 'ours3', weight: 50000 }, { source: 'ours4', weight: 50000 },
            { source: 'ours5', weight: 50000 },
            { source: 'community1', weight: 25000 }, { source: 'community2', weight: 25000 },
            { source: 'community3', weight: 25000 }
        ]);
        const r = evaluateStakeShare({ validators: set, operatorSources: OURS, minStake: '25000' });
        expect(r.operatorStake).to.equal('200000');
        expect(r.totalStake).to.equal('275000');
        expect(r.meetsGate).to.equal(true);
        expect(r.headroom).to.equal('25000');
        expect(r.stakesToHalt).to.equal(1);
        expect(r.level).to.equal(LEVELS.CRITICAL);
    });

    it('warns at two stakes of margin', function () {
        const r = evaluateStakeShare({
            validators: rows([
                { source: 'ours1', weight: 100000 }, { source: 'ours2', weight: 100000 },
                { source: 'c1', weight: 25000 }, { source: 'c2', weight: 25000 }
            ]),
            operatorSources: ['ours1', 'ours2'], minStake: '25000'
        });
        // 200000 of 250000: headroom (600000-500000)/2 = 50000 = 2 stakes.
        expect(r.headroom).to.equal('50000');
        expect(r.stakesToHalt).to.equal(2);
        expect(r.level).to.equal(LEVELS.WARNING);
        expect(isAlertLevel(r.level)).to.equal(false);
    });

    it('clears to OK at three stakes of margin', function () {
        const r = evaluateStakeShare({
            validators: rows([
                { source: 'ours1', weight: 150000 }, { source: 'ours2', weight: 150000 },
                { source: 'c1', weight: 25000 }, { source: 'c2', weight: 25000 }, { source: 'c3', weight: 25000 }
            ]),
            operatorSources: ['ours1', 'ours2'], minStake: '25000'
        });
        // 300000 of 375000: headroom (900000-750000)/2 = 75000 = 3 stakes.
        expect(r.stakesToHalt).to.equal(3);
        expect(r.level).to.equal(LEVELS.OK);
    });
}

function registerSourceAggregationTests() {
    it('honours operator-tuned warn / critical margins', function () {
        const set = rows([
            { source: 'ours1', weight: 100000 }, { source: 'ours2', weight: 100000 },
            { source: 'c1', weight: 25000 }, { source: 'c2', weight: 25000 }
        ]);
        const wide = evaluateStakeShare({
            validators: set, operatorSources: ['ours1', 'ours2'], minStake: '25000',
            criticalAtStakes: 2, warnAtStakes: 4
        });
        expect(wide.level).to.equal(LEVELS.CRITICAL);
        const narrow = evaluateStakeShare({
            validators: set, operatorSources: ['ours1', 'ours2'], minStake: '25000',
            criticalAtStakes: 1, warnAtStakes: 1
        });
        expect(narrow.level).to.equal(LEVELS.OK);
    });

    it('counts one source once however many keys it delegated', function () {
        // DELEGATE v0 is additive per source; the gate dedupes by source and so
        // must the share, or a community source with three keys reads as three
        // stakes and the margin is understated.
        const set = [
            { pubkey: 'a1', source: 'ours1', weight: '100000' },
            { pubkey: 'a2', source: 'ours1', weight: '100000' },
            { pubkey: 'b1', source: 'c1', weight: '25000' },
            { pubkey: 'b2', source: 'c1', weight: '25000' },
            { pubkey: 'b3', source: 'c1', weight: '25000' }
        ];
        const r = evaluateStakeShare({ validators: set, operatorSources: ['ours1'], minStake: '25000' });
        expect(r.totalStake).to.equal('125000');
        expect(r.operatorStake).to.equal('100000');
        expect(r.sourceCount).to.equal(2);
    });

    it('sizes one more staker off the LARGEST third-party stake, not MIN_STAKE', function () {
        // The prior misread: `price` MIN_STAKE is 1000 while the community
        // stakes that actually arrived were 25000 each, so a MIN_STAKE-sized unit
        // reports twelve stakers of margin about a set one staker ended. What is
        // already on the chain is the evidence for what the next stake looks like.
        const set = rows([
            { source: 'ours1', weight: 25000 }, { source: 'ours2', weight: 25000 },
            { source: 'ours3', weight: 25000 }, { source: 'ours4', weight: 25000 },
            { source: 'ours5', weight: 25000 },
            { source: 'c1', weight: 25000 }, { source: 'c2', weight: 25000 }
        ]);
        const r = evaluateStakeShare({ validators: set, operatorSources: OURS, minStake: '1000' });
        expect(r.headroom).to.equal('12500');
        expect(r.unitStake).to.equal('25000');
        expect(r.unitStakeFrom).to.equal('largest_other_source');
        expect(r.stakesToHalt).to.equal(1);
        expect(r.level).to.equal(LEVELS.CRITICAL);
    });
}

function registerStakeSizingTests() {
    it('never sizes a stake below MIN_STAKE, which nobody can qualify under', function () {
        const r = evaluateStakeShare({
            validators: rows([
                { source: 'ours1', weight: 100000 }, { source: 'c1', weight: 500 }
            ]),
            operatorSources: ['ours1'], minStake: '25000'
        });
        expect(r.unitStake).to.equal('25000');
        expect(r.unitStakeFrom).to.equal('min_stake');
    });

    it('sizes off our own largest stake when no third party has staked yet', function () {
        const r = evaluateStakeShare({
            validators: rows([{ source: 'ours1', weight: 10 }, { source: 'ours2', weight: 30 }]),
            operatorSources: ['ours1', 'ours2']
        });
        expect(r.unitStake).to.equal('30');
        expect(r.unitStakeFrom).to.equal('largest_source');
        expect(r.meetsGate).to.equal(true);
        // Headroom (120-80)/2 = 20, so a staker the size of our biggest ends it.
        expect(r.stakesToHalt).to.equal(1);
    });

    it('is exact on stake totals a float would round', function () {
        // 3*ours == 2*S exactly: the gate is STRICTLY greater, so this is a halt,
        // and a float-based share would call it 66.666...% and pass it.
        const r = evaluateStakeShare({
            validators: rows([
                { source: 'ours1', weight: '20000000000000000002' },
                { source: 'c1', weight: '10000000000000000001' }
            ]),
            operatorSources: ['ours1'], minStake: '1'
        });
        expect(r.totalStake).to.equal('30000000000000000003');
        expect(r.meetsGate).to.equal(false);
        expect(r.level).to.equal(LEVELS.HALTED);
        expect(r.headroom).to.equal('0');
    });
}

function registerBlockedStateTests() {
    it('reports BLOCKED on a truncated snapshot, which the gate itself fails closed on', function () {
        const set = outageMinusOne();
        set.truncated = true;
        const r = evaluateStakeShare({ validators: set, operatorSources: OURS, minStake: '25000' });
        expect(r.level).to.equal(LEVELS.BLOCKED);
        expect(isAlertLevel(r.level)).to.equal(true);
        expect(r.reason).to.contain('fails CLOSED');
    });

    it('reports BLOCKED on a blank source or a missing weight', function () {
        const blank = evaluateStakeShare({
            validators: [{ pubkey: 'a', source: '', weight: '1' }], operatorSources: OURS
        });
        expect(blank.level).to.equal(LEVELS.BLOCKED);
        const weightless = evaluateStakeShare({
            validators: [{ pubkey: 'a', source: 's1' }], operatorSources: OURS
        });
        expect(weightless.level).to.equal(LEVELS.BLOCKED);
    });

    it('reports BLOCKED, not a divide-by-zero, on an empty or zero-stake set', function () {
        const empty = evaluateStakeShare({ validators: [], operatorSources: OURS });
        expect(empty.level).to.equal(LEVELS.BLOCKED);
        expect(empty.shareRatio).to.equal(null);
        const zero = evaluateStakeShare({
            validators: rows([{ source: 'ours1', weight: 0 }]), operatorSources: OURS
        });
        expect(zero.level).to.equal(LEVELS.BLOCKED);
    });

    it('says UNCONFIGURED rather than HALTED when no operator source is known', function () {
        // A page over a typo'd address teaches operators to mute the monitor, so
        // an unmeasurable share is never dressed up as a lost gate.
        const none = evaluateStakeShare({ validators: outageMinusOne(), operatorSources: [] });
        expect(none.level).to.equal(LEVELS.UNCONFIGURED);
        expect(isAlertLevel(none.level)).to.equal(false);

        const typo = evaluateStakeShare({
            validators: outageMinusOne(), operatorSources: ['ours1 ', 'nosuchaddress']
        });
        // 'ours1 ' trims to a real source; 'nosuchaddress' is named as unmatched.
        expect(typo.level).to.not.equal(LEVELS.UNCONFIGURED);
        expect(typo.unmatchedOperatorSources).to.deep.equal(['nosuchaddress']);

        const allWrong = evaluateStakeShare({
            validators: outageMinusOne(), operatorSources: ['OURS1', 'Ours2']
        });
        expect(allWrong.level).to.equal(LEVELS.UNCONFIGURED);
        expect(allWrong.reason).to.contain('per chain');
    });
}

describe('normalizeSources', function () {
    it('accepts a list or a delimited string, trims, and dedupes', function () {
        expect(normalizeSources('a, b  c,,a')).to.deep.equal(['a', 'b', 'c']);
        expect(normalizeSources([' a ', null, 'a', ''])).to.deep.equal(['a']);
        expect(normalizeSources(undefined)).to.deep.equal([]);
    });
});
