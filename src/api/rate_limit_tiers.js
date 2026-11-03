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
 * XChain Hub - the public and authenticated JSON-RPC rate-limit tiers, and
 * the batch surcharge that charges one token per call.
 *
 * Why two tiers. 08c756e5 made a validator hub default HUB_RATE_LIMIT_RPM to
 * 60000, the value five testnet validator composes had carried by hand since
 * the 2026-09-16 roll wedged every mirror bootstrap at 100 req/min. That raise
 * lifted the throttle for EVERY caller, and the public surface includes
 * `health`, which fans out to three indexer reads per call: one keyless client
 * could drive about 1.2M health handlers a minute through 20-call batches.
 * The traffic the raise was for is the fleet's own (indexer push rails and
 * replay, and the mirror drain, which has had its own bucket since 6b45132b),
 * and on a keyed hub that traffic carries a hub key. So the key, not the role,
 * picks the budget: a request presenting a configured key is metered at
 * HUB_AUTH_RATE_LIMIT_RPM (default 60000), everything else at
 * HUB_RATE_LIMIT_RPM (default 100) on every role. A wrong key lands in the
 * public tier, so a guessed header buys nothing.
 *
 * Why a surcharge. express-rate-limit charges one hit per HTTP request, and
 * the router runs every element of a batch array, so a 20-call batch cost one
 * token. The surcharge runs right after each tier's limiter and charges the
 * other n - 1 calls to the same key in the same store.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');

// The authenticated tier's default: the fleet value 08c756e5 shipped, kept for the
// key-holding callers it was measured against.
const DEFAULT_AUTH_RPM = 60000;

// An unset, unparseable or non-positive value keeps the default, and the default is
// never below the public limit: presenting a key must not cost a caller budget.
function parseAuthRpm(raw, publicRpm) {
    const value = parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0) return value;
    const floor = Number.isFinite(publicRpm) && publicRpm > 0 ? publicRpm : 0;
    return Math.max(DEFAULT_AUTH_RPM, floor);
}

function timingEqual(provided, expected) {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A predicate over requests: true when x-api-key equals any key this hub has
// configured. A keyless hub has none, so every caller is public there.
function authenticatedCaller(ctx) {
    const keys = [ctx.HUB_API_KEY, ctx.HUB_API_KEY_PREVIOUS, ctx.HUB_FEED_API_KEY, ctx.HUB_REORG_API_KEY, ctx.HUB_CONFIG_SECRETS_API_KEY]
        .filter((key) => typeof key === 'string' && key.length > 0);
    return function isAuthenticated(req) {
        if (keys.length === 0) return false;
        const provided = req && req.headers && req.headers['x-api-key'];
        if (typeof provided !== 'string' || provided.length === 0) return false;
        return keys.some((key) => timingEqual(provided, key));
    };
}

// Tokens a request costs: one per element of a JSON-RPC batch array, one otherwise.
// An empty array still reaches the router, so it still costs its one token.
function batchCost(req) {
    const body = req && req.body;
    return Array.isArray(body) ? Math.max(1, body.length) : 1;
}

// The one key every req.ip that is not an address shares. Behind a proxy that forwards
// X-Forwarded-For verbatim, req.ip is any string the client writes; keyed as given, each
// new string was a fresh bucket of client-chosen length.
const UNPARSED_IP_KEY = 'unparsed-ip';

// Dotted IPv4 with each octet read as decimal, so 198.51.100.068 is 198.51.100.68.
function canonicalV4(text) {
    const parts = text.split('.');
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
    const octets = parts.map(Number);
    return octets.every((octet) => octet <= 255) ? octets.join('.') : null;
}

// The eight 16-bit groups of an address net.isIPv6 has accepted, a dotted tail included.
function v6Groups(text) {
    let head = text;
    const tail = [];
    const tailStart = text.lastIndexOf(':') + 1;
    if (text.slice(tailStart).includes('.')) {
        const v4 = canonicalV4(text.slice(tailStart));
        if (!v4) return null;
        const o = v4.split('.').map(Number);
        tail.push(o[0] * 256 + o[1], o[2] * 256 + o[3]);
        head = text.slice(0, tailStart);
        if (!head.endsWith('::')) head = head.slice(0, -1);
    }
    const split = (s) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
    const halves = head.split('::');
    const left = split(halves[0]);
    const right = halves.length > 1 ? split(halves[1]) : [];
    const fill = halves.length > 1 ? 8 - left.length - right.length - tail.length : 0;
    const groups = left.concat(new Array(Math.max(0, fill)).fill(0), right, tail);
    return groups.length === 8 ? groups : null;
}

// The address req.ip names, with the spellings a forwarded value can carry removed:
// surrounding space, brackets, a port, a trailing dot, an IPv6 zone and letter case.
// A v4-mapped IPv6 address (::ffff:0:0/96) in any spelling, hex groups included, is the
// IPv4 address it carries. Returns null when what is left is not an address.
function canonicalAddress(raw) {
    let text = raw.trim().toLowerCase();
    const bracketed = text.match(/^\[([^\]]*)\](?::\d{1,5})?$/);
    if (bracketed) text = bracketed[1];
    else text = text.replace(/^([\d.]+):\d{1,5}$/, '$1');
    if (/^[\d.]+\.$/.test(text)) text = text.slice(0, -1);
    const v4 = canonicalV4(text);
    if (v4) return { family: 4, address: v4 };
    text = text.replace(/%.*$/, '');
    if (!net.isIPv6(text)) return null;
    const groups = v6Groups(text);
    if (!groups) return null;
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return { family: 4, address: [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.') };
    }
    return { family: 6, address: groups.map((g) => g.toString(16)).join(':') };
}

// The per-IP key: the client's canonical address, so one address in any spelling is one
// bucket. IPv6 is collapsed to its /56 by the library's own helper, so one host cannot
// rotate through its subnet; it is handed the plain hex form, which the helper's is4()
// test never mistakes for IPv4. Anything that is not an address shares one key.
function rateLimitKey(req) {
    const found = canonicalAddress(String((req && req.ip) || ''));
    if (!found) return UNPARSED_IP_KEY;
    return found.family === 4 ? found.address : ipKeyGenerator(found.address);
}

// Charges the rest of a batch against the tier whose limiter just passed the request.
// `opts` is that limiter's own options object, so skip, key, store, limit and the 429
// body can never disagree with the limiter it follows.
function batchSurcharge(opts) {
    return function rpcBatchSurcharge(req, res, next) {
        const extra = batchCost(req) - 1;
        if (extra <= 0 || opts.skip(req)) return next();
        let totalHits;
        try {
            totalHits = opts.store.incrementBy(opts.keyGenerator(req), extra).totalHits;
        } catch (err) {
            return next(err);
        }
        if (totalHits > opts.limit) return opts.handler(req, res);
        return next();
    };
}

module.exports = {
    DEFAULT_AUTH_RPM,
    UNPARSED_IP_KEY,
    authenticatedCaller,
    batchCost,
    batchSurcharge,
    parseAuthRpm,
    rateLimitKey
};
