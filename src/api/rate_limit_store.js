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
 * XChain Hub - a fixed-window hit store for express-rate-limit that can
 * charge more than one hit per request.
 *
 * express-rate-limit charges one hit per HTTP request, while the JSON-RPC
 * router dispatches every element of a batch array. The batch surcharge in
 * src/api/rate_limit_tiers.js charges the remaining elements through
 * incrementBy, in O(1) whatever the batch length, which the library's own
 * MemoryStore cannot do without one awaited increment per element.
 *
 * No timer: expired windows are swept lazily, at most once per window, on the
 * next charge, so a hub that stops taking traffic holds no live handle.
 *
 ********************************************************************/

'use strict';

class FixedWindowStore {
    constructor() {
        this.windowMs = 60 * 1000;
        this.windows = new Map();
        this.nextSweepAt = 0;
        // Hits live in this process only; express-rate-limit reads this flag.
        this.localKeys = true;
    }

    // Called by express-rate-limit with the limiter's resolved options.
    init(options) {
        if (options && Number.isFinite(options.windowMs) && options.windowMs > 0) this.windowMs = options.windowMs;
    }

    // The key's current window, or null once it has expired.
    currentWindow(key, now) {
        const entry = this.windows.get(key);
        if (!entry) return null;
        if (entry.resetAt <= now) { this.windows.delete(key); return null; }
        return entry;
    }

    sweep(now) {
        if (now < this.nextSweepAt) return;
        for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
        this.nextSweepAt = now + this.windowMs;
    }

    // Charge `hits` against the key's window. Synchronous so a surcharge can decide
    // before any other request interleaves.
    incrementBy(key, hits) {
        const now = Date.now();
        this.sweep(now);
        let entry = this.currentWindow(key, now);
        if (!entry) { entry = { hits: 0, resetAt: now + this.windowMs }; this.windows.set(key, entry); }
        entry.hits += Math.max(0, Math.floor(hits));
        return { totalHits: entry.hits, resetTime: new Date(entry.resetAt) };
    }

    async increment(key) {
        return this.incrementBy(key, 1);
    }

    async get(key) {
        const entry = this.currentWindow(key, Date.now());
        return entry ? { totalHits: entry.hits, resetTime: new Date(entry.resetAt) } : undefined;
    }

    async decrement(key) {
        const entry = this.currentWindow(key, Date.now());
        if (entry && entry.hits > 0) entry.hits -= 1;
    }

    async resetKey(key) {
        this.windows.delete(key);
    }

    async resetAll() {
        this.windows.clear();
    }
}

module.exports = FixedWindowStore;
