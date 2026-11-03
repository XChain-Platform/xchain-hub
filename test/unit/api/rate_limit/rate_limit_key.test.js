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

/**
 * The per-IP rate-limit key.
 *
 * The invariant these guard: one client address is one bucket in any spelling. req.ip
 * is whatever the first untrusted X-Forwarded-For entry says, so a port, a zero-padded
 * octet, brackets or a trailing dot must not open a fresh bucket, every string that is
 * not an address shares one key, and a hex-spelled v4-mapped address keys as the IPv4
 * address it carries rather than a shared '::/56' bucket.
 */

const { expect } = require('chai');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const http      = require('http');
const { installRateLimits } = require('../../../../src/api/middleware.js');
const { batchSurcharge, rateLimitKey } = require('../../../../src/api/rate_limit_tiers.js');
const FixedWindowStore = require('../../../../src/api/rate_limit_store.js');
const { buildRateLimitOptions } = require('../../../../src/api/rate_limit_policy.js');

const key = (ip) => rateLimitKey({ ip });

function healthCalls(n) {
    return Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'health', params: {} }));
}

function spellingSuite() {
    it('gives every spelling of one IPv4 address the same key', function () {
        for (const spelling of ['198.51.100.68:4444', '198.51.100.068', '198.51.100.68.', ' 198.51.100.68 ',
            '::ffff:198.51.100.68', '::ffff:c633:6444', '::FFFF:C633:6444', '0:0:0:0:0:ffff:c633:6444',
            '[::ffff:c633:6444]', '[::ffff:c633:6444]:80']) {
            expect(key(spelling), spelling).to.equal(key('198.51.100.68'));
        }
        expect(key('198.51.100.69:4444')).to.equal(key('198.51.100.69:5555'));
    });

    it('gives every spelling of one IPv6 address the same key', function () {
        for (const spelling of ['[2001:db8:4:400::1]', '[2001:db8:4:400::1]:80', '2001:DB8:4:400::1',
            '2001:0db8:0004:0400:0000:0000:0000:0001', '2001:db8:4:400:0:0:0:1']) {
            expect(key(spelling), spelling).to.equal(key('2001:db8:4:400::1'));
        }
    });

    it('keys each hex-spelled v4-mapped address as its own IPv4 address, never a shared /56', function () {
        expect(key('::ffff:c633:645a')).to.equal(key('198.51.100.90'));
        expect(key('::ffff:c633:645b')).to.equal(key('198.51.100.91'));
        expect(key('::ffff:c633:645a')).to.not.equal(key('::ffff:c633:645b'));
        expect(key('::ffff:a00:1')).to.equal(key('10.0.0.1'));
        expect(key('::ffff:a00:1')).to.not.equal(key('::ffff:a00:2'));
        expect(key('::ffff:a00:1')).to.not.equal(key('::ffff:c633:645a'));
    });

    it('keeps distinct addresses apart and groups real IPv6 by its /56', function () {
        expect(key('198.51.100.70')).to.not.equal(key('198.51.100.7'));
        expect(key('1.2.3.4:5')).to.not.equal(key('1.2.3.45'));
        expect(key('2001:db8:4:4ff::9')).to.equal(key('2001:db8:4:400::1'));
        expect(key('2001:db8:4:500::1')).to.not.equal(key('2001:db8:4:400::1'));
    });

    it('gives strings that are not an address one shared key, so they cannot rotate buckets', function () {
        const shared = key('client-label-1');
        expect(key('client-label-2')).to.equal(shared);
        expect(key('x'.repeat(8000))).to.equal(shared);
        expect(key('198.51.100.256')).to.equal(shared);
        expect(key('')).to.equal(shared);
        expect(rateLimitKey({})).to.equal(shared);
        expect(rateLimitKey(undefined)).to.equal(shared);
        expect(shared.length).to.be.below(64);
        expect(shared).to.not.equal(key('198.51.100.68'));
    });
}

function surchargeSuite() {
    it('charges the batch surcharge under the same canonical key as its limiter', function () {
        const opts = buildRateLimitOptions({ rpm: 3, exemptLocal: false });
        opts.store = new FixedWindowStore();
        opts.store.init({ windowMs: 60000 });
        let refused = 0;
        let passed = 0;
        opts.handler = () => { refused++; };
        const surcharge = batchSurcharge(opts);
        const next = () => { passed++; };
        surcharge({ ip: '198.51.100.68:4444', body: healthCalls(2) }, {}, next);
        surcharge({ ip: '::ffff:c633:6444', body: healthCalls(2) }, {}, next);
        expect(passed).to.equal(2);
        surcharge({ ip: '198.51.100.068', body: healthCalls(3) }, {}, next);
        expect(refused).to.equal(1);
        expect(opts.store.incrementBy('198.51.100.68', 0).totalHits).to.equal(4);
    });
}

// Driven over a socket against the real installRateLimits stack, as the repro drove it.
function forwardedSuite() {
    let server = null;
    let port = 0;

    before(() => new Promise((resolve) => {
        const app = express();
        app.set('trust proxy', 'loopback');
        app.use(express.json());
        installRateLimits(app, {
            hubConfig: {}, logger: { info() {}, warn() {} }, rateLimit,
            HUB_API_KEY: '', HUB_RATE_LIMIT_RPM: 3, HUB_RATE_LIMIT_EXEMPT_LOCAL: true
        });
        app.use((req, res) => res.json({ jsonrpc: '2.0', id: 1, result: 'ok' }));
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    }));
    after(() => new Promise((resolve) => server.close(resolve)));

    function post(forwardedFor) {
        const body = JSON.stringify(healthCalls(1)[0]);
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1', port, path: '/', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Forwarded-For': forwardedFor }
            }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
            req.on('error', reject);
            req.end(body);
        });
    }

    it('meters spellings of one forwarded address against one bucket', async function () {
        for (const spelling of ['198.51.100.68', '198.51.100.68:4444', '198.51.100.068']) {
            expect((await post(spelling)).status, spelling).to.equal(200);
        }
        expect((await post('::ffff:c633:6444')).status).to.equal(429);
        expect((await post('198.51.100.68.')).status).to.equal(429);
        const neighbour = await post('::ffff:c633:6445');
        expect(neighbour.status).to.equal(200);
        expect(neighbour.headers['ratelimit-remaining']).to.equal('2');
    });
}

describe('hub per-IP rate-limit key', function () {
    this.timeout(10000);
    describe('spellings of one address', spellingSuite);
    describe('batch surcharge', surchargeSuite);
    describe('forwarded addresses end to end', forwardedSuite);
});
