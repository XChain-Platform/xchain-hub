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

// the shared /metrics exporter and structured log shim. The suite
// pins the three properties services depend on: valid Prometheus exposition
// text, default-off wiring (no route, no timer, no socket without env), and a
// log shim that redacts credentials and never throws at a dead collector.
const {
  expect
} = require('chai');
const express = require('express');
const http = require('http');
const {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics
} = require('../../../src/observability/metrics.js');
const {
  createLogShipper,
  readLogEnv,
  redactFields,
  scrubMessage,
  REDACTED
} = require('../../../src/observability/logShipper.js');
const {
  installObservability,
  readObservabilityEnv,
  routeLabel
} = require('../../../src/observability/index.js');

// A console-shaped sink so tests never write to the mocha output.
function fakeConsole() {
  const lines = {
    log: [],
    warn: [],
    error: []
  };
  return {
    lines,
    log: m => lines.log.push(m),
    warn: m => lines.warn.push(m),
    error: m => lines.error.push(m)
  };
}
async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {
    port
  } = server.address();
  return {
    port,
    url: p => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
function registerObservabilityInstallObservabilitySuite1Part1() {
  // The registry and shipper are process-wide by design (one process is one
  // service), so a suite that installs many times has to drop them between
  // cases or it reads the previous case's service label and HTTP series.
  afterEach(function () {
    require('../../../src/observability/index.js')._resetObservability();
  });
  it('reads a default-off config from an empty env', function () {
    const cfg = readObservabilityEnv({});
    expect(cfg.metricsEnabled).to.equal(false);
    expect(cfg.httpMetrics).to.equal(false);
    expect(cfg.metricsPath).to.equal('/metrics');
    expect(cfg.log.shipEnabled).to.equal(false);
  });
  it('normalizes a METRICS_PATH given without a leading slash', function () {
    expect(readObservabilityEnv({
      METRICS_ENABLED: '1',
      METRICS_PATH: 'internal/metrics'
    }).metricsPath).to.equal('/internal/metrics');
  });
  it('registers NO route when the flag is unset, but still hands back a registry', async function () {
    const app = express();
    app.get('/health', (req, res) => res.json({
      ok: true
    }));
    const obs = installObservability(app, {
      service: 'xchain-hub',
      env: {},
      console: fakeConsole()
    });
    expect(obs.enabled).to.equal(false);
    // The registry is deliberately NOT gated: a counter a consensus module
    // registers has to exist on the default fleet, or it can never record.
    // Only the endpoint is an operator decision.
    expect(obs.registry).to.not.equal(null);
    expect(typeof obs.registry.counter).to.equal('function');
    const srv = await listen(app);
    try {
      const res = await fetch(srv.url('/metrics'));
      expect(res.status).to.equal(404);
    } finally {
      await obs.shutdown();
      await srv.close();
    }
  });
}
function registerObservabilityInstallObservabilitySuite1Part2() {
  it('serves the exposition text and instruments requests when enabled', async function () {
    const app = express();
    app.get('/health', (req, res) => res.json({
      ok: true
    }));
    const obs = installObservability(app, {
      service: 'xchain-hub',
      version: '1.0.0',
      coin: 'BTC',
      network: 'regtest',
      env: {
        METRICS_ENABLED: '1'
      },
      console: fakeConsole()
    });
    expect(obs.enabled).to.equal(true);
    const srv = await listen(app);
    try {
      await fetch(srv.url('/health'));
      await fetch(srv.url('/health'));
      await fetch(srv.url('/nope'));
      const res = await fetch(srv.url('/metrics'));
      expect(res.status).to.equal(200);
      expect(res.headers.get('content-type')).to.include('version=0.0.4');
      expect(res.headers.get('cache-control')).to.equal('no-store');
      const body = await res.text();
      expect(body).to.include('http_requests_total{method="GET",route="/health",status="200"} 2');
      expect(body).to.include('http_request_duration_seconds_count{method="GET",route="/health"} 2');
      expect(body).to.include('http_requests_in_flight 0');
      expect(body).to.include('xchain_service_info{service="xchain-hub",version="1.0.0",coin="BTC",network="regtest"');
      // The scrape itself is never counted.
      expect(body).to.not.include('route="/metrics"');
    } finally {
      await obs.shutdown();
      await srv.close();
    }
  });
}
function registerObservabilityInstallObservabilitySuite1Part3() {
  it('buckets an unmatched path by first segment so URLs cannot explode cardinality', async function () {
    const app = express();
    const obs = installObservability(app, {
      service: 'svc',
      env: {
        METRICS_ENABLED: '1'
      },
      console: fakeConsole()
    });
    const srv = await listen(app);
    try {
      await fetch(srv.url('/block/000000001'));
      await fetch(srv.url('/block/000000002'));
      const body = await (await fetch(srv.url('/metrics'))).text();
      expect(body).to.include('http_requests_total{method="GET",route="/block",status="404"} 2');
    } finally {
      await obs.shutdown();
      await srv.close();
    }
  });
  it('uses the express route pattern, not the concrete path, as the route label', function () {
    expect(routeLabel({
      route: {
        path: '/snapshot/:table'
      },
      baseUrl: '/hub-db'
    })).to.equal('/hub-db/snapshot/:table');
    expect(routeLabel({
      originalUrl: '/telemetry/summary?x=1'
    })).to.equal('/telemetry');
    expect(routeLabel({
      url: '/'
    })).to.equal('/');
  });
}
function registerObservabilityInstallObservabilitySuite1Part4() {
  it('gates the endpoint behind METRICS_TOKEN when one is configured', async function () {
    const app = express();
    const obs = installObservability(app, {
      service: 'svc',
      env: {
        METRICS_ENABLED: '1',
        METRICS_TOKEN: 'sekret-scrape'
      },
      console: fakeConsole()
    });
    const srv = await listen(app);
    try {
      expect((await fetch(srv.url('/metrics'))).status).to.equal(401);
      expect((await fetch(srv.url('/metrics'), {
        headers: {
          Authorization: 'Bearer wrong'
        }
      })).status).to.equal(401);
      const ok = await fetch(srv.url('/metrics'), {
        headers: {
          Authorization: 'Bearer sekret-scrape'
        }
      });
      expect(ok.status).to.equal(200);
      expect(await ok.text()).to.include('# TYPE');
    } finally {
      await obs.shutdown();
      await srv.close();
    }
  });
}
function registerObservabilityInstallObservabilitySuite1Part5() {
  it('honours a custom METRICS_PATH and can skip HTTP instrumentation', async function () {
    const app = express();
    app.get('/health', (req, res) => res.json({
      ok: true
    }));
    const obs = installObservability(app, {
      service: 'svc',
      env: {
        METRICS_ENABLED: '1',
        METRICS_PATH: '/internal/metrics',
        METRICS_HTTP: '0'
      },
      console: fakeConsole()
    });
    const srv = await listen(app);
    try {
      await fetch(srv.url('/health'));
      expect((await fetch(srv.url('/metrics'))).status).to.equal(404);
      const body = await (await fetch(srv.url('/internal/metrics'))).text();
      expect(body).to.include('xchain_service_info');
      expect(body).to.not.include('http_requests_total{');
    } finally {
      await obs.shutdown();
      await srv.close();
    }
  });
  it('instruments routes registered BEFORE the install call (layer is hoisted)', async function () {
    // The six services wire this at different points in their api.js; Express
    // dispatches in registration order, so without the hoist an install that
    // lands after the routes would export zero HTTP metrics.
    const app = express();
    app.get('/early', (req, res) => res.send('ok'));
    const obs = installObservability(app, {
      service: 'svc',
      env: {
        METRICS_ENABLED: '1'
      },
      console: fakeConsole()
    });
    const srv = await listen(app);
    try {
      await fetch(srv.url('/early'));
      const body = await (await fetch(srv.url('/metrics'))).text();
      expect(body).to.include('http_requests_total{method="GET",route="/early",status="200"} 1');
    } finally {
      await obs.shutdown();
      await srv.close();
    }
  });
}
function registerObservabilityInstallObservabilitySuite1Part6() {
  it('returns a usable logger even with no app to mount on', function () {
    const sink = fakeConsole();
    const obs = installObservability(null, {
      service: 'worker',
      env: {},
      console: sink
    });
    expect(obs.enabled).to.equal(false);
    obs.logger.info('tick');
    expect(sink.lines.log).to.have.lengthOf(1);
    expect(sink.lines.log[0]).to.match(/^\S+Z info \[worker\] tick$/);
  });
}
describe('observability/installObservability', function () {
  registerObservabilityInstallObservabilitySuite1Part1.call(this);
  registerObservabilityInstallObservabilitySuite1Part2.call(this);
  registerObservabilityInstallObservabilitySuite1Part3.call(this);
  registerObservabilityInstallObservabilitySuite1Part4.call(this);
  registerObservabilityInstallObservabilitySuite1Part5.call(this);
  registerObservabilityInstallObservabilitySuite1Part6.call(this);
});
