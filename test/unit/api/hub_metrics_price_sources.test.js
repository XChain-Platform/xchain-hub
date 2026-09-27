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
const { installHubOracleMetrics } = require('../../../src/api/hub_metrics');
const {
  installObservability,
  _resetObservability: resetObservability
} = require('../../../src/observability');

function realObservability() {
  return installObservability(null, {
    service: 'xchain-hub',
    env: {
      METRICS_ENABLED: 'true'
    }
  });
}

function registerPriceSourceBoundRejectMetricsSuitePart1() {
  afterEach(function () {
    resetObservability();
  });

  it('renders every price source bound-rejection count', function () {
    const observability = realObservability();
    installHubOracleMetrics(observability, {
      getOracle: () => ({
        priceFetcher: {
          _boundRejects: {
            coingecko: 3,
            kraken: 0
          }
        }
      })
    });
    const out = observability.registry.render();
    expect(out).to.match(/xchain_oracle_price_source_bound_rejects_total\{source="coingecko"\} 3\b/);
    expect(out).to.match(/xchain_oracle_price_source_bound_rejects_total\{source="kraken"\} 0\b/);
  });

  it('skips a non-finite price source count', function () {
    const observability = realObservability();
    installHubOracleMetrics(observability, {
      getOracle: () => ({
        priceFetcher: {
          _boundRejects: {
            coingecko: Number.NaN,
            kraken: 2
          }
        }
      })
    });
    const out = observability.registry.render();
    expect(out).to.not.match(/xchain_oracle_price_source_bound_rejects_total\{source="coingecko"\}/);
    expect(out).to.match(/xchain_oracle_price_source_bound_rejects_total\{source="kraken"\} 2\b/);
  });
}

function registerPriceSourceBoundRejectMetricsSuitePart2() {
  it('leaves the price source series absent without a fetcher', function () {
    const observability = realObservability();
    installHubOracleMetrics(observability, {
      getOracle: () => ({})
    });
    expect(observability.registry.render()).to.not.match(/xchain_oracle_price_source_bound_rejects_total\{/);
  });

  it('never walks a source counter backwards when the fetcher is re-minted', function () {
    const observability = realObservability();
    let fetcher = {
      _boundRejects: {
        coingecko: 8
      }
    };
    installHubOracleMetrics(observability, {
      getOracle: () => ({ priceFetcher: fetcher })
    });
    expect(observability.registry.render()).to.match(/xchain_oracle_price_source_bound_rejects_total\{source="coingecko"\} 8\b/);
    fetcher = {
      _boundRejects: {
        coingecko: 1
      }
    };
    expect(observability.registry.render()).to.match(/xchain_oracle_price_source_bound_rejects_total\{source="coingecko"\} 8\b/);
  });
}

function registerPriceSourceLivenessMetricsSuite() {
  it('renders live and dead price source samples', function () {
    const observability = realObservability();
    installHubOracleMetrics(observability, {
      getOracle: () => ({
        priceFetcher: {
          lastSourceLiveness: {
            live: ['coingecko', 'coinbase'],
            dead: ['kraken']
          }
        }
      })
    });

    const out = observability.registry.render();
    expect(out).to.match(/xchain_oracle_price_source_live\{source="coingecko"\} 1\b/);
    expect(out).to.match(/xchain_oracle_price_source_live\{source="coinbase"\} 1\b/);
    expect(out).to.match(/xchain_oracle_price_source_live\{source="kraken"\} 0\b/);
  });

  it('renders no liveness sample before the first fetch', function () {
    const observability = realObservability();
    installHubOracleMetrics(observability, {
      getOracle: () => ({
        priceFetcher: { lastSourceLiveness: null }
      })
    });

    expect(observability.registry.render()).to.not.match(/xchain_oracle_price_source_live\{/);
  });

  it('moves a price source from dead to live between scrapes', function () {
    const observability = realObservability();
    let summary = { live: [], dead: ['kraken'] };
    installHubOracleMetrics(observability, {
      getOracle: () => ({
        priceFetcher: { lastSourceLiveness: summary }
      })
    });

    expect(observability.registry.render()).to.match(/xchain_oracle_price_source_live\{source="kraken"\} 0\b/);
    summary = { live: ['kraken'], dead: [] };
    expect(observability.registry.render()).to.match(/xchain_oracle_price_source_live\{source="kraken"\} 1\b/);
  });
}

describe('hub oracle price source metrics', function () {
  registerPriceSourceBoundRejectMetricsSuitePart1.call(this);
  registerPriceSourceBoundRejectMetricsSuitePart2.call(this);
  registerPriceSourceLivenessMetricsSuite.call(this);
});
