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
const express = require('express');
const http = require('http');
const vectors = require('./sql_normalize_vectors.json');
const { createSqlTiming, normalizeStatement } = require('../../../src/observability/sql_timing');

function timingEnv(overrides = {}) {
  return {
    SQL_TIMING_ENABLED: '1',
    SQL_TIMING_URL: 'https://timing.invalid/api/v1/sql-timing',
    SQL_TIMING_KEY: 'test-key',
    SQL_TIMING_PROJECT: 'xchain-platform',
    SQL_TIMING_INTERVAL_MS: '999999',
    SQL_TIMING_STATEMENT_RATE: '1',
    ...overrides
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: path => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function registerNormalizationTest() {
  it('matches every normalization vector and keeps normalized SQL fixed', function () {
    expect(vectors.length).to.be.at.least(40);
    for (const vector of vectors) {
      expect(normalizeStatement(vector.sql), vector.sql).to.equal(vector.normalized);
      expect(normalizeStatement(vector.normalized), vector.normalized).to.equal(vector.normalized);
    }
  });
}

function registerContractLineTest() {
  it('emits a contract line with all six required fields', async function () {
    const lines = [];
    const timing = createSqlTiming({
      env: timingEnv(),
      routePrefix: '/xchain-hub',
      random: () => 0,
      onLine: line => lines.push(line),
      transport: () => Promise.resolve({ status: 200 })
    });
    const pool = timing.wrapPool({ query: () => Promise.resolve([{ ok: 1 }]) });
    const app = express();
    app.use(timing.middleware);
    app.get('/health', async (req, res) => {
      await pool.query('SELECT 7');
      res.json({ ok: true });
    });
    const server = await listen(app);
    try {
      expect((await fetch(server.url('/health'))).status).to.equal(200);
      expect(lines).to.have.lengthOf(1);
      expect(lines[0]).to.include.keys(
        'timestamp', 'project', 'route', 'query_count', 'total_query_ms', 'request_ms'
      );
      expect(lines[0].project).to.equal('xchain-platform');
      expect(lines[0].route).to.equal('GET /xchain-hub/health');
      expect(lines[0].query_count).to.equal(1);
      expect(lines[0].statements[0].sql).to.equal('SELECT ?');
    } finally {
      await timing.stop();
      await server.close();
    }
  });
}

function registerRpcBatchTest() {
  it('emits one child line per method in an RPC batch', async function () {
    const lines = [];
    const timing = createSqlTiming({
      env: timingEnv({ SQL_TIMING_STATEMENT_RATE: '0' }),
      routePrefix: '/xchain-hub',
      random: () => 0,
      onLine: line => lines.push(line),
      transport: () => Promise.resolve({ status: 200 })
    });
    const queryPromise = Promise.resolve('ok');
    const pool = timing.wrapPool({ query: () => queryPromise });
    const methods = timing.wrapRpcMethods({
      alpha: () => pool.query('SELECT 1'),
      beta: async () => pool.query('SELECT 2')
    });
    expect(Object.getPrototypeOf(methods), 'no inherited names reach the router').to.equal(null);
    expect(methods.constructor).to.equal(undefined);
    const app = express();
    app.use(timing.middleware);
    app.post('/rpc', async (req, res) => {
      const alpha = methods.alpha();
      expect(alpha).to.equal(queryPromise);
      await Promise.all([alpha, methods.beta()]);
      res.json({ ok: true });
    });
    const server = await listen(app);
    try {
      expect((await fetch(server.url('/rpc'), { method: 'POST' })).status).to.equal(200);
      expect(lines.map(line => line.route).sort()).to.deep.equal([
        'POST /xchain-hub/rpc/alpha',
        'POST /xchain-hub/rpc/beta'
      ]);
      expect(lines.map(line => line.query_count)).to.deep.equal([1, 1]);
    } finally {
      await timing.stop();
      await server.close();
    }
  });
}

function registerUnmatchedPathTest() {
  it('emits nothing for an unmatched path', async function () {
    const lines = [];
    const timing = createSqlTiming({
      env: timingEnv(),
      routePrefix: '/xchain-hub',
      onLine: line => lines.push(line),
      transport: () => Promise.resolve({ status: 200 })
    });
    const app = express();
    app.use(timing.middleware);
    const server = await listen(app);
    try {
      expect((await fetch(server.url('/not-a-route'))).status).to.equal(404);
      expect(lines).to.deep.equal([]);
    } finally {
      await timing.stop();
      await server.close();
    }
  });
}

function registerDisabledBehaviorTest() {
  it('returns pools, methods, promises and middleware behavior unchanged when disabled', async function () {
    const timing = createSqlTiming({ env: {} });
    const promise = Promise.resolve('same');
    const pool = { query: () => promise };
    const methods = { ping: () => 'pong' };
    expect(timing.wrapPool(pool)).to.equal(pool);
    expect(timing.wrapRpcMethods(methods)).to.equal(methods);
    expect(pool.query()).to.equal(promise);
    let nextCalls = 0;
    timing.middleware({}, {}, () => { nextCalls += 1; });
    expect(nextCalls).to.equal(1);
    await timing.stop();
  });
}

function registerDirectCredentialsTest() {
  it('accepts credentials as direct create options while the flag remains env-gated', async function () {
    const timing = createSqlTiming({
      project: 'xchain-platform',
      url: 'https://timing.invalid/api/v1/sql-timing',
      apiKey: 'test-key',
      env: {
        SQL_TIMING_ENABLED: '1',
        SQL_TIMING_INTERVAL_MS: '999999'
      },
      transport: () => Promise.resolve({ status: 200 })
    });
    expect(timing.enabled).to.equal(true);
    await timing.stop();
  });
}

function registerPromiseIdentityTest() {
  it('keeps the original database promise while accounting asynchronously', async function () {
    const timing = createSqlTiming({
      env: timingEnv(),
      routePrefix: '/xchain-hub',
      transport: () => Promise.resolve({ status: 200 })
    });
    const original = Promise.resolve('result');
    const pool = timing.wrapPool({ query: () => original });
    expect(pool.query('SELECT 1')).to.equal(original);
    await timing.stop();
  });
}

function registerConnectionAcquisitionTest() {
  it('wraps acquired connections without replacing the acquisition promise', async function () {
    const lines = [];
    const connection = { execute: () => Promise.resolve('done') };
    const acquisition = Promise.resolve(connection);
    const timing = createSqlTiming({
      env: timingEnv({ SQL_TIMING_STATEMENT_RATE: '0' }),
      routePrefix: '/xchain-hub',
      random: () => 0,
      onLine: line => lines.push(line),
      transport: () => Promise.resolve({ status: 200 })
    });
    const pool = timing.wrapPool({ getConnection: () => acquisition });
    const app = express();
    app.use(timing.middleware);
    app.get('/connection', async (req, res) => {
      const pending = pool.getConnection();
      expect(pending).to.equal(acquisition);
      const acquired = await pending;
      await acquired.execute('SELECT 5');
      res.send('ok');
    });
    const server = await listen(app);
    try {
      expect((await fetch(server.url('/connection'))).status).to.equal(200);
      expect(lines).to.have.lengthOf(1);
      expect(lines[0].query_count).to.equal(1);
    } finally {
      await timing.stop();
      await server.close();
    }
  });
}

function registerMountedRouterTest() {
  it('uses the service prefix with a mounted router route', async function () {
    const lines = [];
    const timing = createSqlTiming({
      env: timingEnv(),
      routePrefix: '/xchain-hub',
      onLine: line => lines.push(line),
      transport: () => Promise.resolve({ status: 200 })
    });
    const router = express.Router();
    router.get('/item/:id', (req, res) => res.send('ok'));
    const app = express();
    app.use(timing.middleware);
    app.use('/api', router);
    const server = await listen(app);
    try {
      expect((await fetch(server.url('/api/item/123'))).status).to.equal(200);
      expect(lines[0].route).to.equal('GET /xchain-hub/api/item/:id');
    } finally {
      await timing.stop();
      await server.close();
    }
  });
}

describe('observability/sql_timing', function () {
  registerNormalizationTest();
  registerContractLineTest();
  registerRpcBatchTest();
  registerUnmatchedPathTest();
  registerDisabledBehaviorTest();
  registerDirectCredentialsTest();
  registerPromiseIdentityTest();
  registerConnectionAcquisitionTest();
  registerMountedRouterTest();
});
