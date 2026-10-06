'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-peer backoff for catch-up snapshot fetches, so a peer that refuses or fails
// is left alone for a while instead of being asked again on every walk.

// A rate-limit refusal with no Retry-After waits out one full limiter window.
const DEFAULT_RATE_LIMIT_WAIT_MS = 60000;

function createPeerFeedBackoff({ retryIntervalMs, maxRetryIntervalMs, now = Date.now } = {}) {
    const entries = new Map();

    function isBackedOff(peer) {
        const entry = entries.get(peer);
        return Boolean(entry) && now() < entry.until;
    }

    // A 429 waits for the larger of the server's Retry-After and the peer's own doubling interval.
    function noteFailure(peer, err) {
        const previous = entries.get(peer);
        const intervalMs = previous ? Math.min(previous.intervalMs * 2, maxRetryIntervalMs) : retryIntervalMs;
        let waitMs = intervalMs;
        if (err && err.statusCode === 429) {
            const retryAfterMs = Number(err.retryAfterMs) > 0 ? Number(err.retryAfterMs) : DEFAULT_RATE_LIMIT_WAIT_MS;
            waitMs = Math.max(retryAfterMs, intervalMs);
        }
        entries.set(peer, { until: now() + waitMs, intervalMs });
    }

    function noteSuccess(peer) {
        entries.delete(peer);
    }

    // With a peer list, a walk can start as soon as any listed peer is free.
    function earliestRetryAt(peers) {
        const names = Array.isArray(peers) ? peers : [...entries.keys()];
        let earliest = Infinity;
        for (const peer of names) {
            if (!isBackedOff(peer)) {
                if (Array.isArray(peers)) return 0;
                continue;
            }
            earliest = Math.min(earliest, entries.get(peer).until);
        }
        return earliest === Infinity ? 0 : earliest;
    }

    return { isBackedOff, noteFailure, noteSuccess, earliestRetryAt };
}

module.exports = { createPeerFeedBackoff, DEFAULT_RATE_LIMIT_WAIT_MS };
