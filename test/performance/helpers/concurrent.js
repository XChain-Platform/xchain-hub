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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Concurrency driver for performance tests.
 *
 * Provides:
 *   - blast(fn, n)         — fire n calls in parallel, collect per-call timings
 *   - ramp(fn, levels, ms) — step through concurrency levels, collecting histograms
 *   - weightedPick(table)  — pick a random item using weighted distribution
 */

const { Histogram } = require('./metrics');

/**
 * Fire `n` calls of `fn` in parallel and collect timings.
 *
 * @param {Function} fn     - async function to invoke (receives call index)
 * @param {number}   n      - number of concurrent invocations
 * @returns {Promise<{histogram: Histogram, errors: number, results: Array}>}
 */
async function blast(fn, n) {
    let histogram = new Histogram('blast(' + n + ')');
    let errors    = 0;
    let results   = [];

    let promises = [];
    for (let i = 0; i < n; i++) {
        promises.push((async () => {
            let start = process.hrtime.bigint();
            try {
                let res = await fn(i);
                let ms  = Number(process.hrtime.bigint() - start) / 1e6;
                histogram.add(ms);
                results.push(res);
            } catch (e) {
                let ms = Number(process.hrtime.bigint() - start) / 1e6;
                histogram.add(ms);
                errors++;
            }
        })());
    }

    await Promise.all(promises);
    return { histogram, errors, results };
}

/**
 * Ramp through concurrency levels, running `fn` at each level.
 *
 * @param {Function}   fn       - async function to invoke (receives call index)
 * @param {number[]}   levels   - concurrency levels (e.g. [10, 25, 50, 100])
 * @param {number}     perLevel - total calls per level (default: level * 2)
 * @returns {Promise<{histograms: Object<number, Histogram>, errors: Object<number, number>}>}
 */
async function ramp(fn, levels, perLevel) {
    let histograms = {};
    let errors     = {};

    for (let level of levels) {
        let total      = perLevel || level * 2;
        let histogram  = new Histogram('concurrency=' + level);
        let errCount   = 0;
        let remaining  = total;

        // Fire in waves of `level` concurrent requests
        while (remaining > 0) {
            let batch = Math.min(level, remaining);
            let promises = [];
            for (let i = 0; i < batch; i++) {
                promises.push((async () => {
                    let start = process.hrtime.bigint();
                    try {
                        await fn(total - remaining + i);
                        let ms = Number(process.hrtime.bigint() - start) / 1e6;
                        histogram.add(ms);
                    } catch (e) {
                        let ms = Number(process.hrtime.bigint() - start) / 1e6;
                        histogram.add(ms);
                        errCount++;
                    }
                })());
            }
            await Promise.all(promises);
            remaining -= batch;
        }

        histograms[level] = histogram;
        errors[level]      = errCount;
    }

    return { histograms, errors };
}

/**
 * Pick a random item from a weighted distribution table.
 *
 * @param {Array<{weight: number, value: *}>} table
 * @returns {*} The chosen value
 *
 * @example
 *   weightedPick([
 *     { weight: 40, value: 'getprice' },
 *     { weight: 20, value: 'getfeequote' },
 *     { weight: 15, value: 'getpricesnapshots' }
 *   ]);
 */
function weightedPick(table) {
    let total = table.reduce((s, e) => s + e.weight, 0);
    let r     = Math.random() * total;
    let acc   = 0;
    for (let entry of table) {
        acc += entry.weight;
        if (r <= acc) return entry.value;
    }
    return table[table.length - 1].value;
}

module.exports = { blast, ramp, weightedPick };
