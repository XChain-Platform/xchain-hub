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
    const keys = [ctx.HUB_API_KEY, ctx.HUB_REORG_API_KEY, ctx.HUB_CONFIG_SECRETS_API_KEY]
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

// The per-IP key, with IPv6 collapsed to its /56 exactly as the library's default does,
// so one host cannot rotate through its own subnet to reset the count.
function rateLimitKey(req) {
    return ipKeyGenerator(String((req && req.ip) || ''));
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
    authenticatedCaller,
    batchCost,
    batchSurcharge,
    parseAuthRpm,
    rateLimitKey
};
