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
 * Per-IP rate-limit policy for the hub's express API.
 *
 * Two things the shipped `rateLimit({ windowMs, limit })` call got wrong, both
 * measured on 2026-08-27 driving a chain-only node's price-history recovery:
 *
 * 1. THE 429 WAS UNREADABLE. express-rate-limit's default body is the plain
 *    string "Too many requests, please try again later." served as text/html.
 *    Every XChain client on this surface speaks JSON-RPC and parses the body,
 *    so the throttle surfaced downstream as `Invalid JSON response: Unexpected
 *    token 'T'` - a message that names neither the rate limit, nor the limit's
 *    value, nor the fact that waiting would fix it. buildRateLimitOptions
 *    answers with a JSON-RPC error envelope instead: same 429 status, same
 *    Retry-After and RateLimit-* headers, but a parseable body whose message
 *    names the limit, the window, and the env var that raises it.
 *
 * 2. THE GUARD FIRED ON THE HUB'S OWN STACK. A node rebuilding price history
 *    from the chain replays one `pushpricebatch` per batch-bearing block as
 *    fast as it can read blocks, which is far more than 100/min; so does a
 *    fleet re-bootstrapping its HubDbSync tables. Those callers are not the
 *    internet, they are the co-located indexer reaching the hub container over
 *    the docker bridge, and throttling them turned a supported recovery path
 *    into a stall that only cleared with HUB_RATE_LIMIT_RPM
 *    raised to 60000 by hand. `skip` exempts callers whose resolved address is
 *    loopback or RFC1918/ULA private, which is a strictly SMALLER trust grant
 *    than the one the hub already makes: `trust proxy` defaults to
 *    'loopback, uniquelocal', so those same peers are already trusted to
 *    rewrite the client IP via X-Forwarded-For.
 *
 * The exemption keys on `req.ip`, NOT on the raw socket address, and that
 * ordering is what keeps it safe. Behind a reverse proxy express resolves
 * req.ip to the leftmost address the trust chain does not vouch for, so a
 * public client arriving through a private-IP proxy still presents a public
 * req.ip and is still throttled. Only a caller that is genuinely on the host
 * or the private network is exempt. Set HUB_RATE_LIMIT_EXEMPT_LOCAL=false to
 * enforce the cap on every caller including those.
 */

// JSON-RPC reserves -32000..-32099 for server-defined errors. -32029 is the
// hub's "you are being rate limited" code; clients key retry/backoff on it
// rather than on the HTTP status, because a proxy can rewrite the status and
// the envelope survives.
const RATE_LIMIT_RPC_ERROR_CODE = -32029;

const PRIVATE_V4 = [
    // [network, prefix length] - the ranges a co-located or same-LAN caller
    // can present. 169.254/16 is here because a docker/podman network without
    // a DHCP lease lands there, and such a caller is as local as any other.
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['169.254.0.0', 16]
];

function v4ToInt (ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        n = (n * 256) + octet;
    }
    return n;
}

/**
 * Reduce an address to the form the range checks below expect: no IPv6 zone
 * index, no ::ffff: v4-mapped prefix, lower case. Returns '' for anything that
 * is not a usable string, which every caller then treats as "not local".
 *
 * @param {*} ip - a req.ip / socket address, or anything at all
 * @returns {string} the normalized address, or '' when there isn't one
 */
function normalizeIp (ip) {
    if (typeof ip !== 'string') return '';
    let out = ip.trim().toLowerCase();
    if (!out) return '';
    const zone = out.indexOf('%');
    if (zone !== -1) out = out.slice(0, zone);
    // ::ffff:127.0.0.1 and the (rarer) ::127.0.0.1 both carry a v4 address.
    const mapped = out.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return mapped[1];
    return out;
}

/**
 * Is this address the hub's own host or its private network?
 *
 * Fails CLOSED: an address that cannot be parsed is reported as NOT local, so
 * an unexpected input shape leaves the rate limit enforced rather than
 * silently opening it.
 *
 * @param {*} ip - a req.ip value
 * @returns {boolean} true when the caller is loopback or private-range
 */
