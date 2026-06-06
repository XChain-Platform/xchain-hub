'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Reusable validator sets for testing quorum/leader logic
// Each entry has { pubkey, addr } matching the shape used throughout the hub

function makeValidator(i) {
    let hex = String(i).padStart(2, '0');
    return {
        pubkey: hex.repeat(32),
        addr:   'ws://validator-' + i + ':10001'
    };
}

const VALIDATORS_1  = [makeValidator(1)];
const VALIDATORS_3  = [makeValidator(1), makeValidator(2), makeValidator(3)];
const VALIDATORS_4  = [makeValidator(1), makeValidator(2), makeValidator(3), makeValidator(4)];
const VALIDATORS_7  = Array.from({ length: 7 }, (_, i) => makeValidator(i + 1));
const VALIDATORS_10 = Array.from({ length: 10 }, (_, i) => makeValidator(i + 1));
const VALIDATORS_13 = Array.from({ length: 13 }, (_, i) => makeValidator(i + 1));

// Sample price data
const SAMPLE_PRICES = [
    { coinPair: 'BTC/USD', price: '100000.12345678', sources: 2 },
    { coinPair: 'LTC/USD', price: '85.50000000',     sources: 2 },
    { coinPair: 'DOGE/USD', price: '0.15000000',     sources: 2 }
];

// Build an oracle submission map from an array of { sender, prices }
function buildSubmissions(entries) {
    let map = new Map();
    for (let entry of entries) {
        map.set(entry.sender, {
            prices:    entry.prices,
            sources:   entry.sources || 2,
            timestamp: entry.timestamp || Date.now()
        });
    }
    return map;
}

// Build a simple submission map where all validators submit the same prices
function buildUniformSubmissions(validators, prices) {
    let entries = validators.map(v => ({
        sender: v.addr,
        prices: prices
    }));
    return buildSubmissions(entries);
}

module.exports = {
    makeValidator,
    VALIDATORS_1,
    VALIDATORS_3,
    VALIDATORS_4,
    VALIDATORS_7,
    VALIDATORS_10,
    VALIDATORS_13,
    SAMPLE_PRICES,
    buildSubmissions,
    buildUniformSubmissions
};
