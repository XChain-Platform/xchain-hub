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
const {
    evaluateStakeShare, projectCompetingStake, LEVELS
} = require('../../../src/validators/stake_share_monitor.js');

function rows(spec) {
    return spec.map((s, i) => ({ pubkey: 'pk' + i, source: s.source, weight: String(s.weight) }));
}

function outageMinusOne() {
    return rows([
        { source: 'ours1', weight: 25000 }, { source: 'ours2', weight: 25000 },
        { source: 'ours3', weight: 25000 }, { source: 'ours4', weight: 25000 },
        { source: 'ours5', weight: 25000 },
        { source: 'community1', weight: 25000 }, { source: 'community2', weight: 25000 }
    ]);
}
const OURS = ['ours1', 'ours2', 'ours3', 'ours4', 'ours5'];

describe('projectCompetingStake', function () {

    // The desk half of the drill: "what does the next community STAKE do to us",
    // answered against the live reading without putting stake on the network.
    const reading = () => evaluateStakeShare({
        validators: outageMinusOne(), operatorSources: OURS, minStake: '25000'
    });

    it('shows the exact stake that ends price rounds', function () {
        const p = projectCompetingStake(reading(), '25000');
        expect(p.totalStake).to.equal('200000');
        expect(p.meetsGate).to.equal(false);
        expect(p.level).to.equal(LEVELS.HALTED);
        expect(p.headroom).to.equal('-12500');
        expect(p.reason).to.contain('after a further 25000');
    });

    it('keeps the gate for a stake smaller than the headroom', function () {
        const p = projectCompetingStake(reading(), '1000');
        expect(p.meetsGate).to.equal(true);
        expect(p.headroom).to.equal('11500');
        expect(p.stakesToHalt).to.equal(1);
        expect(p.level).to.equal(LEVELS.CRITICAL);
    });

    it('scores the projection with the same rules as the live reading', function () {
        const zero = projectCompetingStake(reading(), '0');
        const live = reading();
        expect(zero.level).to.equal(live.level);
        expect(zero.headroom).to.equal(live.headroom);
        expect(zero.stakesToHalt).to.equal(live.stakesToHalt);
    });

    it('returns null rather than a guess on an unmeasured reading or a bad amount', function () {
        expect(projectCompetingStake(reading(), 'lots')).to.equal(null);
        expect(projectCompetingStake(reading(), '-5')).to.equal(null);
        expect(projectCompetingStake(null, '1')).to.equal(null);
        expect(projectCompetingStake(evaluateStakeShare({ validators: [], operatorSources: OURS }), '1'))
            .to.equal(null);
    });
});
