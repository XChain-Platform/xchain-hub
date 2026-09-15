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
function registerObservabilityLogShipperSuite1Part1() {
  it('is inert by default: text output, no buffering, no shipping', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {},
      console: sink
    });
    log.info('hello world');
    expect(log.config.shipEnabled).to.equal(false);
    expect(log.buffer.length).to.equal(0);
    expect(log.timer).to.equal(null);
    expect(sink.lines.log).to.have.lengthOf(1);
    expect(sink.lines.log[0]).to.match(/^\S+Z info \[svc\] hello world$/);
  });
  it('emits NDJSON with the envelope keys when LOG_FORMAT=json', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'xchain-hub',
      version: '9.9.9',
      env: {
        LOG_FORMAT: 'json'
      },
      console: sink
    });
    log.warn('block stalled', {
      height: 42
    });
    const rec = JSON.parse(sink.lines.warn[0]);
    expect(rec.level).to.equal('warn');
    expect(rec.service).to.equal('xchain-hub');
    expect(rec.msg).to.equal('block stalled');
    expect(rec.height).to.equal(42);
    expect(rec.version).to.equal('9.9.9');
    expect(new Date(rec.ts).toISOString()).to.equal(rec.ts);
  });
  it('honours LOG_LEVEL and drops quieter levels', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_LEVEL: 'warn'
      },
      console: sink
    });
    expect(log.info('quiet')).to.equal(null);
    expect(log.error('loud')).to.not.equal(null);
    expect(sink.lines.log.length).to.equal(0);
  });
}
function registerObservabilityLogShipperSuite1Part2() {
  it('redacts credential-shaped field keys and inline key=value pairs', function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_FORMAT: 'json'
      },
      console: sink
    });
    const rec = log.info('connect password=hunter2 then api_key: abc123', {
      db: {
        user: 'app',
        password: 'hunter2'
      },
      HUB_API_KEY: 'zzz',
      height: 7
    });
    expect(rec.db.password).to.equal(REDACTED);
    expect(rec.db.user).to.equal('app');
    expect(rec.HUB_API_KEY).to.equal(REDACTED);
    expect(rec.height).to.equal(7);
    expect(rec.msg).to.not.include('hunter2');
    expect(rec.msg).to.not.include('abc123');
    expect(JSON.stringify(rec)).to.not.include('hunter2');
  });
  it('never lets a caller field forge the record envelope', function () {
    const log = createLogShipper({
      service: 'real-svc',
      env: {},
      console: fakeConsole()
    });
    const rec = log.info('m', {
      service: 'spoofed',
      level: 'debug',
      msg: 'spoofed'
    });
    expect(rec.service).to.equal('real-svc');
    expect(rec.level).to.equal('info');
    expect(rec.msg).to.equal('m');
  });
}
function registerObservabilityLogShipperSuite1Part3() {
  it('handles cyclic and deep field graphs without throwing', function () {
    const a = {
      name: 'a'
    };
    a.self = a;
    expect(redactFields(a).self).to.equal('[circular]');
    expect(redactFields({
      a: {
        b: {
          c: {
            d: {
              e: 1
            }
          }
        }
      }
    }).a.b.c.d).to.equal('[truncated]');
    expect(scrubMessage('token=abc')).to.equal(`token=${REDACTED}`);
  });
  it('serializes an Error field with a scrubbed message', function () {
    const out = redactFields({
      err: new Error('login failed for password=hunter2')
    });
    expect(out.err.message).to.include(REDACTED);
    expect(out.err.message).to.not.include('hunter2');
  });
  it('requires BOTH the flag and a valid URL before shipping', function () {
    expect(readLogEnv({
      LOG_SHIP_ENABLED: '1'
    }).shipEnabled).to.equal(false);
    expect(readLogEnv({
      LOG_SHIP_URL: 'https://c/logs'
    }).shipEnabled).to.equal(false);
    expect(readLogEnv({
      LOG_SHIP_ENABLED: '1',
      LOG_SHIP_URL: 'ftp://c/logs'
    }).shipEnabled).to.equal(false);
    expect(readLogEnv({
      LOG_SHIP_ENABLED: 'true',
      LOG_SHIP_URL: 'https://c/logs'
    }).shipEnabled).to.equal(true);
  });
}
function registerObservabilityLogShipperSuite1Part4() {
  it('batches NDJSON to the transport once the batch size is reached', async function () {
    const bodies = [];
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_SHIP_ENABLED: '1',
        LOG_SHIP_URL: 'https://collector.invalid/logs',
        LOG_SHIP_BATCH_SIZE: '2'
      },
      console: fakeConsole(),
      transport: body => {
        bodies.push(body);
        return Promise.resolve();
      }
    });
    log.info('one');
    log.info('two');
    await new Promise(r => setImmediate(r));
    await log.stop();
    expect(bodies.length).to.equal(1);
    const lines = bodies[0].trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => l.msg)).to.deep.equal(['one', 'two']);
    expect(log.stats.shipped).to.equal(2);
  });
  it('drops the oldest lines when the buffer is full and counts the loss', function () {
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_SHIP_ENABLED: '1',
        LOG_SHIP_URL: 'https://collector.invalid/logs',
        LOG_SHIP_BATCH_SIZE: '1000',
        LOG_SHIP_MAX_BUFFER: '3'
      },
      console: fakeConsole(),
      transport: () => new Promise(() => {}) // never settles: buffer fills
    });
    for (let i = 0; i < 6; i++) log.info(`line-${i}`);
    expect(log.buffer.length).to.equal(3);
    expect(log.stats.dropped).to.equal(3);
    expect(log.buffer.map(r => r.msg)).to.deep.equal(['line-3', 'line-4', 'line-5']);
  });
}
function registerObservabilityLogShipperSuite1Part5() {
  it('survives a failing collector, re-queues the batch and rate-limits the stderr note', async function () {
    const sink = fakeConsole();
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_SHIP_ENABLED: '1',
        LOG_SHIP_URL: 'https://collector.invalid/logs',
        LOG_SHIP_BATCH_SIZE: '1'
      },
      console: sink,
      transport: () => Promise.reject(new Error('ECONNREFUSED'))
    });
    log.info('a');
    await log.flush();
    log.info('b');
    await log.flush();
    expect(log.stats.failures).to.be.greaterThan(0);
    expect(log.stats.shipped).to.equal(0);
    expect(log.buffer.length).to.be.greaterThan(0);
    // One note per minute, so the second failure adds no line.
    expect(sink.lines.error.filter(l => l.includes('[log-ship]')).length).to.equal(1);
    await log.stop();
  });
  it('exposes shipper counters on a registry when one is supplied', function () {
    const reg = new Registry();
    const log = createLogShipper({
      service: 'svc',
      env: {},
      console: fakeConsole(),
      registry: reg
    });
    log.info('x');
    log.error('y');
    const out = reg.render();
    expect(out).to.include('log_lines_emitted_total{level="info"} 1');
    expect(out).to.include('log_lines_emitted_total{level="error"} 1');
    expect(out).to.include('log_ship_buffer_lines 0');
  });
}
function registerObservabilityLogShipperSuite1Part6() {
  it('stop() clears the flush timer so the process can exit', async function () {
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_SHIP_ENABLED: '1',
        LOG_SHIP_URL: 'https://collector.invalid/logs'
      },
      console: fakeConsole(),
      transport: () => Promise.resolve()
    });
    expect(log.timer).to.not.equal(null);
    await log.stop();
    expect(log.timer).to.equal(null);
  });

  // Exercises the real _post/fetch path. Every other test here injects a
  // transport, which is why the unreleased response body below went unseen.
}
function registerObservabilityLogShipperSuite1Part7() {
  it('releases the response body so a stalled collector cannot pin the socket', async function () {
    this.timeout(5000);
    let closed = false;
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      req.resume();
      // Answer with headers and a first chunk, then never end the body.
      req.on('end', () => {
        res.writeHead(200);
        res.write('ack');
      });
      res.socket.on('close', () => {
        closed = true;
      });
    });
    server.on('connection', s => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const {
      port
    } = server.address();
    const log = createLogShipper({
      service: 'svc',
      env: {
        LOG_SHIP_ENABLED: '1',
        LOG_SHIP_URL: `http://127.0.0.1:${port}/logs`,
        LOG_SHIP_BATCH_SIZE: '1',
        LOG_SHIP_TIMEOUT_MS: '400'
      },
      console: fakeConsole()
    });
    try {
      log.info('one');
      await log.flush();
      // fetch() resolves on headers and the abort timer is cleared with it,
      // so an unreleased body leaves nothing that will ever close this
      // socket. Measured: released in under 2ms, unreleased still open at 3s.
      for (let i = 0; i < 100 && !closed; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(closed).to.equal(true);
    } finally {
      await log.stop();
      for (const s of sockets) s.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
describe('observability/logShipper', function () {
  registerObservabilityLogShipperSuite1Part1.call(this);
  registerObservabilityLogShipperSuite1Part2.call(this);
  registerObservabilityLogShipperSuite1Part3.call(this);
  registerObservabilityLogShipperSuite1Part4.call(this);
  registerObservabilityLogShipperSuite1Part5.call(this);
  registerObservabilityLogShipperSuite1Part6.call(this);
  registerObservabilityLogShipperSuite1Part7.call(this);
});
