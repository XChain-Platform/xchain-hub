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
    StakeShareMonitor, evaluateStakeShare, LEVELS
} = require('../../src/lib/stake_share_monitor.js');

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

function makeMonitor(opts) {
    const lines = [];
    const clock = { t: 1000000 };
    const monitor = new StakeShareMonitor(Object.assign({
        throttleMs: 300000, now: () => clock.t, log: (msg) => lines.push(msg)
    }, opts || {}));
    return { monitor, lines, clock };
}

const okEval  = () => evaluateStakeShare({
    validators: rows([
        { source: 'ours1', weight: 100000 }, { source: 'ours2', weight: 100000 },
        { source: 'c1', weight: 25000 }
    ]), operatorSources: ['ours1', 'ours2'], minStake: '25000'
});
const criticalEval = () => evaluateStakeShare({
    validators: outageMinusOne(), operatorSources: OURS, minStake: '25000'
});

describe('StakeShareMonitor', function () {
    registerMonitorAlertTests();
    registerMonitorSnapshotTests();
});

function registerMonitorAlertTests() {
    it('stays quiet while the margin is comfortable', function () {
        const { monitor, lines } = makeMonitor();
        monitor.record('BTC', 'price', okEval());
        expect(lines).to.deep.equal([]);
        expect(monitor.isAlerting()).to.equal(false);
    });

    it('logs and alerts the moment the margin reaches one stake', function () {
        const { monitor, lines } = makeMonitor();
        monitor.record('BTC', 'price', okEval());
        monitor.record('BTC', 'price', criticalEval());
        expect(monitor.isAlerting()).to.equal(true);
        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.contain('STAKE SHARE CRITICAL [BTC/price]');
        expect(lines[0]).to.contain('12500');
    });

    it('prints a level change immediately even inside the throttle window', function () {
        const { monitor, lines, clock } = makeMonitor();
        monitor.record('BTC', 'price', criticalEval());
        expect(lines).to.have.lengthOf(1);
        // Same level, same window: throttled.
        clock.t += 1000;
        monitor.record('BTC', 'price', criticalEval());
        expect(lines).to.have.lengthOf(1);
        // Escalation inside the window still prints: the transition IS the signal.
        const halted = evaluateStakeShare({
            validators: outageMinusOne().concat(rows([{ source: 'c3', weight: 25000 }])),
            operatorSources: OURS, minStake: '25000'
        });
        monitor.record('BTC', 'price', halted);
        expect(lines).to.have.lengthOf(2);
        expect(lines[1]).to.contain('STAKE SHARE HALTED');
    });

    it('re-logs a standing alert once per window, not once per poll', function () {
        const { monitor, lines, clock } = makeMonitor();
        monitor.record('BTC', 'price', criticalEval());
        for (let i = 0; i < 5; i++) { clock.t += 10000; monitor.record('BTC', 'price', criticalEval()); }
        expect(lines).to.have.lengthOf(1);
        clock.t += 300001;
        monitor.record('BTC', 'price', criticalEval());
        expect(lines).to.have.lengthOf(2);
    });
}

function registerMonitorSnapshotTests() {
    it('announces recovery, so a fixed federation is distinguishable from a stalled monitor', function () {
        const { monitor, lines } = makeMonitor();
        monitor.record('BTC', 'price', criticalEval());
        monitor.record('BTC', 'price', okEval());
        expect(monitor.isAlerting()).to.equal(false);
        expect(lines[1]).to.contain('STAKE SHARE ALERT CLEARED [BTC/price]');
    });

    it('keeps one entry per chain and capability, and reports the worst', function () {
        const { monitor } = makeMonitor();
        monitor.record('BTC', 'price', criticalEval());
        monitor.record('DOGE', 'price', okEval());
        monitor.record('BTC', 'oracle_publish', okEval());
        const snap = monitor.snapshot();
        expect(Object.keys(snap.chains).sort()).to.deep.equal(['BTC', 'DOGE']);
        expect(Object.keys(snap.chains.BTC).sort()).to.deep.equal(['oracle_publish', 'price']);
        expect(snap.worst).to.deep.equal({ level: LEVELS.CRITICAL, chain: 'BTC', capability: 'price' });
        expect(snap.alerting).to.equal(true);
        expect(snap.chains.BTC.price.stakes_to_halt).to.equal(1);
        expect(snap.chains.DOGE.price.meets_gate).to.equal(true);
    });

    it('does not page on an unreadable snapshot, which the indexer monitor already owns', function () {
        const { monitor, lines } = makeMonitor();
        monitor.recordUnavailable('LTC', 'price', 'no LTC indexer URL could be resolved');
        expect(monitor.isAlerting()).to.equal(false);
        expect(monitor.snapshot().chains.LTC.price.level).to.equal(LEVELS.UNAVAILABLE);
        expect(lines).to.have.lengthOf(1);
        expect(lines[0]).to.contain('Stake share unavailable [LTC/price]');
    });

    it('ages entries so a stalled watcher is visible in the body', function () {
        const { monitor, clock } = makeMonitor();
        monitor.record('BTC', 'price', okEval());
        clock.t += 900000;
        expect(monitor.snapshot().chains.BTC.price.age_s).to.equal(900);
    });
}
