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

// The fleet runs text mode, so text mode is where the structured record has to
// survive. Before this, _emitLocal's text branch printed the message alone and
// threw the whole record away: LOG_LEVEL and LOG_FORMAT changed nothing an
// operator could see on any box.
function registerObservabilityLogShipperTextWithFieldsFormaSuite2Part1() {
  it('renders ts, lowercase level, service tag, message, then key=value', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'xchain-hub',
      env: {},
      console: sink
    });
    log.warn('PBFT_DROP', {
      reason: 'digest_mismatch',
      phase: 'prepare',
      round: 42
    });
    expect(sink.lines.warn).to.have.lengthOf(1);
    expect(sink.lines.warn[0]).to.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z warn \[xchain-hub\] PBFT_DROP reason=digest_mismatch phase=prepare round=42$/);
  });
  it('keeps the level token lowercase so the server-monitor ERROR|FATAL grep does not match it', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {},
      console: sink
    });
    log.error('boom');
    // collect-snapshot.sh counts `grep -cE 'ERROR|FATAL'`. An uppercase
    // token would make every console.error line count and trip the crit
    // threshold fleet-wide on first deploy.
    expect(sink.lines.error[0]).to.not.match(/ERROR|FATAL/);
    expect(sink.lines.error[0]).to.include(' error [svc] boom');
  });
  it('puts the message immediately after the service tag so existing substring greps still match', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'xchain-hub',
      env: {},
      console: sink
    });
    log.info('Oracle: Round 12 finalized');
    expect(sink.lines.log[0]).to.include('Oracle: Round 12 finalized');
  });
}
function registerObservabilityLogShipperTextWithFieldsFormaSuite2Part2() {
  it('quotes a value carrying whitespace, = or a quote, and leaves plain tokens bare', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {},
      console: sink
    });
    log.info('m', {
      plain: 'abc',
      spaced: 'a b',
      eq: 'k=v',
      num: 3,
      flag: true,
      nil: null
    });
    const line = sink.lines.log[0];
    expect(line).to.include('plain=abc');
    expect(line).to.include('spaced="a b"');
    expect(line).to.include('eq="k=v"');
    expect(line).to.include('num=3');
    expect(line).to.include('flag=true');
    expect(line).to.include('nil=null');
  });
  it('redacts a credential-shaped field and an inline credential in the message', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {},
      console: sink
    });
    log.warn('connect failed password=hunter2', {
      db_password: 'hunter2',
      host: 'db1'
    });
    const line = sink.lines.warn[0];
    expect(line).to.not.include('hunter2');
    expect(line).to.include(REDACTED);
    expect(line).to.include('host=db1');
  });
}
function registerObservabilityLogShipperTextWithFieldsFormaSuite2Part3() {
  it('emits one NDJSON record per line under LOG_FORMAT=json', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_FORMAT: 'json'
      },
      console: sink
    });
    log.info('hello', {
      a: 1
    });
    const parsed = JSON.parse(sink.lines.log[0]);
    expect(parsed).to.include({
      level: 'info',
      service: 'svc',
      msg: 'hello',
      a: 1
    });
    expect(parsed.ts).to.be.a('string');
  });
  it('silences info under LOG_LEVEL=warn while still emitting warn', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_LEVEL: 'warn'
      },
      console: sink
    });
    log.info('quiet');
    log.warn('loud');
    expect(sink.lines.log).to.have.lengthOf(0);
    expect(sink.lines.warn).to.have.lengthOf(1);
  });
}
describe('observability/logShipper: text-with-fields format', function () {
  registerObservabilityLogShipperTextWithFieldsFormaSuite2Part1.call(this);
  registerObservabilityLogShipperTextWithFieldsFormaSuite2Part2.call(this);
  registerObservabilityLogShipperTextWithFieldsFormaSuite2Part3.call(this);
});
