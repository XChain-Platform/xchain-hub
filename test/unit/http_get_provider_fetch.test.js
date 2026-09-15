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
 **********************************************************************
 *
 * XChain Hub - http_get attestation provider tests (byte_equality agree)
 *
 ********************************************************************/

'use strict';

const {
  expect
} = require('chai');
const sinon = require('sinon');
const nock = require('nock');
const dns = require('dns');
const httpGet = require('../../src/providers/http_get.js');

// Resolve every hostname to a public address so unit tests never touch real
// DNS (the SSRF guard resolves before nock's request interception kicks in).
function stubPublicDns() {
  sinon.stub(dns.promises, 'lookup').resolves([{
    address: '93.184.216.34',
    family: 4
  }]);
}
function p(body, meta) {
  return {
    body: Buffer.from(body, 'utf8'),
    meta: String(meta || '200')
  };
}

// ---- fetch() ---------------------------------------------------------------
function registerHttpGetFetchSuite1Part1() {
  beforeEach(stubPublicDns);
  afterEach(function () {
    nock.cleanAll();
    sinon.restore();
  });
  it('rejects when payload is missing or not a string', async function () {
    let err;
    err = null;
    try {
      await httpGet.fetch(null, {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/payload must be a string URL/);
    err = null;
    try {
      await httpGet.fetch(undefined, {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/payload must be a string URL/);
    err = null;
    try {
      await httpGet.fetch(42, {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/payload must be a string URL/);
  });
  it('rejects when the URL is invalid', async function () {
    let err;
    try {
      await httpGet.fetch('not-a-url', {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/invalid URL/);
  });
  it('rejects http:// URLs (only https:// allowed)', async function () {
    let err;
    try {
      await httpGet.fetch('http://example.com/', {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/only https/);
  });
}
function registerHttpGetFetchSuite1Part2() {
  it('returns { body: Buffer, meta: statusCode } for a successful 200 response', async function () {
    nock('https://example.com').get('/data').reply(200, 'response body');
    const result = await httpGet.fetch('https://example.com/data', {});
    expect(Buffer.isBuffer(result.body)).to.equal(true);
    expect(result.body.toString()).to.equal('response body');
    expect(result.meta).to.equal('200');
  });
  it('preserves a non-200 status code in meta', async function () {
    nock('https://example.com').get('/notfound').reply(404, 'not found');
    const result = await httpGet.fetch('https://example.com/notfound', {});
    expect(result.meta).to.equal('404');
    expect(result.body.toString()).to.equal('not found');
  });
  it('uses default maxResponseBytes (32768) and rejects when exceeded', async function () {
    // Build a response that is 32769 bytes, one byte over the default cap.
    const big = Buffer.alloc(32769, 'x');
    nock('https://example.com').get('/big').reply(200, big);
    let err;
    try {
      await httpGet.fetch('https://example.com/big', {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/exceeds maxResponseBytes/);
  });
  it('honours a custom maxResponseBytes option', async function () {
    const body = Buffer.alloc(11, 'A');
    nock('https://example.com').get('/small').reply(200, body);
    // 10 byte cap: 11 bytes should trigger overflow
    let err;
    try {
      await httpGet.fetch('https://example.com/small', {
        maxResponseBytes: 10
      });
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/exceeds maxResponseBytes \(10\)/);
  });
  it('accepts a response exactly at the maxResponseBytes limit', async function () {
    const body = Buffer.alloc(10, 'B');
    nock('https://example.com').get('/exact').reply(200, body);
    const result = await httpGet.fetch('https://example.com/exact', {
      maxResponseBytes: 10
    });
    expect(result.body.length).to.equal(10);
  });
}
function registerHttpGetFetchSuite1Part3() {
  it('rejects on a request-level network error', async function () {
    nock('https://broken.example.com').get('/').replyWithError('ECONNREFUSED');
    let err;
    try {
      await httpGet.fetch('https://broken.example.com/', {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/request error/);
  });
  it('uses path + querystring from the URL', async function () {
    nock('https://example.com').get('/api/v1/test?foo=bar').reply(200, 'ok');
    const result = await httpGet.fetch('https://example.com/api/v1/test?foo=bar', {});
    expect(result.meta).to.equal('200');
  });
  it('uses default port 443 (no explicit port in URL)', async function () {
    nock('https://example.com:443').get('/porttest').reply(200, 'portok');
    const result = await httpGet.fetch('https://example.com/porttest', {});
    expect(result.meta).to.equal('200');
  });
  it('returns a valid result for an empty-body 204 response', async function () {
    nock('https://example.com').get('/empty').reply(204, '');
    const result = await httpGet.fetch('https://example.com/empty', {});
    expect(result.meta).to.equal('204');
    expect(result.body.toString()).to.equal('');
  });
}
describe('http_get.fetch', function () {
  registerHttpGetFetchSuite1Part1.call(this);
  registerHttpGetFetchSuite1Part2.call(this);
  registerHttpGetFetchSuite1Part3.call(this);
});
