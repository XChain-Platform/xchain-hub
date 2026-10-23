/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Hub - shared upstream budget for capability proof fetches.
 *
 * Every LTC and DOGE indexer fetches its capability proofs through this hub,
 * and the hub asks the BTC indexer for each one from its own address. The BTC
 * indexer limits per IP (INDEXER_RATE_LIMIT_RPM, default 600), so per-client
 * pacing cannot bound the total: two bootstraps paced at about 545 a minute
 * each reached about 1065 a minute after a primary restart (hb75), and the
 * 429s also starved the hub's own tip, checkpoint and oracle reads.
 *
 * One budget per hub process sits in front of the BTC indexer call. It hands
 * out evenly spaced start slots at a fixed rate (a reservation bucket with a
 * small burst). A caller whose slot is at most maxWaitMs away waits for it,
 * which slows a client to its share without failing it; a caller whose slot
 * is further out is refused with the wait in seconds, which the route answers
 * as 429 with Retry-After. An upstream 429 pushes every later slot past the
 * Retry-After the BTC indexer gave, so the hub stops spending its address's
 * budget while the indexer is refusing it.
 *
 ********************************************************************/

'use strict';

const DEFAULT_INDEXER_LIMIT_RPM = 600;
const DEFAULT_SHARE_DIVISOR = 2;
const DEFAULT_BURST = 4;
const DEFAULT_MAX_WAIT_MS = 5000;

function positiveInt(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// The proof budget in requests a minute. HUB_CAPABILITY_PROOF_RPM sets it
// outright; unset, it is half of the BTC indexer's per-IP limit so the hub's
// own BTC calls keep the other half. It never exceeds that limit.
function resolveProofRpm(hubConfig) {
    const cfg = hubConfig || {};
    const indexerLimit = positiveInt(cfg.BTC_INDEXER_RATE_LIMIT_RPM) || DEFAULT_INDEXER_LIMIT_RPM;
    const configured = positiveInt(cfg.HUB_CAPABILITY_PROOF_RPM);
    const rpm = configured || Math.floor(indexerLimit / DEFAULT_SHARE_DIVISOR);
    return Math.max(1, Math.min(rpm, indexerLimit));
}

function createUpstreamBudget(options = {}) {
    const rpm = positiveInt(options.rpm) || Math.floor(DEFAULT_INDEXER_LIMIT_RPM / DEFAULT_SHARE_DIVISOR);
    const burst = positiveInt(options.burst) || DEFAULT_BURST;
    const maxWaitMs = Number.isFinite(options.maxWaitMs) && options.maxWaitMs >= 0
        ? options.maxWaitMs : DEFAULT_MAX_WAIT_MS;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const intervalMs = 60000 / rpm;
    // The start time the next slot goes to. It may lag now by at most
    // burst intervals, which is the idle credit a quiet hub accumulates.
    let nextSlotAt = 0;

    function reserve() {
        const t = now();
        const slot = Math.max(nextSlotAt, t - (burst - 1) * intervalMs);
        const waitMs = Math.max(0, slot - t);
        if (waitMs > maxWaitMs) return { ok: false, retryAfterS: Math.max(1, Math.ceil(waitMs / 1000)) };
        nextSlotAt = slot + intervalMs;
        return { ok: true, waitMs };
    }

    function pauseFor(ms) {
        const delay = Number(ms);
        if (!Number.isFinite(delay) || delay <= 0) return;
        nextSlotAt = Math.max(nextSlotAt, now() + delay);
    }

    return { reserve, pauseFor, rpm, intervalMs, maxWaitMs };
}

const DEFAULT_UPSTREAM_RETRY_MS = 10000;

function headerValue(headers, name) {
    if (!headers) return undefined;
    const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
    return Array.isArray(value) ? value[0] : value;
}

// The wait an upstream 429 asked for, in ms, or null when the error is not a
// 429. express-rate-limit sends Retry-After in seconds; an HTTP-date is also
// legal. A 429 with no usable header waits DEFAULT_UPSTREAM_RETRY_MS.
function upstreamRetryAfterMs(error, now = Date.now) {
    const response = error && error.response;
    if (!response || Number(response.status) !== 429) return null;
    const value = headerValue(response.headers, 'retry-after');
    const seconds = Number(value);
    if (value !== undefined && value !== '' && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(at)) return Math.max(0, at - now());
    return DEFAULT_UPSTREAM_RETRY_MS;
}

module.exports = { createUpstreamBudget, resolveProofRpm, upstreamRetryAfterMs };
