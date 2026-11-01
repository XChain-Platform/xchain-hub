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

const INSTANCE_FLIGHTS = new WeakMap();

async function singleFlight(key, fetch) {
    let flights = INSTANCE_FLIGHTS.get(this);
    if (!flights) {
        flights = new Map();
        INSTANCE_FLIGHTS.set(this, flights);
    }
    if (flights.has(key)) return flights.get(key);

    const pending = fetch();
    flights.set(key, pending);
    try {
        return await pending;
    } finally {
        // Clear only this flight so a settled failure is retried by the next caller.
        if (flights.get(key) === pending) flights.delete(key);
    }
}

module.exports = { singleFlight };
