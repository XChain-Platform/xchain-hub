'use strict';

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
 * Performance measurement utilities.
 *
 * Provides:
 *   - measure(fn)     : time an async function, return { result, durationMs }
 *   - Histogram       : collect numeric samples; query min/max/mean/p50/p95/p99
 *   - MemoryTracker   : snapshot process.memoryUsage at intervals; report trend
 */

// ─── measure ────────────────────────────────────────────────────────

/**
 * Time an async function.
 * @param {Function} fn - async function to measure
 * @returns {Promise<{result: *, durationMs: number}>}
 */
async function measure(fn) {
    let start = process.hrtime.bigint();
    let result = await fn();
    let end = process.hrtime.bigint();
    let durationMs = Number(end - start) / 1e6;
    return { result, durationMs };
}

// ─── Histogram ──────────────────────────────────────────────────────

class Histogram {
    constructor(name) {
        this.name    = name || 'histogram';
        this.samples = [];
    }

    add(value) {
        this.samples.push(value);
    }

    get count() { return this.samples.length; }

    get min() {
        if (!this.samples.length) return 0;
        return Math.min(...this.samples);
    }

    get max() {
        if (!this.samples.length) return 0;
        return Math.max(...this.samples);
    }

    get mean() {
        if (!this.samples.length) return 0;
        return this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    }

    /**
     * Return the value at a given percentile (0-100).
     */
    percentile(p) {
        if (!this.samples.length) return 0;
        let sorted = this.samples.slice().sort((a, b) => a - b);
        let idx    = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, idx)];
    }

    get p50() { return this.percentile(50); }
    get p95() { return this.percentile(95); }
    get p99() { return this.percentile(99); }

    /**
     * Print a summary table to stdout.
     */
    report() {
        console.log(
            '    %-25s  count=%-6d  min=%-8.2f  mean=%-8.2f  p50=%-8.2f  p95=%-8.2f  p99=%-8.2f  max=%-8.2f',
            this.name, this.count, this.min, this.mean, this.p50, this.p95, this.p99, this.max
        );
    }

    /**
     * Return stats as a plain object.
     */
    toJSON() {
        return {
            name:  this.name,
            count: this.count,
            min:   +this.min.toFixed(2),
            mean:  +this.mean.toFixed(2),
            p50:   +this.p50.toFixed(2),
            p95:   +this.p95.toFixed(2),
            p99:   +this.p99.toFixed(2),
            max:   +this.max.toFixed(2)
        };
    }
}

// ─── MemoryTracker ──────────────────────────────────────────────────

class MemoryTracker {
    constructor() {
        this.snapshots = [];
        this._timer    = null;
    }

    /**
     * Take a single memory snapshot.
     */
    snapshot() {
        let mem = process.memoryUsage();
        this.snapshots.push({
            ts:          Date.now(),
            rss:         mem.rss,
            heapUsed:    mem.heapUsed,
            heapTotal:   mem.heapTotal,
            external:    mem.external,
            arrayBuffers: mem.arrayBuffers
        });
    }

    /**
     * Start recording snapshots at a fixed interval.
     * @param {number} intervalMs - milliseconds between snapshots (default 5000)
     */
    start(intervalMs) {
        this.snapshot();
        this._timer = setInterval(() => this.snapshot(), intervalMs || 5000);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
        this.snapshot();
    }

    /**
     * Calculate the growth ratio of a metric from first to last snapshot.
     * Returns a multiplier: 1.0 = no growth, 1.5 = 50% growth.
     */
    growthRatio(metric) {
        if (this.snapshots.length < 2) return 1.0;
        let first = this.snapshots[0][metric];
        let last  = this.snapshots[this.snapshots.length - 1][metric];
        return first > 0 ? last / first : 1.0;
    }

    /**
     * Print a summary of memory growth.
     */
    report() {
        if (this.snapshots.length < 2) {
            console.log('    MemoryTracker: not enough snapshots');
            return;
        }
        let first = this.snapshots[0];
        let last  = this.snapshots[this.snapshots.length - 1];
        let mb    = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';
        console.log('    Memory (%d snapshots over %ds):', this.snapshots.length,
            ((last.ts - first.ts) / 1000).toFixed(0));
        console.log('      RSS:      %s → %s  (%.1fx)', mb(first.rss), mb(last.rss), this.growthRatio('rss'));
        console.log('      HeapUsed: %s → %s  (%.1fx)', mb(first.heapUsed), mb(last.heapUsed), this.growthRatio('heapUsed'));
    }
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = { measure, Histogram, MemoryTracker };
