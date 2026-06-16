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
 * XChain Hub - Attestation Provider: http_get
 *
 * Implements the External Attestation Framework provider interface for
 * plain HTTPS GET requests. Used as the v1 built-in provider to exercise
 * the full attestation pipeline (request -> fetch -> consensus -> publish).
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§7)
 *
 * Provider interface (mirrored by all providers — see providers/README):
 *   fetch(payload, options)  -> Promise<{ body: Buffer, meta: string }>
 *   agree(proposals)         -> { body, meta } | null
 *   healthCheck()            -> Promise<{ ok, status?, error? }>
 *
 ********************************************************************/

const https  = require('https');
const crypto = require('crypto');
const dns    = require('dns');
const net    = require('net');
const { URL } = require('url');

const USER_AGENT = 'XChain-Attestation/1.0';

// ─── SSRF guard ──────────────────────────────────────────────────
//
// The payload URL comes verbatim from an on-chain ATTEST v0 request that any
// contract author can emit, and every responsible validator executes the GET
// from inside its own network — co-resident with the hub DB, coin nodes and
// other services. Without a filter the attestation fleet doubles as an
// internal port-scanner and data exfiltrator (cloud metadata endpoints over
// TLS, internal HTTPS services), with the 32KB response gossiped and, on
// quorum, published on-chain.
//
// Guard: the hostname is resolved ONCE, every resolved address must be
// public, and the actual connection is pinned to a validated address via a
// custom `lookup`, so a rebinding DNS answer cannot swap in a private target
// between check and connect. IP-literal hosts are checked directly.
//
// ATTESTATION_HTTP_GET_ALLOW_PRIVATE=1 disables the guard — for regtest /
// e2e environments that attest local endpoints. Never set it in production.

// True when `addr` (an IPv4/IPv6 string) is loopback, private, link-local,
// CGNAT, multicast or otherwise non-public.
function isForbiddenAddress(addr) {
    let ip = String(addr).toLowerCase();
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — check the embedded IPv4. A mapped
    // form whose remainder isn't parseable IPv4 is refused outright.
    if (ip.startsWith('::ffff:')) {
        const rest = ip.slice(7);
        if (net.isIPv4(rest)) ip = rest;
        else return true;
    }
    if (net.isIPv4(ip)) {
        const o = ip.split('.').map(Number);
        if (o[0] === 0)   return true;                            // 0.0.0.0/8 ("this" network)
        if (o[0] === 10)  return true;                            // 10/8 private
        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64/10 CGNAT
        if (o[0] === 127) return true;                            // loopback
        if (o[0] === 169 && o[1] === 254) return true;            // link-local + cloud metadata
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12 private
        if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF reserved
        if (o[0] === 192 && o[1] === 168) return true;            // 192.168/16 private
        if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // 198.18/15 benchmarking
        if (o[0] >= 224) return true;                             // multicast/reserved/broadcast
        return false;
    }
    if (net.isIPv6(ip)) {
        if (ip === '::' || ip === '::1') return true;             // unspecified / loopback
        if (/^f[cd]/.test(ip))   return true;                     // fc00::/7 unique-local
        if (/^fe[89ab]/.test(ip)) return true;                    // fe80::/10 link-local
        if (/^ff/.test(ip))      return true;                     // multicast
        return false;
    }
    return true; // unparseable — fail closed
}

// Resolves `hostname` (brackets already stripped) to the address the request
// will be pinned to. Throws when the host is, or resolves to, a non-public
// address. Returns { address, family }.
async function resolvePinnedAddress(hostname) {
    const literal = net.isIP(hostname);
    if (literal) {
        if (isForbiddenAddress(hostname))
            throw new Error('http_get: refusing non-public address ' + hostname + ' (SSRF guard)');
        return { address: hostname, family: literal };
    }
    let results;
    try {
        results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    } catch (e) {
        throw new Error('http_get: DNS lookup failed for ' + hostname + ': ' + (e.code || e.message));
    }
    if (!results || results.length === 0)
        throw new Error('http_get: DNS lookup returned no addresses for ' + hostname);
    // ANY non-public answer rejects the whole request: a resolver an attacker
    // controls can mix public and private answers and hope for the bad pick.
    for (const r of results) {
        if (isForbiddenAddress(r.address))
            throw new Error('http_get: ' + hostname + ' resolves to non-public address ' + r.address + ' (SSRF guard)');
    }
    return { address: results[0].address, family: results[0].family };
}

