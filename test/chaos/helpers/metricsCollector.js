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
 * Metrics Collector
 *
 * Lightweight metrics capture for chaos experiments.
 * Tracks call counts, error rates, and timing on sinon stubs.
 */

/**
 * Capture call metrics from a sinon stub.
 *
 * @param {object} stub - sinon stub
 * @returns {object} { callCount, errors, lastCallArgs }
 */
function stubMetrics(stub) {
    let errors = 0;
    for (let i = 0; i < stub.callCount; i++) {
        let retVal = stub.returnValues[i];
        if (retVal && typeof retVal.then === 'function') {
            // Can't synchronously check promise rejection; count is best-effort
        }
    }
    return {
        callCount:    stub.callCount,
        lastCallArgs: stub.callCount > 0 ? stub.getCall(stub.callCount - 1).args : null
    };
}

/**
 * Create a call tracker that records invocations with timestamps.
 * Attach via sinon.stub().callsFake(tracker.record).
 *
 * @returns {object} tracker with .record() and .getLog()
 */
function createCallTracker() {
    let log = [];

    return {
        record: function () {
            log.push({
                timestamp: Date.now(),
                args:      Array.from(arguments)
            });
        },

        getLog: function () {
            return log;
        },

        getCount: function () {
            return log.length;
        },

        reset: function () {
            log = [];
        },

        getTimeBetweenCalls: function () {
            let deltas = [];
            for (let i = 1; i < log.length; i++) {
                deltas.push(log[i].timestamp - log[i - 1].timestamp);
            }
            return deltas;
        }
    };
}

/**
 * Track errors emitted on an EventEmitter via console.error/warn.
 * Returns a collector that can be queried for captured messages.
 *
 * @param {object} sinon - sinon sandbox
 * @returns {object} { errors: string[], warnings: string[], restore: function }
 */
function captureConsoleOutput(sinon) {
    let errors   = [];
    let warnings = [];

    let errorStub = sinon.stub(console, 'error').callsFake(function () {
        errors.push(Array.from(arguments).join(' '));
    });
    let warnStub = sinon.stub(console, 'warn').callsFake(function () {
        warnings.push(Array.from(arguments).join(' '));
    });
    // Suppress info/log during chaos tests
    let logStub = sinon.stub(console, 'log');

    return {
        errors:   errors,
        warnings: warnings,

        restore: function () {
            errorStub.restore();
            warnStub.restore();
            logStub.restore();
        },

        hasError: function (pattern) {
            return errors.some(e => e.includes(pattern));
        },

        hasWarning: function (pattern) {
            return warnings.some(w => w.includes(pattern));
        }
    };
}

module.exports = { stubMetrics, createCallTracker, captureConsoleOutput };