function isLocalCaller (ip) {
    const addr = normalizeIp(ip);
    if (!addr) return false;
    if (addr === '::1') return true;
    if (addr === '::') return false;

    const asInt = v4ToInt(addr);
    if (asInt !== null) {
        // 127.0.0.0/8 - loopback is more than the single 127.0.0.1 address.
        if ((asInt >>> 24) === 127) return true;
        for (const [net, bits] of PRIVATE_V4) {
            const netInt = v4ToInt(net);
            const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
            if (((asInt & mask) >>> 0) === ((netInt & mask) >>> 0)) return true;
        }
        return false;
    }

    if (addr.includes(':')) {
        // fc00::/7 unique-local (docker's IPv6 bridges live here) and
        // fe80::/10 link-local. Both are unroutable on the public internet.
        const head = parseInt(addr.split(':')[0] || '', 16);
        if (!Number.isFinite(head)) return false;
        if ((head & 0xFE00) === 0xFC00) return true;
        if ((head & 0xFFC0) === 0xFE80) return true;
    }
    return false;
}

/**
 * Read the operator's exemption setting. Default ON: the case that must work
 * out of the box is a single-node stack recovering price history from the
 * chain, and that node reaches its own hub over the docker bridge.
 *
 * @param {string|undefined|null} raw - the raw HUB_RATE_LIMIT_EXEMPT_LOCAL value
 * @returns {boolean} whether loopback/private callers skip the per-IP cap
 */
function parseExemptLocal (raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return true;
    const value = String(raw).trim().toLowerCase();
    return !(value === 'false' || value === '0' || value === 'no' || value === 'off');
}

/**
 * The one sentence a throttled caller needs: what tripped, what the cap is,
 * how long to wait, and which knob raises it. Shared by the JSON body and the
 * log line so an operator grepping either finds the same text.
 *
 * @param {{ limit:number, windowMs:number, retryAfterSeconds:number }} facts
 * @returns {string} the human-readable rejection
 */
function rateLimitMessage (facts) {
    return 'hub rate limit exceeded: ' + facts.limit + ' requests per ' +
        Math.round(facts.windowMs / 1000) + 's per IP (HUB_RATE_LIMIT_RPM); retry after ' +
        facts.retryAfterSeconds + 's';
}

// A throttled JSON-RPC request still deserves its id echoed back, so a client
// correlating responses can retire the right call. express.json() runs before
// the limiter in api.js, so req.body is already parsed here. A batch array has
// no single id; JSON-RPC says use null, and so do we.
function requestId (req) {
    const body = req && req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const id = body.id;
    if (typeof id === 'string' || typeof id === 'number' || id === null) return id === undefined ? null : id;
    return null;
}

/**
 * Build the options object for express-rate-limit.
 *
 * @param {object} [opts]
 * @param {number} [opts.rpm=100]            requests per window per IP (HUB_RATE_LIMIT_RPM)
 * @param {number} [opts.windowMs=60000]     the window
 * @param {boolean} [opts.exemptLocal=true]  skip loopback/private-range callers
 * @param {function} [opts.onLimited]        called once per throttled request, with the facts
 * @returns {object} options for rateLimit(), including `skip` and a JSON `handler`
 */
function buildRateLimitOptions (opts) {
    opts = opts || {};
    const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 60 * 1000;
    const limit = Number.isFinite(opts.rpm) && opts.rpm > 0 ? opts.rpm : 100;
    const exemptLocal = opts.exemptLocal === undefined ? true : !!opts.exemptLocal;
    const onLimited = typeof opts.onLimited === 'function' ? opts.onLimited : null;
    const retryAfterSeconds = Math.max(1, Math.ceil(windowMs / 1000));

    return {
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        skip (req) {
            return exemptLocal && isLocalCaller(req && req.ip);
        },
        handler (req, res) {
            const facts = {
                limit,
                windowMs,
                retryAfterSeconds,
                policy: 'per-ip',
                env: 'HUB_RATE_LIMIT_RPM'
            };
            const message = rateLimitMessage(facts);
            if (onLimited) {
                try { onLimited(facts, req); } catch { /* telemetry must never break the response */ }
            }
            // Retry-After is set by express-rate-limit itself; re-asserting it
            // here keeps the value the body advertises and the value the header
            // advertises identical even if the middleware's own units change.
            res.setHeader('Retry-After', String(retryAfterSeconds));
            res.status(429).json({
                jsonrpc: '2.0',
                id: requestId(req),
                error: {
                    code: RATE_LIMIT_RPC_ERROR_CODE,
                    message,
                    data: facts
                }
            });
        }
    };
}

module.exports = {
    RATE_LIMIT_RPC_ERROR_CODE,
    buildRateLimitOptions,
    isLocalCaller,
    normalizeIp,
    parseExemptLocal,
    rateLimitMessage
};
