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
// The stake-share monitor scores the gate with its own copy of 3*ours > 2*S
// (classifyMargin). These tests run that copy and the real commit gate,
// meetsStakeThreshold, on the same snapshots, so a change to the gate that the
// monitor does not follow fails here instead of passing every hand-computed case.

const { expect } = require('chai');

const {
    evaluateStakeShare, projectCompetingStake, LEVELS
} = require('../../../src/validators/stake_share_monitor.js');
const { meetsStakeThreshold } = require('../../../src/consensus/stake_weighted_quorum.js');

// Build snapshot rows from [source, weight, keyCount] triples; every key of a source shares its weight.
function snapshot(spec) {
    let rows = [];
    for (let [source, weight, keys] of spec) {
        for (let k = 0; k < (keys || 1); k++) rows.push({ pubkey: source + '_pk' + k, source: source, weight: weight });
    }
    return rows;
}

// Every key of every operator source signs: the upper bound classifyMargin models.
function operatorSigners(validators, operatorSources) {
    let ours = new Set(operatorSources);
    return validators.filter(v => ours.has(String(v.source))).map(v => v.pubkey);
}

// Snapshots that sit on, just off, and far from the 3*tally > 2*S boundary.
const CASES = [
    { name: 'exact boundary 3*ours == 2*S', ours: ['o1', 'o2'],
      spec: [['o1', '100'], ['o2', '100'], ['t1', '100']] },
    { name: 'one unit above the boundary', ours: ['o1', 'o2'],
      spec: [['o1', '101'], ['o2', '100'], ['t1', '100']] },
    { name: 'one unit below the boundary', ours: ['o1', 'o2'],
      spec: [['o1', '99'], ['o2', '100'], ['t1', '100']] },
    { name: 'a fractional step above the boundary', ours: ['o1', 'o2'],
      spec: [['o1', '100.00000001'], ['o2', '100'], ['t1', '100']] },
    { name: 'a fractional step below the boundary', ours: ['o1', 'o2'],
      spec: [['o1', '99.99999999'], ['o2', '100'], ['t1', '100']] },
    { name: 'a single operator source', ours: ['o1'], spec: [['o1', '25000']] },
    { name: 'the operator holds every source', ours: ['o1', 'o2', 'o3'],
      spec: [['o1', '10'], ['o2', '20'], ['o3', '30']] },
    { name: 'large near-equal totals an epsilon compare would round', ours: ['o1'],
      spec: [['o1', '2000000000000000000000001'], ['t1', '1000000000000000000000000']] },
    { name: 'large totals exactly on the boundary', ours: ['o1'],
      spec: [['o1', '2000000000000000000000000'], ['t1', '1000000000000000000000000']] },
    { name: 'zero-weight operator and third-party sources', ours: ['o1', 'o0'],
      spec: [['o1', '200'], ['o0', '0'], ['t1', '100'], ['t0', '0']] },
    { name: 'operator sources holding several keys each', ours: ['o1', 'o2'],
      spec: [['o1', '100', 3], ['o2', '100', 2], ['t1', '100', 4]] },
    { name: 'the testnet outage set one stake before the halt', ours: ['o1', 'o2', 'o3', 'o4', 'o5'],
      spec: [['o1', '25000'], ['o2', '25000'], ['o3', '25000'], ['o4', '25000'], ['o5', '25000'],
             ['t1', '25000'], ['t2', '25000']] },
    { name: 'the testnet outage set at the halt', ours: ['o1', 'o2', 'o3', 'o4', 'o5'],
      spec: [['o1', '25000'], ['o2', '25000'], ['o3', '25000'], ['o4', '25000'], ['o5', '25000'],
             ['t1', '25000'], ['t2', '25000'], ['t3', '25000']] }
];

// Competing stakes to project on top of each case, including one that lands exactly on the boundary.
const PROJECTED_AMOUNTS = ['0', '1', '0.00000001', '50', '100', '25000', '1000000000000000000000000'];

describe('stake-share monitor gate verdict matches meetsStakeThreshold', function () {

    registerLiveReadingParity();
    registerProjectionParity();
    registerFailClosedParity();
});

