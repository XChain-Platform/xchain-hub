'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Public-port method allowlist. The mirror feed shares the PUBLIC P2P port
// (PeerManager.setFeedHandlers), and an indexer must discover hubs and report what
// landed on its chain, so a small RPC set is reachable there. The guard these
// tests hold is that the set is EXACTLY those calls: a request stamped as arriving
// on the public port may call nothing else, while the private API port keeps its
// full surface. The x-api-key tiers are unchanged and tested in
// sensitiveReadAuth.test.js; this file is only about which methods that port
// considers at all.

const { expect } = require('chai');
const { feedPortAllowlist } = require('../../../src/api/auth_gate.js');

// The complete indexer->hub vocabulary (xchain-indexer src/hub/hub_client.js).
const FEED_METHODS = [
    'gethubs',
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushattestbatch', 'pushoracleprice',
    'pushpricereorg', 'pushxcallreorg', 'pushdexreorg', 'pushbridgereorg', 'retractattestbatch'
];

// A deliberately broad sample of what must NOT be reachable from a public port:
// config and validator administration, governance, slashing, swaps, the anchor and
// effector rails, a sensitive read, and ordinary reads.
const REFUSED_METHODS = [
    'updateconfig', 'registervalidator', 'rotatevalidator', 'deregistervalidator',
    'syncvalidators', 'propose', 'proposeslashpenalty', 'vote', 'requestattestation',
    'reportreorg', 'initiateswap', 'anchorflush', 'pauseeffectorspend',
    'resumeeffectorspend', 'getallconfigs', 'getvalidators', 'ping'
];

function driveMiddleware(mw, opts) {
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    const hasRawBody = Object.prototype.hasOwnProperty.call(opts, 'body');
    const body = hasRawBody ? opts.body : (Array.isArray(opts.method)
        ? opts.method.map((m, i) => ({ method: m, id: i + 1 }))
        : (opts.method === undefined ? {} : { method: opts.method, id: 1 }));
    const req = {
        body: body,
        headers: { 'x-api-key': 'test-hub-key' },
        method: opts.httpMethod || 'POST',
        url: opts.url,
        originalUrl: opts.url
    };
    if (opts.feed) req.xchainFeedOrigin = true;
    let nexted = false;
    mw(req, res, () => { nexted = true; });
    return { nexted, res };
}

const middleware = feedPortAllowlist();
const api = { drive: (opts) => driveMiddleware(middleware, opts) };

describe('hub public-port rpc allowlist (P2P feed)', function () {
    it('admits every indexer feed method on the public port', function () {
        for (const m of FEED_METHODS) {
            expect(api.drive({ method: m, feed: true }).nexted, m).to.equal(true);
        }
    });

    it('refuses every other method on the public port with -32601', function () {
        for (const m of REFUSED_METHODS) {
            const { nexted, res } = api.drive({ method: m, feed: true });
            expect(nexted, m).to.equal(false);
            expect(res.statusCode, m).to.equal(404);
            expect(res.body.error.code, m).to.equal(-32601);
        }
    });

    it('leaves the private API port unrestricted (no stamp, no allowlist)', function () {
        for (const m of REFUSED_METHODS.concat(FEED_METHODS)) {
            expect(api.drive({ method: m }).nexted, m).to.equal(true);
        }
    });

    it('admits a batch of only push methods', function () {
        expect(api.drive({ method: ['pushpricebatch', 'pushchaintip'], feed: true }).nexted).to.equal(true);
    });

    it('refuses a batch that smuggles one refused method in beside pushes', function () {
        const { nexted, res } = api.drive({ method: ['pushpricebatch', 'updateconfig'], feed: true });
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(404);
    });

    it('refuses a bodyless or methodless POST on the public port', function () {
        for (const body of [{ method: undefined }, { method: null }]) {
            const { nexted, res } = api.drive({ method: body.method, feed: true });
            expect(nexted).to.equal(false);
            expect(res.statusCode).to.equal(404);
        }
    });
});

describe('hub public-port rpc allowlist (P2P feed)', function () {
    it('refuses an empty batch on the public port', function () {
        const { nexted, res } = api.drive({ method: [], feed: true });
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(404);
    });

    it('matches the method case-insensitively, as the auth tiers do', function () {
        expect(api.drive({ method: 'PushPriceBatch', feed: true }).nexted).to.equal(true);
        expect(api.drive({ method: 'UpdateConfig', feed: true }).nexted).to.equal(false);
    });

    it('passes a stamped GET through (snapshot reads are scoped by path, not method)', function () {
        let out = api.drive({ body: undefined, feed: true, httpMethod: 'GET',
            url: '/hub-db/snapshot/price_snapshots' });
        expect(out.nexted).to.equal(true);

        out = api.drive({ body: {}, feed: true, httpMethod: 'GET',
            url: '/hub-db/snapshot/price_snapshots' });
        expect(out.nexted).to.equal(true);

        const { nexted, res } = api.drive({ method: 'updateconfig', feed: true,
            httpMethod: 'GET', url: '/hub-db/snapshot/x' });
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(404);
        expect(res.body.error.code).to.equal(-32601);

        out = api.drive({ method: 'gethubs', feed: true, httpMethod: 'GET',
            url: '/hub-db/snapshot/x' });
        expect(out.nexted).to.equal(true);

        out = api.drive({ method: 'updateconfig', httpMethod: 'GET',
            url: '/hub-db/snapshot/x' });
        expect(out.nexted).to.equal(true);
    });
});
