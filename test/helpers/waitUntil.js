'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Poll helper for unit and integration suites, the in-process sibling of
// test/e2e/helpers/waitFor.js's `poll`.
//
// Use it for a case asserting an event DID happen: a fixed sleep long enough to
// be safe on a loaded box is dead time on every other run, and one short enough
// to be quick is the flake. A case asserting an event did NOT happen has
// nothing to poll and keeps its fixed settle.

/**
 * Poll `predicate` until it returns truthy, then return that value.
 *
 * @param {function(): (any|Promise<any>)} predicate condition under test
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=2000] give-up budget
 * @param {number}  [opts.intervalMs=5]   gap between probes
 * @param {string}  [opts.label]          named in the timeout error
 * @returns {Promise<any>} the predicate's first truthy value
 * @throws {Error} when the budget expires without the predicate holding
 */
async function waitUntil(predicate, opts) {
    const { timeoutMs = 2000, intervalMs = 5, label = 'condition' } = opts || {};
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() >= deadline) {
            throw new Error('waitUntil: timed out after ' + timeoutMs + 'ms waiting for ' + label);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

module.exports = { waitUntil };
