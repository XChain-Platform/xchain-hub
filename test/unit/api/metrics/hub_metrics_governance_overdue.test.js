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

const { expect } = require('chai');
const {
  installHubGovernanceOverdueMetrics
} = require('../../../../src/api/hub_metrics');
const {
  installObservability,
  _resetObservability
} = require('../../../../src/observability');

function realObservability() {
  return installObservability(null, {
    service: 'xchain-hub',
    env: {
      METRICS_ENABLED: 'true'
    }
  });
}

function renderFor(hub) {
  const observability = realObservability();
  installHubGovernanceOverdueMetrics(observability, hub);
  return observability.registry.render();
}

describe('hub governance overdue metric installation', function () {
  afterEach(function () {
    _resetObservability();
  });

  it('refuses to install without a registry', function () {
    expect(installHubGovernanceOverdueMetrics(null, {})).to.equal(false);
    expect(installHubGovernanceOverdueMetrics({ registry: null }, {})).to.equal(false);
  });

  it('installs on a real registry', function () {
    expect(installHubGovernanceOverdueMetrics(realObservability(), {})).to.equal(true);
  });
});

describe('hub governance overdue metric availability', function () {
  afterEach(function () {
    _resetObservability();
  });

  it('renders zero before governance starts', function () {
    expect(renderFor({})).to.match(/^xchain_governance_overdue_proposals 0$/m);
  });

  it('renders no sample before governance has counted overdue proposals', function () {
    expect(renderFor({ governance: {} }))
      .to.not.match(/^xchain_governance_overdue_proposals /m);
  });

  it('renders a non-negative integer count', function () {
    expect(renderFor({ governance: { _overdueCount: 3 } }))
      .to.match(/^xchain_governance_overdue_proposals 3$/m);
  });
});

describe('hub governance overdue metric scrape updates', function () {
  afterEach(function () {
    _resetObservability();
  });

  it('reads the count again on the next scrape', function () {
    const observability = realObservability();
    const hub = { governance: { _overdueCount: 3 } };
    installHubGovernanceOverdueMetrics(observability, hub);
    expect(observability.registry.render())
      .to.match(/^xchain_governance_overdue_proposals 3$/m);
    hub.governance._overdueCount = 1;
    expect(observability.registry.render())
      .to.match(/^xchain_governance_overdue_proposals 1$/m);
  });

  it('removes the sample for negative and fractional counts', function () {
    const observability = realObservability();
    const hub = { governance: { _overdueCount: -1 } };
    installHubGovernanceOverdueMetrics(observability, hub);
    expect(observability.registry.render())
      .to.not.match(/^xchain_governance_overdue_proposals /m);
    hub.governance._overdueCount = 1.5;
    expect(observability.registry.render())
      .to.not.match(/^xchain_governance_overdue_proposals /m);
  });
});
