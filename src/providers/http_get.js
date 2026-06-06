/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
const { URL } = require('url');

const USER_AGENT = 'XChain-Attestation/1.0';

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
            timeout:  timeoutMs
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
