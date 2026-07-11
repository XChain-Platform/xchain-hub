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

const { expect } = require('chai');
const sinon      = require('sinon');
const nock       = require('nock');
const dns        = require('dns');
const httpGet    = require('../../src/providers/http_get.js');

// Resolve every hostname to a public address so unit tests never touch real
// DNS (the SSRF guard resolves before nock's request interception kicks in).
function stubPublicDns() {
    sinon.stub(dns.promises, 'lookup').resolves([{ address: '93.184.216.34', family: 4 }]);
}

function p(body, meta){ return { body: Buffer.from(body, 'utf8'), meta: String(meta || '200') }; }

describe('http_get.agree: byte_equality', function () {

    it('returns null on empty input', function () {
        expect(httpGet.agree([])).to.be.null;
        expect(httpGet.agree(null)).to.be.null;
        expect(httpGet.agree(undefined)).to.be.null;
    });

    it('returns the single proposal trivially (N=1, quorum=1)', function () {
        const result = httpGet.agree([p('hello', '200')]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('hello');
        expect(result.meta).to.equal('200');
    });

    it('returns the unanimous body when all N proposals match (N=3)', function () {
        const result = httpGet.agree([p('x', '200'), p('x', '200'), p('x', '200')]);
        expect(result.body.toString()).to.equal('x');
    });

    it('returns the majority body when 2 of 3 agree (simple-majority quorum=2 at N=3; 2-of-3 meets it)', function () {
        const result = httpGet.agree([p('A', '200'), p('A', '200'), p('B', '500')]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('A');
    });

    it('returns null on a 3-way split at N=3 (each body count=1 < quorum=2)', function () {
        // Regression guard for the quorum=1 defect: under the old BFT formula
        // 2*floor((N-1)/3)+1 this yielded quorum=1 at N=3, so the first-inserted
        // group won with count=1 and a single divergent body became canonical.
        // Simple-majority quorum = ceil((3+1)/2) = 2, so a total 3-way split has
        // no majority and MUST return null. If this ever returns non-null the
        // REDUNDANCY=3 consensus guarantee has been silently reverted.
        const result = httpGet.agree([p('A', '200'), p('B', '404'), p('C', '500')]);
        expect(result).to.be.null;
    });

    it('returns null when no body meets quorum at N=5 (3-way split with 2-2-1)', function () {
        // N=5, quorum = ceil((5+1)/2) = 3. Max group is 2; below quorum.
        const result = httpGet.agree([
            p('A', '200'), p('A', '200'),
            p('B', '200'), p('B', '200'),
            p('C', '500')
        ]);
        expect(result).to.be.null;
    });

    it('returns the majority body when 3-of-5 agree at N=5 (meets quorum=3)', function () {
        const result = httpGet.agree([
            p('A', '200'), p('A', '200'), p('A', '200'),
            p('B', '200'), p('C', '500')
        ]);
        expect(result.body.toString()).to.equal('A');
    });

    it('treats different META as different groups even when body matches', function () {
        // {body=A, meta=200} vs {body=A, meta=500} are different groups under byte_equality
        const result = httpGet.agree([
            p('A', '200'),
            p('A', '500'),
            p('A', '500')
        ]);
        // At N=3, quorum=2; the largest group is {A,500} with count=2, which meets it.
        expect(result).to.not.be.null;
        expect(result.meta).to.equal('500');
    });

    it('ignores proposals with non-Buffer body', function () {
        // Two valid matching proposals form a majority (count=2 >= quorum=2 at N=3);
        // the non-Buffer entry is skipped during grouping and does not corrupt the result.
        const result = httpGet.agree([
            { body: 'not a buffer', meta: '200' },  // ignored
            p('valid', '200'),
            p('valid', '200')
        ]);
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('valid');
    });

    // The AttestationSpotChecker compares a published body against the expected
    // pattern by calling agree() with exactly two proposals (N=2). Under the old
    // BFT formula quorum was 1, so a published/expected MISMATCH still produced a
    // winner and the spot-check silently passed. Simple-majority quorum at N=2 is
    // ceil((2+1)/2) = 2, so both must agree for the check to pass.
    it('requires both proposals to agree at N=2 (spot-check path)', function () {
        const match    = httpGet.agree([p('same', '200'), p('same', '200')]);
        expect(match).to.not.be.null;
        expect(match.body.toString()).to.equal('same');

        const mismatch = httpGet.agree([p('published', '200'), p('expected', '200')]);
        expect(mismatch).to.be.null;
    });

    // #1209: the grouping key domain-separates body from meta. The old form
    // sha256(body || '|' || meta) let a byte shift across the single unframed
    // delimiter collide distinct pairs, so a Byzantine proposer (meta is an
    // attacker-chosen wire string) could inflate an honest group's count and
    // manufacture a quorum winner where agree() should return null.
    it('does NOT collide boundary-shifted (body, meta) pairs (#1209 delimiter ambiguity)', function () {
        // body="A|",meta="B" and body="A",meta="|B" both hashed over "A||B" under
        // the old unframed concat. They are genuinely distinct groups.
        const a = httpGet.agree([p('A|', 'B'), p('A', '|B')]);
        // N=2, quorum=2; two distinct groups each count=1 -> no majority -> null.
        expect(a).to.be.null;
    });

    it('a crafted collision cannot forge a quorum winner out of a 1-1-1 split (#1209)', function () {
        // Honest 3-way split: three distinct (body, meta) pairs, no majority.
        // The middle proposal is the attacker boundary-shifting bytes to try to
        // land in the first honest group. With domain separation it stays distinct.
        const result = httpGet.agree([
            p('A|', 'B'),    // honest group 1
            p('A', '|B'),    // Byzantine attempt to collide with group 1
            p('C', '500')    // honest group 2
        ]);
        // Three distinct groups, each count=1 < quorum=2 -> MUST be null.
        expect(result).to.be.null;
    });

    it('still groups identical (body, meta) pairs together after domain separation (#1209)', function () {
        const result = httpGet.agree([p('A|', 'B'), p('A|', 'B'), p('C', '500')]);
        // Two identical proposals form the majority group at N=3 (quorum=2).
        expect(result).to.not.be.null;
        expect(result.body.toString()).to.equal('A|');
        expect(result.meta).to.equal('B');
    });

});

// ---- fetch() ---------------------------------------------------------------

describe('http_get.fetch', function () {

    beforeEach(stubPublicDns);

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    it('rejects when payload is missing or not a string', async function () {
        let err;
        err = null;
        try { await httpGet.fetch(null, {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/payload must be a string URL/);

        err = null;
        try { await httpGet.fetch(undefined, {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/payload must be a string URL/);

        err = null;
        try { await httpGet.fetch(42, {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/payload must be a string URL/);
    });

    it('rejects when the URL is invalid', async function () {
        let err;
        try { await httpGet.fetch('not-a-url', {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/invalid URL/);
    });

    it('rejects http:// URLs (only https:// allowed)', async function () {
        let err;
        try { await httpGet.fetch('http://example.com/', {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/only https/);
    });

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
        try { await httpGet.fetch('https://example.com/big', {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/exceeds maxResponseBytes/);
    });

    it('honours a custom maxResponseBytes option', async function () {
        const body = Buffer.alloc(11, 'A');
        nock('https://example.com').get('/small').reply(200, body);
        // 10 byte cap: 11 bytes should trigger overflow
        let err;
        try { await httpGet.fetch('https://example.com/small', { maxResponseBytes: 10 }); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/exceeds maxResponseBytes \(10\)/);
    });

    it('accepts a response exactly at the maxResponseBytes limit', async function () {
        const body = Buffer.alloc(10, 'B');
        nock('https://example.com').get('/exact').reply(200, body);
        const result = await httpGet.fetch('https://example.com/exact', { maxResponseBytes: 10 });
        expect(result.body.length).to.equal(10);
    });

    it('rejects on a request-level network error', async function () {
        nock('https://broken.example.com').get('/').replyWithError('ECONNREFUSED');
        let err;
        try { await httpGet.fetch('https://broken.example.com/', {}); } catch (e) { err = e; }
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

});

// ---- fetch() SSRF guard ----------------------------------------------------

describe('http_get.fetch: SSRF guard', function () {

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
        delete process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE;
    });

    async function expectGuardReject(payload) {
        let err = null;
        try { await httpGet.fetch(payload, {}); } catch (e) { err = e; }
        expect(err, payload + ' should have been refused').to.exist;
        expect(err.message).to.match(/SSRF guard/);
        return err;
    }

    it('refuses loopback, private, link-local, CGNAT and metadata IP literals', async function () {
        await expectGuardReject('https://127.0.0.1/');
        await expectGuardReject('https://127.8.8.8/secret');
        await expectGuardReject('https://10.0.0.5/');
        await expectGuardReject('https://172.16.0.1/');
        await expectGuardReject('https://172.31.255.254/');
        await expectGuardReject('https://192.168.1.1/admin');
        await expectGuardReject('https://169.254.169.254/latest/meta-data/'); // cloud metadata over TLS
        await expectGuardReject('https://100.64.0.1/');
        await expectGuardReject('https://0.0.0.0/');
    });

    it('refuses IPv6 loopback, link-local, unique-local and v4-mapped literals', async function () {
        await expectGuardReject('https://[::1]/');
        await expectGuardReject('https://[fe80::1]/');
        await expectGuardReject('https://[fd00::1]/');
        await expectGuardReject('https://[::ffff:127.0.0.1]/');
    });

    it('refuses NAT64 and IPv4-compatible IPv6 that embed an internal v4', async function () {
        // 64:ff9b::7f00:1 = NAT64 of 127.0.0.1; ::7f00:1 = IPv4-compatible ::127.0.0.1.
        // On a host with a NAT64 gateway (or that routes v4-compatible) these reach
        // the internal target, so the guard must fail closed on the embedding prefix.
        await expectGuardReject('https://[64:ff9b::7f00:1]/');
        await expectGuardReject('https://[64:ff9b::a00:5]/');   // NAT64 of 10.0.0.5
        await expectGuardReject('https://[::7f00:1]/');         // ::127.0.0.1
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
        sinon.stub(dns.promises, 'lookup').resolves([{ address: '10.1.2.3', family: 4 }]);
        await expectGuardReject('https://internal.example.com/');
    });

    it('refuses a hostname when ANY resolved address is private (rebind mix)', async function () {
        sinon.stub(dns.promises, 'lookup').resolves([
            { address: '93.184.216.34', family: 4 },
            { address: '169.254.169.254', family: 4 }
        ]);
        await expectGuardReject('https://rebind.example.com/');
    });

    it('refuses when DNS resolution fails', async function () {
        sinon.stub(dns.promises, 'lookup').rejects(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' }));
        let err = null;
        try { await httpGet.fetch('https://nxdomain.example.com/', {}); } catch (e) { err = e; }
        expect(err).to.exist;
        expect(err.message).to.match(/DNS lookup failed/);
    });

    it('proceeds for a hostname resolving to a public address', async function () {
        sinon.stub(dns.promises, 'lookup').resolves([{ address: '93.184.216.34', family: 4 }]);
        nock('https://public.example.com').get('/data').reply(200, 'public-ok');
        const result = await httpGet.fetch('https://public.example.com/data', {});
        expect(result.body.toString()).to.equal('public-ok');
    });

    it('ATTESTATION_HTTP_GET_ALLOW_PRIVATE=1 disables the guard (regtest/e2e escape hatch)', async function () {
        process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE = '1';
        nock('https://127.0.0.1').get('/local').reply(200, 'local-ok');
        const result = await httpGet.fetch('https://127.0.0.1/local', {});
        expect(result.body.toString()).to.equal('local-ok');
    });
});

// ---- healthCheck() ---------------------------------------------------------

describe('http_get.healthCheck', function () {

    beforeEach(stubPublicDns);

    afterEach(function () {
        nock.cleanAll();
        sinon.restore();
    });

    it('returns ok:true with the status code when the probe succeeds', async function () {
        nock('https://checkip.amazonaws.com').get('/').reply(200, '1.2.3.4\n');
        const result = await httpGet.healthCheck();
        expect(result.ok).to.equal(true);
        expect(result.status).to.equal('200');
    });

    it('returns ok:false with an error message when the probe fails', async function () {
        nock('https://checkip.amazonaws.com').get('/').replyWithError('ETIMEDOUT');
        const result = await httpGet.healthCheck();
        expect(result.ok).to.equal(false);
        expect(result.error).to.be.a('string');
        expect(result.error).to.match(/request error/);
    });

});
