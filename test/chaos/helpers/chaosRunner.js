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
 * Chaos Experiment Runner
 *
 * Provides the experiment lifecycle loop:
 *   1. BASELINE  — verify steady state
 *   2. INJECT    — introduce fault condition
 *   3. OBSERVE   — collect metrics during fault window
 *   4. RECOVER   — remove fault condition
 *   5. VERIFY    — confirm system returns to steady state
 *
 * Each experiment supplies inject/recover callbacks and observation config.
 */

/**
 * Run a chaos experiment.
 *
 * @param {object} opts
 * @param {string}   opts.name           - Human-readable experiment name
 * @param {function} opts.baseline       - async () => metrics — verify steady state, return baseline
 * @param {function} opts.inject         - async () => void — introduce the fault
 * @param {function} opts.observe        - async (baseline) => metrics — collect metrics during fault
 * @param {function} opts.recover        - async () => void — remove the fault
 * @param {function} opts.verify         - async (baseline) => void — confirm recovery
 * @param {number}   [opts.faultDuration] - ms to wait between inject and observe (default 0)
 * @returns {object} { baseline, observed }
 */
async function runExperiment(opts) {
    let { name, baseline, inject, observe, recover, verify, faultDuration } = opts;

    // 1. Baseline
    let baselineMetrics = null;
    if (baseline) {
        baselineMetrics = await baseline();
    }

    // 2. Inject fault
    await inject();

    // 3. Optional dwell time under fault
    if (faultDuration && faultDuration > 0) {
        await sleep(faultDuration);
    }

    // 4. Observe under fault
    let observed = null;
    if (observe) {
        observed = await observe(baselineMetrics);
    }

    // 5. Recover
    if (recover) {
        await recover();
    }

    // 6. Verify recovery
    if (verify) {
        await verify(baselineMetrics);
    }

    return { baseline: baselineMetrics, observed };
}

/**
 * Retry a function until it succeeds or times out.
 * Useful for verifying eventual recovery.
 *
 * @param {function} fn        - async () => void — assertion function
 * @param {number}   timeoutMs - max time to wait (default 5000)
 * @param {number}   intervalMs - polling interval (default 50)
 */
async function waitForCondition(fn, timeoutMs, intervalMs) {
    timeoutMs  = timeoutMs  || 5000;
    intervalMs = intervalMs || 50;
    let deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            await fn();
            return;
        } catch (e) {
            lastErr = e;
            await sleep(intervalMs);
        }
    }
    throw lastErr || new Error('waitForCondition timed out after ' + timeoutMs + 'ms');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runExperiment, waitForCondition, sleep };