function registerLiveReadingParity() {
    it('agrees with the gate on every live snapshot in the table', function () {
        let sawPass = false;
        let sawFail = false;
        for (let c of CASES) {
            let validators = snapshot(c.spec);
            let gate = meetsStakeThreshold(validators, operatorSigners(validators, c.ours));
            let r = evaluateStakeShare({ validators: validators, operatorSources: c.ours });
            expect(r.meetsGate, c.name).to.equal(gate);
            // Headroom must be positive exactly when the gate holds.
            let headroomPositive = !r.headroom.startsWith('-') && r.headroom !== '0';
            expect(headroomPositive, c.name + ' headroom ' + r.headroom).to.equal(gate);
            if (gate) sawPass = true; else sawFail = true;
        }
        // Both verdicts must occur, or the table could not catch a flipped comparison.
        expect(sawPass).to.equal(true);
        expect(sawFail).to.equal(true);
    });
}

function registerProjectionParity() {
    it('agrees with the gate when a competing stake is projected onto each snapshot', function () {
        for (let c of CASES) {
            let validators = snapshot(c.spec);
            let live = evaluateStakeShare({ validators: validators, operatorSources: c.ours });
            for (let amount of PROJECTED_AMOUNTS) {
                let projected = projectCompetingStake(live, amount);
                let withCompetitor = validators.concat([{ pubkey: 'rival_pk0', source: 'rival', weight: amount }]);
                let gate = meetsStakeThreshold(withCompetitor, operatorSigners(withCompetitor, c.ours));
                expect(projected.meetsGate, c.name + ' + ' + amount).to.equal(gate);
            }
        }
    });

    it('lands a projection exactly on the boundary and agrees that the gate fails there', function () {
        // 201 of 301 holds the bar with nothing added; 200 of 250 plus a further 50 sits exactly on 3*200 == 2*300.
        let validators = snapshot([['o1', '201'], ['t1', '100']]);
        let live = evaluateStakeShare({ validators: validators, operatorSources: ['o1'] });
        let exact = projectCompetingStake(live, '0');
        let withCompetitor = validators.concat([{ pubkey: 'rival_pk0', source: 'rival', weight: '0' }]);
        expect(exact.meetsGate).to.equal(meetsStakeThreshold(withCompetitor, ['o1_pk0']));
        expect(exact.meetsGate).to.equal(true);
        let onBar = evaluateStakeShare({ validators: snapshot([['o1', '200'], ['t1', '50']]), operatorSources: ['o1'] });
        let tied = projectCompetingStake(onBar, '50');
        let tiedSet = snapshot([['o1', '200'], ['t1', '50'], ['rival', '50']]);
        expect(tied.meetsGate).to.equal(meetsStakeThreshold(tiedSet, ['o1_pk0']));
        expect(tied.meetsGate).to.equal(false);
    });
}

function registerFailClosedParity() {
    it('reports BLOCKED on every snapshot the gate fails closed on', function () {
        let truncated = snapshot([['o1', '200'], ['t1', '50']]);
        truncated.truncated = true;
        let failClosed = [
            { name: 'truncated snapshot', validators: truncated },
            { name: 'zero total stake', validators: snapshot([['o1', '0'], ['t1', '0']]) },
            { name: 'negative weight', validators: snapshot([['o1', '200'], ['t1', '-50']]) },
            { name: 'blank source', validators: snapshot([['o1', '200']]).concat([{ pubkey: 'x', source: '', weight: '1' }]) },
            { name: 'missing weight', validators: snapshot([['o1', '200']]).concat([{ pubkey: 'y', source: 't1' }]) }
        ];
        for (let c of failClosed) {
            let gate = meetsStakeThreshold(c.validators, c.validators.map(v => v.pubkey));
            let r = evaluateStakeShare({ validators: c.validators, operatorSources: ['o1'] });
            expect(gate, c.name).to.equal(false);
            expect(r.level, c.name).to.equal(LEVELS.BLOCKED);
            expect(r.meetsGate, c.name).to.equal(null);
        }
    });
}
