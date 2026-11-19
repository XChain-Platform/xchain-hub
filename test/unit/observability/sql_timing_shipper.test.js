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
const { Registry } = require('../../../src/observability/metrics');
const {
  createSqlTimingShipper,
  readSqlTimingEnv
} = require('../../../src/observability/sql_timing_shipper');

function timingEnv(overrides = {}) {
  return {
    SQL_TIMING_ENABLED: '1',
    SQL_TIMING_URL: 'https://timing.invalid/api/v1/sql-timing',
    SQL_TIMING_KEY: 'test-secret-key',
    SQL_TIMING_PROJECT: 'xchain-platform',
    SQL_TIMING_INTERVAL_MS: '999999',
    ...overrides
  };
}

function sink() {
  const errors = [];
  return { errors, error: line => errors.push(line), log: line => errors.push(line) };
}

function registerConfigurationTest() {
  it('stays disabled unless the complete HTTPS configuration is present', function () {
    expect(readSqlTimingEnv({}).enabled).to.equal(false);
    expect(readSqlTimingEnv(timingEnv({ SQL_TIMING_KEY: '' })).enabled).to.equal(false);
    expect(readSqlTimingEnv(timingEnv({ SQL_TIMING_URL: 'http://timing.invalid' })).enabled).to.equal(false);
    expect(readSqlTimingEnv(timingEnv()).enabled).to.equal(true);
  });
}

function registerSuccessfulDeliveryTest() {
  it('posts NDJSON with the timing key header and clears a 200 batch', async function () {
    const requests = [];
    const shipper = createSqlTimingShipper({
      env: timingEnv(),
      console: sink(),
      transport: request => { requests.push(request); return Promise.resolve({ status: 200 }); }
    });
    shipper.enqueue({ route: 'GET /xchain-hub/health' });
    await shipper.flush();
    expect(shipper.buffer).to.deep.equal([]);
    expect(shipper.stats.shipped).to.equal(1);
    expect(requests[0].headers['Content-Type']).to.equal('application/x-ndjson');
    expect(requests[0].headers.Authorization).to.equal('Bearer test-secret-key');
    expect(requests[0].body).to.equal('{"route":"GET /xchain-hub/health"}\n');
    await shipper.stop();
  });
}

function registerDroppedResponseTests() {
  for (const status of [400, 413]) {
    it(`drops and counts a ${status} batch`, async function () {
      const shipper = createSqlTimingShipper({
        env: timingEnv(),
        console: sink(),
        transport: () => Promise.resolve({ status })
      });
      shipper.enqueue('{}');
      shipper.enqueue('{}');
      await shipper.flush();
      expect(shipper.buffer).to.deep.equal([]);
      expect(shipper.stats.dropped).to.equal(2);
      expect(shipper.stats.failures).to.equal(1);
      await shipper.stop();
    });
  }
}

function registerRetriedResponseTests() {
  for (const status of [429, 503]) {
    it(`re-queues a ${status} batch within the buffer cap`, async function () {
      const shipper = createSqlTimingShipper({
        env: timingEnv({ SQL_TIMING_MAX_BUFFER: '2' }),
        console: sink(),
        transport: () => Promise.resolve({ status })
      });
      shipper.enqueue('{"line":1}');
      shipper.enqueue('{"line":2}');
      await shipper.flush();
      expect(shipper.buffer).to.deep.equal(['{"line":1}', '{"line":2}']);
      expect(shipper.stats.dropped).to.equal(0);
      expect(shipper.stats.failures).to.equal(1);
      shipper.config.enabled = false;
      await shipper.stop();
    });
  }
}

function registerBufferCapTest() {
  it('drops the oldest line when the queue reaches its cap', async function () {
    const shipper = createSqlTimingShipper({
      env: timingEnv({ SQL_TIMING_MAX_BUFFER: '2' }),
      console: sink(),
      transport: () => Promise.resolve({ status: 200 })
    });
    shipper.enqueue('{"line":1}');
    shipper.enqueue('{"line":2}');
    shipper.enqueue('{"line":3}');
    expect(shipper.buffer).to.deep.equal(['{"line":2}', '{"line":3}']);
    expect(shipper.stats.dropped).to.equal(1);
    await shipper.stop();
  });
}

function registerRedactionTest() {
  it('never writes the API key into a stderr note', async function () {
    const output = sink();
    const shipper = createSqlTimingShipper({
      env: timingEnv(),
      console: output,
      transport: () => Promise.reject(new Error('request failed for test-secret-key'))
    });
    shipper.enqueue('{}');
    await shipper.flush();
    expect(output.errors).to.have.lengthOf(1);
    expect(output.errors[0]).to.not.include('test-secret-key');
    shipper.config.enabled = false;
    await shipper.stop();
  });
}

function registerRegistryCountersTest() {
  it('publishes shipped, dropped and failure counters when given a registry', async function () {
    const registry = new Registry();
    const shipper = createSqlTimingShipper({
      env: timingEnv(),
      registry,
      console: sink(),
      transport: () => Promise.resolve({ status: 400 })
    });
    shipper.enqueue('{}');
    await shipper.flush();
    const text = registry.render();
    expect(text).to.include('sql_timing_lines_shipped_total 0');
    expect(text).to.include('sql_timing_lines_dropped_total 1');
    expect(text).to.include('sql_timing_ship_failures_total 1');
    await shipper.stop();
  });
}

function registerRequestLineLimitTest() {
  it('limits one request to 2000 contract lines', async function () {
    const requests = [];
    const shipper = createSqlTimingShipper({
      env: timingEnv(),
      console: sink(),
      transport: request => { requests.push(request); return Promise.resolve({ status: 200 }); }
    });
    for (let line = 0; line < 2001; line += 1) shipper.enqueue(`{"line":${line}}`);
    await shipper.flush();
    expect(requests[0].body.trim().split('\n')).to.have.lengthOf(2000);
    expect(shipper.buffer).to.have.lengthOf(1);
    await shipper.stop();
  });
}

describe('observability/sql_timing_shipper', function () {
  registerConfigurationTest();
  registerSuccessfulDeliveryTest();
  registerDroppedResponseTests();
  registerRetriedResponseTests();
  registerBufferCapTest();
  registerRedactionTest();
  registerRegistryCountersTest();
  registerRequestLineLimitTest();
});
