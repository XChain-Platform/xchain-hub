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

const fc = require('fast-check');

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

// Positive finite price as a JS number (realistic oracle range).
// Upper bound is just below the oracle's PRICE_MAX cap (10,000,000) so generated
// values reach the high-magnitude non-USD range (KRW/JPY ~ millions per BTC) where
// parseFloat + toFixed(8) precision is most at risk, while staying within the
// production validity filter (val < PRICE_MAX) so prices aren't silently dropped.
function fc_price() {
    return fc.double({ min: 0.00000001, max: 9_999_999, noNaN: true, noDefaultInfinity: true })
        .filter(n => Number.isFinite(n) && n > 0);
}

// Price as a numeric string (what submissions carry)
function fc_priceString() {
    return fc_price().map(n => String(n));
}

// Strings that should be rejected by the aggregation filter (!isNaN(val) && val > 0)
function fc_invalidPriceString() {
    return fc.oneof(
        fc.constant('0'),
        fc.constant('-1'),
        fc.constant('-100'),
        fc.constant('NaN'),
        fc.constant('Infinity'),
        fc.constant('-Infinity'),
        fc.constant(''),
        fc.constant('not-a-number'),
        fc.constant('abc'),
        fc.double({ min: -1_000_000, max: 0, noNaN: true }).map(n => String(n))
    );
}

// Array of valid prices
function fc_priceArray(minLen, maxLen) {
    return fc.array(fc_price(), { minLength: minLen || 1, maxLength: maxLen || 20 });
}

// ---------------------------------------------------------------------------
// Coin pairs
// ---------------------------------------------------------------------------

// One of the three known pairs
function fc_knownCoinPair() {
    return fc.constantFrom('BTC/USD', 'LTC/USD', 'DOGE/USD');
}

// Known pair or a synthetic unknown pair
function fc_coinPair() {
    return fc.oneof(
        fc_knownCoinPair(),
        fc.string({ unit: fc.constantFrom('A','B','C','X','Y','Z'), minLength: 2, maxLength: 6 })
            .map(s => s + '/USD')
    );
}

// ---------------------------------------------------------------------------
// Oracle submissions
// ---------------------------------------------------------------------------

// A single submission entry suitable for buildSubmissions()
function fc_submissionEntry(coinPairArb) {
    return fc.record({
        sender: fc.string({ unit: fc.constantFrom('a','b','c','d','e','f','0','1','2','3'), minLength: 3, maxLength: 10 })
            .map(s => 'ws://' + s + ':10001'),
        prices: fc.array(
            fc.record({
                coinPair: coinPairArb || fc_knownCoinPair(),
                price:    fc_priceString()
            }),
            { minLength: 1, maxLength: 3 }
        )
    });
}

// Generates a Map<sender, {prices, sources, timestamp}> with unique senders
function fc_submissionMap(minSenders, maxSenders) {
    return fc.array(
        fc_submissionEntry(),
        { minLength: minSenders || 1, maxLength: maxSenders || 20 }
    ).map(entries => {
        let m = new Map();
        for (let e of entries) {
            m.set(e.sender, {
                prices:    e.prices,
                sources:   1,
                timestamp: Date.now()
            });
        }
        return m;
    });
}

// ---------------------------------------------------------------------------
// Hex strings
// ---------------------------------------------------------------------------

// Fixed-length lowercase hex string (byteLen * 2 chars)
function fc_hexString(byteLen) {
    return fc.string({ unit: fc.constantFrom('0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f'), minLength: byteLen * 2, maxLength: byteLen * 2 });
}

// Valid 64-char hex (32-byte Ed25519 seed)
function fc_validPrivkeyHex() {
    return fc_hexString(32);
}

// Strings that fail the /^[0-9a-fA-F]{64}$/ regex
function fc_invalidPrivkeyHex() {
    return fc.oneof(
        fc.constant(''),
        fc.constant(null),
        fc.constant(undefined),
        fc_hexString(31),                        // 62 chars: too short
        fc_hexString(33),                        // 66 chars: too long
        fc.string({ minLength: 64, maxLength: 64 })
            .filter(s => !/^[0-9a-fA-F]{64}$/.test(s))
    );
}

// ---------------------------------------------------------------------------
// P2P message envelopes
// ---------------------------------------------------------------------------

// Well-formed P2P envelope (passes all field validation in _handleInbound)
function fc_p2pEnvelope(selfAddr) {
    return fc.record({
        type:      fc.string({ unit: fc.constantFrom('A','B','C','_','O','R','P'), minLength: 3, maxLength: 20 }),
        id:        fc.string({ unit: fc.constantFrom('a','b','c','1','2','3','-'), minLength: 5, maxLength: 30 }),
        sender:    fc.string({ unit: fc.constantFrom('a','b','c','d','1','2','3'), minLength: 3, maxLength: 15 })
            .map(s => 'ws://' + s + ':10001')
            .filter(s => s !== selfAddr),
        timestamp: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        data:      fc.record({})
    });
}

// Objects that fail field validation at various points
function fc_malformedEnvelope() {
    return fc.oneof(
        fc.constant({}),
        fc.constant({ type: 123, id: 'abc', sender: 'x', timestamp: 1 }),
        fc.constant({ type: 'T', id: 123, sender: 'x', timestamp: 1 }),
        fc.constant({ type: 'T', id: 'abc', timestamp: 1 }),                    // no sender
        fc.constant({ type: 'T', id: 'abc', sender: 'x', timestamp: 'bad' }),   // string timestamp
        fc.constant({ type: '', id: 'abc', sender: 'x', timestamp: 1 }),         // empty type
        fc.constant({ type: 'T', id: '', sender: 'x', timestamp: 1 }),           // empty id
        fc.constant({ type: 'T', id: 'abc', sender: '', timestamp: 1 }),         // empty sender
        fc.constant(null),
        fc.constant(42),
        fc.constant('string'),
        fc.constant([1, 2, 3])
    );
}

// ---------------------------------------------------------------------------
// Config objects
// ---------------------------------------------------------------------------

function fc_configObject() {
    return fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.oneof(fc.string({ maxLength: 50 }), fc.integer(), fc.boolean(), fc.constant(null))
    );
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

function fc_govParamValues() {
    return fc.record({
        current:  fc.double({ min: 0.0001, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
            .filter(n => Number.isFinite(n) && n > 0),
        proposed: fc.double({ min: 0.0001, max: 2_000_000, noNaN: true, noDefaultInfinity: true })
            .filter(n => Number.isFinite(n) && n > 0)
    });
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function fc_validatorCount() {
    return fc.integer({ min: 1, max: 100 });
}

function fc_validatorSet(n) {
    return Array.from({ length: n }, (_, i) => ({
        pubkey: String(i + 1).padStart(2, '0').repeat(32),
        addr:   'ws://validator-' + (i + 1) + ':10001'
    }));
}

module.exports = {
    fc_price,
    fc_priceString,
    fc_invalidPriceString,
    fc_priceArray,
    fc_knownCoinPair,
    fc_coinPair,
    fc_submissionEntry,
    fc_submissionMap,
    fc_hexString,
    fc_validPrivkeyHex,
    fc_invalidPrivkeyHex,
    fc_p2pEnvelope,
    fc_malformedEnvelope,
    fc_configObject,
    fc_govParamValues,
    fc_validatorCount,
    fc_validatorSet
};
