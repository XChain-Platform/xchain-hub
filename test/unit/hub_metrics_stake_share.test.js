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
 **********************************************************************/

'use strict';

const {
  expect
} = require('chai');
const {
  installHubOracleMetrics,
  installHubStakeShareMetrics
} = require('../../src/api/hub_metrics');
const {
  StakeShareMonitor,
  evaluateStakeShare
} = require('../../src/validators/stake_share_monitor.js');
const {
  installObservability
} = require('../../src/observability');

// Real registry from the observability module, not a stub: the claim under test
// is that these series appear on the actual scrape surface.
function realObservability() {
  return installObservability(null, {
    service: 'xchain-hub',
    env: {
      METRICS_ENABLED: 'true'
    }
  });
}

function hubStakeShareMetricsSuite2HubWithShare(entries) {
  const monitor = new StakeShareMonitor({
    log: () => {}
  });
  for (const e of entries) monitor.record(e.chain, e.capability, evaluateStakeShare(e.input));
  return {
    hub: {
      stakeShareWatcher: {
        monitor
      }
    },
    monitor
  };
}
const hubStakeShareMetricsSuite2Rows = spec => spec.map((s, i) => ({
  pubkey: 'pk' + i,
  source: s[0],
  weight: String(s[1])
}));
function registerHubStakeShareMetricsSuite2Part1() {
  afterEach(function () {
    require('../../src/observability')._resetObservability();
  });
  it('renders the share, the headroom and the stakes-to-halt per chain and capability', function () {
    const observability = realObservability();
    const {
      hub
    } = hubStakeShareMetricsSuite2HubWithShare([{
      chain: 'BTC',
      capability: 'price',
      input: {
        // The prior-outage precursor: 125000 of 175000, one stake from a halt.
        validators: hubStakeShareMetricsSuite2Rows([['ours1', 25000], ['ours2', 25000], ['ours3', 25000], ['ours4', 25000], ['ours5', 25000], ['c1', 25000], ['c2', 25000]]),
        operatorSources: ['ours1', 'ours2', 'ours3', 'ours4', 'ours5'],
        minStake: '25000'
      }
    }]);
    expect(installHubStakeShareMetrics(observability, hub)).to.equal(true);
    const out = observability.registry.render();
    expect(out).to.match(/xchain_stake_share_stakes_to_halt\{chain="BTC",capability="price"\} 1\b/);
    expect(out).to.match(/xchain_stake_share_meets_gate\{chain="BTC",capability="price"\} 1\b/);
    expect(out).to.match(/xchain_stake_share_headroom\{chain="BTC",capability="price"\} 12500\b/);
    expect(out).to.match(/xchain_stake_share_ratio\{chain="BTC",capability="price"\} 0\.71/);
    expect(out).to.match(/xchain_stake_share_alerting 1\b/);
  });
  it('drops meets_gate to 0 once the federation is under the two-thirds bar', function () {
    const observability = realObservability();
    const {
      hub
    } = hubStakeShareMetricsSuite2HubWithShare([{
      chain: 'DOGE',
      capability: 'price',
      input: {
        validators: hubStakeShareMetricsSuite2Rows([['ours1', 25000], ['c1', 25000]]),
        operatorSources: ['ours1'],
        minStake: '25000'
      }
    }]);
    installHubStakeShareMetrics(observability, hub);
    const out = observability.registry.render();
    expect(out).to.match(/xchain_stake_share_meets_gate\{chain="DOGE",capability="price"\} 0\b/);
    expect(out).to.match(/xchain_stake_share_stakes_to_halt\{chain="DOGE",capability="price"\} 0\b/);
    expect(out).to.match(/xchain_stake_share_headroom\{chain="DOGE",capability="price"\} -12500\b/);
  });
}
function registerHubStakeShareMetricsSuite2Part2() {
  it('leaves an unmeasured chain ABSENT rather than reporting a zero share', function () {
    // A zero on these series is indistinguishable from a collapsed share and
    // would page over an unreachable indexer the consensus-input monitor
    // already owns.
    const observability = realObservability();
    const monitor = new StakeShareMonitor({
      log: () => {}
    });
    monitor.recordUnavailable('LTC', 'price', 'no LTC indexer URL');
    installHubStakeShareMetrics(observability, {
      stakeShareWatcher: {
        monitor
      }
    });
    const out = observability.registry.render();
    expect(out).to.not.match(/xchain_stake_share_ratio\{[^}]*chain="LTC"/);
    expect(out).to.not.match(/xchain_stake_share_meets_gate\{[^}]*chain="LTC"/);
    expect(out).to.match(/xchain_stake_share_alerting 0\b/);
  });
}
function registerHubStakeShareMetricsSuite2Part3() {
  it('drops a healthy reading once the snapshot becomes unreadable, instead of repeating it', function () {
    // The absent-on-unavailable rule only held for a chain that had NEVER been
    // measured. A registered series survives a skipped set(), so after a failed
    // indexer read every later scrape kept rendering the last healthy sample as
    // a current measurement, meets_gate 1 included.
    const observability = realObservability();
    const {
      hub,
      monitor
    } = hubStakeShareMetricsSuite2HubWithShare([{
      chain: 'BTC',
      capability: 'price',
      input: {
        validators: hubStakeShareMetricsSuite2Rows([['ours1', 100], ['c1', 10]]),
        operatorSources: ['ours1'],
        minStake: '10'
      }
    }]);
    installHubStakeShareMetrics(observability, hub);
    const healthy = observability.registry.render();
    expect(healthy).to.match(/xchain_stake_share_meets_gate\{chain="BTC",capability="price"\} 1\b/);
    expect(healthy).to.match(/xchain_stake_share_ratio\{chain="BTC",capability="price"\}/);
    monitor.recordUnavailable('BTC', 'price', 'indexer unreachable');
    const stale = observability.registry.render();
    expect(stale).to.not.match(/xchain_stake_share_meets_gate\{[^}]*chain="BTC"/);
    expect(stale).to.not.match(/xchain_stake_share_ratio\{[^}]*chain="BTC"/);
    expect(stale).to.not.match(/xchain_stake_share_headroom\{[^}]*chain="BTC"/);
    expect(stale).to.not.match(/xchain_stake_share_stakes_to_halt\{[^}]*chain="BTC"/);

    // A chain that IS still measurable keeps rendering across the same scrape,
    // which is what makes the reset a gap rather than a blackout.
    monitor.record('DOGE', 'price', evaluateStakeShare({
      validators: hubStakeShareMetricsSuite2Rows([['ours1', 100], ['c1', 10]]),
      operatorSources: ['ours1'],
      minStake: '10'
    }));
    const mixed = observability.registry.render();
    expect(mixed).to.match(/xchain_stake_share_meets_gate\{chain="DOGE",capability="price"\} 1\b/);
    expect(mixed).to.not.match(/xchain_stake_share_meets_gate\{[^}]*chain="BTC"/);
  });
}
function registerHubStakeShareMetricsSuite2Part4() {
  it('stops rendering stake-share series once the hub loses its watcher', function () {
    const observability = realObservability();
    const {
      hub
    } = hubStakeShareMetricsSuite2HubWithShare([{
      chain: 'BTC',
      capability: 'price',
      input: {
        validators: hubStakeShareMetricsSuite2Rows([['ours1', 100], ['c1', 10]]),
        operatorSources: ['ours1'],
        minStake: '10'
      }
    }]);
    installHubStakeShareMetrics(observability, hub);
    expect(observability.registry.render()).to.match(/xchain_stake_share_alerting 0\b/);
    hub.stakeShareWatcher = null;
    const out = observability.registry.render();
    expect(out).to.not.match(/xchain_stake_share_alerting \d/);
    expect(out).to.not.match(/xchain_stake_share_meets_gate\{/);
  });
  it('resolves the watcher at scrape time, and emits nothing on a config-only hub', function () {
    const observability = realObservability();
    const hub = {
      stakeShareWatcher: null
    };
    expect(installHubStakeShareMetrics(observability, hub)).to.equal(true);
    expect(observability.registry.render()).to.not.match(/xchain_stake_share_alerting \d/);
    const monitor = new StakeShareMonitor({
      log: () => {}
    });
    monitor.record('BTC', 'price', evaluateStakeShare({
      validators: hubStakeShareMetricsSuite2Rows([['ours1', 100], ['c1', 10]]),
      operatorSources: ['ours1'],
      minStake: '10'
    }));
    hub.stakeShareWatcher = {
      monitor
    };
    expect(observability.registry.render()).to.match(/xchain_stake_share_alerting 0\b/);
  });
  it('refuses to register without a registry at all', function () {
    expect(installHubStakeShareMetrics({
      registry: null
    }, {})).to.equal(false);
  });
}
describe('hub stake-share metrics', function () {
  registerHubStakeShareMetricsSuite2Part1.call(this);
  registerHubStakeShareMetricsSuite2Part2.call(this);
  registerHubStakeShareMetricsSuite2Part3.call(this);
  registerHubStakeShareMetricsSuite2Part4.call(this);
});