// `lookup` implementation pinning the connection to the pre-validated address.
function pinnedLookup(pinned) {
    return (host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
    };
}

// Issue a GET against `url`. https only, no redirects, no cookies, fixed UA,
// configurable timeout and body cap. Returns { body: Buffer, meta: '<status>' }.
exports.fetch = async (payload, options) => {
    options       = options || {};
    let maxBytes  = Number(options.maxResponseBytes) || 32768;
    let timeoutMs = Number(options.timeoutMs)        || 10000;

    if (!payload || typeof payload !== 'string')
        throw new Error('http_get: payload must be a string URL');

    let url;
    try { url = new URL(payload); }
    catch (_) { throw new Error('http_get: invalid URL'); }
    if (url.protocol !== 'https:')
        throw new Error('http_get: only https:// URLs allowed');

    // WHATWG URL keeps brackets on IPv6 literals; strip for net/dns use.
    const bareHost = url.hostname.replace(/^\[|\]$/g, '');
    const pinned = process.env.ATTESTATION_HTTP_GET_ALLOW_PRIVATE === '1'
        ? null
        : await resolvePinnedAddress(bareHost);

    return await new Promise((resolve, reject) => {
        let settled = false;
        let safeReject = (e) => { if (!settled) { settled = true; reject(e); } };
        let safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };

        let req = https.request({
            method:   'GET',
            hostname: url.hostname,
            port:     url.port || 443,
            path:     url.pathname + url.search,
            headers:  { 'User-Agent': USER_AGENT, 'Accept': '*/*' },
            timeout:  timeoutMs,
            // Pin the socket to the address validated above (TLS SNI and the
            // Host header still use the hostname). Undefined when the guard
            // is disabled via ATTESTATION_HTTP_GET_ALLOW_PRIVATE.
            lookup:   pinned ? pinnedLookup(pinned) : undefined
        }, (res) => {
            // No automatic redirects — a 3xx terminates with the body as-is so callers
            // can decide policy. byte_equality is stricter without redirect chaos.
            let chunks = [];
            let total  = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    req.destroy();
                    safeReject(new Error('http_get: response exceeds maxResponseBytes (' + maxBytes + ')'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end',   () => safeResolve({ body: Buffer.concat(chunks), meta: String(res.statusCode) }));
            res.on('error', (e) => safeReject(new Error('http_get: response error: ' + e.message)));
        });
        req.on('error',   (e) => safeReject(new Error('http_get: request error: ' + e.message)));
        req.on('timeout', ()  => { req.destroy(); safeReject(new Error('http_get: timeout after ' + timeoutMs + 'ms')); });
        req.end();
    });
};

// byte_equality consensus: group proposals by SHA256(body || meta), return the
// majority group if it meets a simple-majority quorum ceil((N+1)/2) over the
// proposal count (1-of-1, 2-of-3, 3-of-5). Returns null when no group reaches
// quorum. A plain majority is used rather than the BFT 2f+1 form because the
// latter degenerates to quorum=1 at N=3, which would let a single divergent
// (stale or adversarial) body become canonical with no agreement at all.
exports.agree = (proposals) => {
    if (!Array.isArray(proposals) || proposals.length === 0) return null;

    let groups = new Map();  // contentHash -> { count, body, meta }
    for (let p of proposals) {
        if (!p || !Buffer.isBuffer(p.body)) continue;
        let h = crypto.createHash('sha256')
            .update(p.body)
            .update('|')
            .update(String(p.meta || ''))
            .digest('hex');
        let g = groups.get(h);
        if (g) g.count++;
        else   groups.set(h, { count: 1, body: p.body, meta: p.meta });
    }

    let N      = proposals.length;
    let quorum = Math.ceil((N + 1) / 2);
    let winner = null;
    let best   = 0;
    for (let g of groups.values()) {
        if (g.count > best) { winner = g; best = g.count; }
    }
    return (winner && best >= quorum) ? { body: winner.body, meta: winner.meta } : null;
};

// Health probe for capability self-test. Hits a stable, free, non-caching
// endpoint that returns the caller's IP. Any 200 OK proves outbound HTTPS works.
exports.healthCheck = async () => {
    try {
        let res = await exports.fetch('https://checkip.amazonaws.com/', { maxResponseBytes: 64, timeoutMs: 5000 });
        return { ok: true, status: res.meta };
    } catch (e) {
        return { ok: false, error: e.message };
    }
};
