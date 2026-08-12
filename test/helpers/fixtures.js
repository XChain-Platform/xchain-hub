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

// STAKE_WEIGHTED_QUORUM fixtures: validators carry a staking source + weight.
function makeWeightedValidator(i, source, weight) {
    let v = makeValidator(i);
    return { pubkey: v.pubkey, addr: v.addr, source: source, weight: String(weight) };
}

// One whale source holding >2/3 of stake + three small distinct sources.
// S = 1000 + 100 + 100 + 100 = 1300. Whale alone: 3·1000 = 3000 > 2·1300 = 2600
// (a COUNT minority of one clears the weighted threshold); any subset of the
// three small sources is a COUNT majority but a STAKE minority.
const WEIGHTED_VALIDATORS_4 = [
    makeWeightedValidator(1, 'srcWhale', '1000'),
    makeWeightedValidator(2, 'src2', '100'),
    makeWeightedValidator(3, 'src3', '100'),
    makeWeightedValidator(4, 'src4', '100')
];

// Build a getActiveWeightSnapshot-shaped result from weighted validators.
function makeWeightSnapshot(validators, blockIndex) {
    let sources = new Set(validators.map(v => v.source));
    return {
        capability:  '*',
        blockIndex:  blockIndex,
        count:       validators.length,
        sourceCount: sources.size,
        validators:  validators.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight }))
    };
}

// Build a getActiveValidatorSnapshot-shaped whole-federation snapshot whose
// members are the validators under test. Consensus elects its leader from the
// snapshot population rather than the live validatorSet, so a snapshot
// carrying a placeholder pubkey no longer stands in for a real one: it now
// describes a federation with exactly one unaddressable member.
function makeFederationSnapshot(validators, blockIndex, amount) {
    return {
        capability: '*',
        blockIndex: blockIndex,
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: String(amount || '50000') }))
    };
}

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
    makeWeightedValidator,
    makeWeightSnapshot,
    makeFederationSnapshot,
    VALIDATORS_1,
    VALIDATORS_3,
    VALIDATORS_4,
    VALIDATORS_7,
    VALIDATORS_10,
    VALIDATORS_13,
    WEIGHTED_VALIDATORS_4,
    SAMPLE_PRICES,
    buildSubmissions,
    buildUniformSubmissions
};
