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
const httpGet = require('../../../src/providers/http_get.js');

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

// ---- fetch() SSRF guard ----------------------------------------------------

async function httpGetFetchSSRFGuardSuite1ExpectGuardReject(payload) {
  let err = null;
  try {
    await httpGet.fetch(payload, {});
  } catch (e) {
    err = e;
  }
  expect(err, payload + ' should have been refused').to.exist;
  expect(err.message).to.match(/SSRF guard/);
  return err;
}
function registerHttpGetFetchSSRFGuardSuite1Part1() {
  afterEach(function () {
    nock.cleanAll();
    sinon.restore();
    delete process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE;
    delete process.env.HUB_NETWORK;
  });
  it('refuses loopback, private, link-local, CGNAT and metadata IP literals', async function () {
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://127.0.0.1/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://127.8.8.8/secret');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://10.0.0.5/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://172.16.0.1/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://172.31.255.254/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://192.168.1.1/admin');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://169.254.169.254/latest/meta-data/'); // cloud metadata over TLS
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://100.64.0.1/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://0.0.0.0/');
  });
  it('refuses IPv6 loopback, link-local, unique-local and v4-mapped literals', async function () {
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[::1]/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[fe80::1]/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[fd00::1]/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[::ffff:127.0.0.1]/');
  });
  it('refuses NAT64 and IPv4-compatible IPv6 that embed an internal v4', async function () {
    // 64:ff9b::7f00:1 = NAT64 of 127.0.0.1; ::7f00:1 = IPv4-compatible ::127.0.0.1.
    // On a host with a NAT64 gateway (or that routes v4-compatible) these reach
    // the internal target, so the guard must fail closed on the embedding prefix.
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[64:ff9b::7f00:1]/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[64:ff9b::a00:5]/'); // NAT64 of 10.0.0.5
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://[::7f00:1]/'); // ::127.0.0.1
  });
  it('allows public IP literals adjacent to blocked ranges (boundary check)', async function () {
    // 172.32.0.1 is just past 172.16/12; 100.128.0.1 just past 100.64/10.
    // nock intercepts so no real connection is made.
    nock('https://172.32.0.1').get('/').reply(200, 'ok');
    const r1 = await httpGet.fetch('https://172.32.0.1/', {});
    expect(r1.meta).to.equal('200');
    nock('https://100.128.0.1').get('/').reply(200, 'ok');
    const r2 = await httpGet.fetch('https://100.128.0.1/', {});
    expect(r2.meta).to.equal('200');
  });
  it('refuses a hostname that resolves to a private address', async function () {
    sinon.stub(dns.promises, 'lookup').resolves([{
      address: '10.1.2.3',
      family: 4
    }]);
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://internal.example.com/');
  });
}
function registerHttpGetFetchSSRFGuardSuite1Part2() {
  it('refuses a hostname when ANY resolved address is private (rebind mix)', async function () {
    sinon.stub(dns.promises, 'lookup').resolves([{
      address: '93.184.216.34',
      family: 4
    }, {
      address: '169.254.169.254',
      family: 4
    }]);
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://rebind.example.com/');
  });
  it('refuses when DNS resolution fails', async function () {
    sinon.stub(dns.promises, 'lookup').rejects(Object.assign(new Error('queryA ENOTFOUND'), {
      code: 'ENOTFOUND'
    }));
    let err = null;
    try {
      await httpGet.fetch('https://nxdomain.example.com/', {});
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(err.message).to.match(/DNS lookup failed/);
  });
  it('proceeds for a hostname resolving to a public address', async function () {
    sinon.stub(dns.promises, 'lookup').resolves([{
      address: '93.184.216.34',
      family: 4
    }]);
    nock('https://public.example.com').get('/data').reply(200, 'public-ok');
    const result = await httpGet.fetch('https://public.example.com/data', {});
    expect(result.body.toString()).to.equal('public-ok');
  });
  it('ATTESTATION_HTTP_GET_ALLOW_PRIVATE=1 disables the guard on regtest (e2e escape hatch)', async function () {
    process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE = '1';
    process.env.HUB_NETWORK = 'regtest';
    nock('https://127.0.0.1').get('/local').reply(200, 'local-ok');
    const result = await httpGet.fetch('https://127.0.0.1/local', {});
    expect(result.body.toString()).to.equal('local-ok');
  });
  it('honors the hatch on a regtest network passed through options', async function () {
    // The e2e harness runs several hubs in ONE process off in-memory p2pConfig, so
    // there is no per-hub process.env.HUB_NETWORK to read; AttestationRound passes
    // the hub's validated network down instead.
    process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE = '1';
    nock('https://127.0.0.1').get('/local').reply(200, 'local-ok');
    const result = await httpGet.fetch('https://127.0.0.1/local', {
      network: 'regtest'
    });
    expect(result.body.toString()).to.equal('local-ok');
  });
}
function registerHttpGetFetchSSRFGuardSuite1Part3() {
  it('IGNORES the hatch off regtest and says so once', async function () {
    // The hatch's "never set it in production" rule is enforced, not prose, because a stray
    // env var on a mainnet validator turned the attestation fleet into an internal
    // port scanner and made that hub fetch a URL its peers structurally cannot reach.
    process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE = '1';
    process.env.HUB_NETWORK = 'mainnet';
    let logged = [];
    let orig = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    try {
      await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://127.0.0.1/local');
    } finally {
      console.log = orig;
    }
    expect(logged.some(l => /ATTESTATION_HTTP_GET_ALLOW_PRIVATE.*IGNORED on mainnet/.test(l)), 'the ignored hatch names itself and the network').to.be.true;
  });
  it('IGNORES the hatch when the network is unset (standalone is not a bypass)', async function () {
    process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE = '1';
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://169.254.169.254/latest/meta-data/');
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://10.0.0.5/');
  });
  it('IGNORES the hatch off regtest even for a hostname that resolves private', async function () {
    // The env-only form skipped resolvePinnedAddress entirely, so the DNS-rebind leg
    // of the guard went with it; the gate has to restore both, not just the literal check.
    process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE = '1';
    process.env.HUB_NETWORK = 'testnet';
    sinon.stub(dns.promises, 'lookup').resolves([{
      address: '192.168.1.10',
      family: 4
    }]);
    await httpGetFetchSSRFGuardSuite1ExpectGuardReject('https://internal.example.com/');
  });
}
describe('http_get.fetch: SSRF guard', function () {
  registerHttpGetFetchSSRFGuardSuite1Part1.call(this);
  registerHttpGetFetchSSRFGuardSuite1Part2.call(this);
  registerHttpGetFetchSSRFGuardSuite1Part3.call(this);
});
