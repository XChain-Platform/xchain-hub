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

// Microtask-turn counter for the await shape of a consensus path.
//
// Every await between a round's entry point and its first broadcast is a point
// where other queued promise work (a gossip handler already mid-flight, a second
// tick) runs before the round opens. Moving code into a helper can add one such
// point without changing any result a normal test reads, for example an async
// helper awaited where the code it came from ran synchronously. Counting turns
// pins the shape itself: with every dependency stubbed to an already-resolved
// promise, the count is deterministic, and one extra await shows up as +1.

/**
 * Start `start()` and count microtask turns until each mark first holds.
 *
 * @param {function(): void} start runs the path under test synchronously
 * @param {Object<string, function(): boolean>} marks named conditions to time
 * @param {number} [limit=50] turns to wait before giving up on a mark
 * @returns {Promise<Object<string, number>>} turn at which each mark first held;
 *   a mark that never held is absent
 */
async function turnsUntil(start, marks, limit) {
    const seen = {};
    const names = Object.keys(marks);
    let turns = 0;
    start();
    for (;;) {
        for (const name of names) if (!(name in seen) && marks[name]()) seen[name] = turns;
        if (Object.keys(seen).length === names.length || turns >= (limit || 50)) return seen;
        await null;
        turns += 1;
    }
}

/**
 * Wrap a promise so a mark can read whether it has settled.
 *
 * @param {Promise<any>} promise the path's returned promise
 * @returns {{ settled: boolean }} flips true once the promise settles either way
 */
function settleFlag(promise) {
    const flag = { settled: false };
    promise.then(() => { flag.settled = true; }, () => { flag.settled = true; });
    return flag;
}

module.exports = { turnsUntil, settleFlag };
