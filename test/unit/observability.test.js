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
} = require('../../src/observability/metrics.js');
const {
  createLogShipper,
  readLogEnv,
  redactFields,
  scrubMessage,
  REDACTED
} = require('../../src/observability/logShipper.js');
const {
  installObservability,
  readObservabilityEnv,
  routeLabel
} = require('../../src/observability/index.js');

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
function registerObservabilityMetricsExpositionFormatSuite1Part1() {
  it('renders a counter with HELP, TYPE and labelled samples', function () {
    const reg = new Registry();
    const c = reg.counter({
      name: 'test_requests_total',
      help: 'Requests',
      labelNames: ['route']
    });
    c.inc({
      route: '/a'
    }, 2);
    c.inc({
      route: '/a'
    });
    c.inc({
      route: '/b'
    });
    const out = reg.render();
    expect(out).to.include('# HELP test_requests_total Requests');
    expect(out).to.include('# TYPE test_requests_total counter');
    expect(out).to.include('test_requests_total{route="/a"} 3');
    expect(out).to.include('test_requests_total{route="/b"} 1');
    expect(out.endsWith('\n')).to.equal(true);
  });
  it('rejects invalid metric and label names at declaration', function () {
    const reg = new Registry();
    expect(() => reg.counter({
      name: '9bad',
      help: 'x'
    })).to.throw(/invalid metric name/);
    expect(() => reg.counter({
      name: 'ok_total',
      help: 'x',
      labelNames: ['bad-label']
    })).to.throw(/invalid label name/);
    expect(() => reg.counter({
      name: 'ok2_total',
      help: 'x',
      labelNames: ['__name__']
    })).to.throw(/reserved/);
  });
  it('hands back the same metric when an identical declaration repeats', function () {
    // Modules register their counters wherever they are required, and the
    // registry is now process-wide, so an identical re-declaration is a
    // normal event rather than a conflict.
    const reg = new Registry();
    const first = reg.gauge({
      name: 'dup_gauge',
      help: 'x'
    });
    expect(reg.gauge({
      name: 'dup_gauge',
      help: 'y'
    })).to.equal(first);
  });
}
function registerObservabilityMetricsExpositionFormatSuite1Part2() {
  it('still refuses a duplicate name declared with a different shape', function () {
    const reg = new Registry();
    reg.gauge({
      name: 'shape_clash',
      help: 'x'
    });
    expect(() => reg.counter({
      name: 'shape_clash',
      help: 'x'
    })).to.throw(/different shape/);
    reg.gauge({
      name: 'label_clash',
      help: 'x',
      labelNames: ['a']
    });
    expect(() => reg.gauge({
      name: 'label_clash',
      help: 'x',
      labelNames: ['b']
    })).to.throw(/different shape/);
  });
  it('rejects a negative counter increment and an unknown label', function () {
    const reg = new Registry();
    const c = reg.counter({
      name: 'neg_total',
      help: 'x',
      labelNames: ['a']
    });
    expect(() => c.inc({
      a: '1'
    }, -1)).to.throw(/non-negative/);
    expect(() => c.inc({
      b: '1'
    }, 1)).to.throw(/unknown label/);
  });
  it('escapes backslash, quote and newline in label values and help', function () {
    const reg = new Registry();
    const c = reg.counter({
      name: 'esc_total',
      help: 'line1\nline2 \\ end',
      labelNames: ['v']
    });
    c.inc({
      v: 'a"b\\c\nd'
    });
    const out = reg.render();
    expect(out).to.include('# HELP esc_total line1\\nline2 \\\\ end');
    expect(out).to.include('esc_total{v="a\\"b\\\\c\\nd"} 1');
    // No raw newline may appear inside a sample line.
    for (const line of out.trim().split('\n')) expect(line).to.not.equal('');
  });
}
function registerObservabilityMetricsExpositionFormatSuite1Part3() {
  it('treats label order as declared order, not caller order', function () {
    const reg = new Registry();
    const c = reg.counter({
      name: 'order_total',
      help: 'x',
      labelNames: ['a', 'b']
    });
    c.inc({
      a: '1',
      b: '2'
    });
    c.inc({
      b: '2',
      a: '1'
    });
    expect(c.get({
      a: '1',
      b: '2'
    })).to.equal(2);
    expect(reg.render().split('\n').filter(l => l.startsWith('order_total{')).length).to.equal(1);
  });
  it('emits cumulative histogram buckets with +Inf equal to _count', function () {
    const reg = new Registry();
    const h = reg.histogram({
      name: 'lat_seconds',
      help: 'x',
      labelNames: ['route'],
      buckets: [0.1, 0.5, 1]
    });
    h.observe({
      route: '/a'
    }, 0.05);
    h.observe({
      route: '/a'
    }, 0.3);
    h.observe({
      route: '/a'
    }, 2);
    const out = reg.render();
    expect(out).to.include('# TYPE lat_seconds histogram');
    expect(out).to.include('lat_seconds_bucket{route="/a",le="0.1"} 1');
    expect(out).to.include('lat_seconds_bucket{route="/a",le="0.5"} 2');
    expect(out).to.include('lat_seconds_bucket{route="/a",le="1"} 2');
    expect(out).to.include('lat_seconds_bucket{route="/a",le="+Inf"} 3');
    expect(out).to.include('lat_seconds_count{route="/a"} 3');
    expect(out).to.include('lat_seconds_sum{route="/a"} 2.35');
  });
}
function registerObservabilityMetricsExpositionFormatSuite1Part4() {
  it('ignores a non-finite histogram observation instead of poisoning the sum', function () {
    const reg = new Registry();
    const h = reg.histogram({
      name: 'nan_seconds',
      help: 'x',
      buckets: [1]
    });
    h.observe({}, Number.NaN);
    h.observe({}, Infinity);
    h.observe({}, 0.5);
    expect(h.get({}).count).to.equal(1);
    expect(h.get({}).sum).to.equal(0.5);
  });
  it('reserves le for histogram buckets', function () {
    const reg = new Registry();
    expect(() => reg.histogram({
      name: 'le_seconds',
      help: 'x',
      labelNames: ['le']
    })).to.throw(/reserved/);
  });
  it('caps series per metric and counts the drops instead of growing', function () {
    const reg = new Registry({
      maxSeries: 3
    });
    const c = reg.counter({
      name: 'card_total',
      help: 'x',
      labelNames: ['id']
    });
    for (let i = 0; i < 10; i++) c.inc({
      id: `id-${i}`
    });
    expect(c.series.size).to.equal(3);
    expect(reg.get('xchain_metrics_series_dropped_total').get({
      metric: 'card_total'
    })).to.equal(7);
    expect(reg.render()).to.include('xchain_metrics_series_dropped_total{metric="card_total"} 7');
  });
  it('gauge set/inc/dec track a value and reject a non-finite set', function () {
    const reg = new Registry();
    const g = reg.gauge({
      name: 'depth',
      help: 'x'
    });
    g.set({}, 5);
    g.inc({}, 2);
    g.dec({}, 3);
    expect(g.get({})).to.equal(4);
    expect(() => g.set({}, Number.NaN)).to.throw(/finite/);
  });
}
function registerObservabilityMetricsExpositionFormatSuite1Part5() {
  it('setMonotonic never lets a collector-driven counter go backwards', function () {
    const reg = new Registry();
    const c = reg.counter({
      name: 'cpu_total',
      help: 'x'
    });
    c.setMonotonic({}, 10);
    c.setMonotonic({}, 4);
    expect(c.get({})).to.equal(10);
  });
  it('survives a throwing collector and still renders the rest', function () {
    const reg = new Registry();
    reg.counter({
      name: 'ok_total',
      help: 'x'
    }).inc({});
    reg.addCollector(() => {
      throw new Error('boom');
    });
    expect(reg.render()).to.include('ok_total 1');
  });
  it('collectDefaultMetrics exposes process and service identity', function () {
    const reg = new Registry();
    collectDefaultMetrics(reg, {
      service: 'xchain-hub',
      version: '1.2.3',
      coin: 'BTC',
      network: 'regtest'
    });
    const out = reg.render();
    expect(out).to.include('xchain_service_info{service="xchain-hub",version="1.2.3",coin="BTC",network="regtest"');
    expect(out).to.match(/process_resident_memory_bytes \d+/);
    expect(out).to.match(/process_cpu_user_seconds_total [\d.]+/);
    expect(out).to.include('# TYPE process_cpu_user_seconds_total counter');
    expect(out).to.match(/nodejs_heap_size_used_bytes \d+/);
  });
  it('exports the Prometheus content type', function () {
    expect(new Registry().contentType()).to.equal('text/plain; version=0.0.4; charset=utf-8');
  });
}
function registerObservabilityMetricsExpositionFormatSuite1Part6() {
  it('metric classes are usable standalone', function () {
    expect(new Counter({
      name: 'a_total',
      help: 'x'
    }).inc({}, 2)).to.equal(2);
    const g = new Gauge({
      name: 'b',
      help: 'x'
    });
    g.set({}, 1);
    expect(g.get({})).to.equal(1);
    const h = new Histogram({
      name: 'c',
      help: 'x'
    });
    h.observe({}, 1);
    expect(h.get({}).count).to.equal(1);
  });
}
describe('observability/metrics: exposition format', function () {
  registerObservabilityMetricsExpositionFormatSuite1Part1.call(this);
  registerObservabilityMetricsExpositionFormatSuite1Part2.call(this);
  registerObservabilityMetricsExpositionFormatSuite1Part3.call(this);
  registerObservabilityMetricsExpositionFormatSuite1Part4.call(this);
  registerObservabilityMetricsExpositionFormatSuite1Part5.call(this);
  registerObservabilityMetricsExpositionFormatSuite1Part6.call(this);
});
