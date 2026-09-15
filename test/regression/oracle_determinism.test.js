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
 * Oracle determinism regression guards.
 *
 * The validator-specific risk is QUIET DIVERGENCE: two honest hubs, fed the
 * same oracle submissions but in different network arrival orders, must compute
 * the SAME finalized price and sign the SAME canonical PRICE v0 payload - else
 * their signatures don't match and the round can't finalize (or worse, the
 * federation splits). This pins two properties of OracleConsensus aggregation:
 *
 *   1. trimmed median is correct + discards outliers, and is independent of
 *      submission arrival order;
 *   2. the canonical PRICE v0 payload (what every hub signs) is byte-identical
 *      regardless of arrival order - even when the aggregate array order differs,
 *      because pairs are sorted before serialization.
 *
 * Pure (no DB / no network) so it runs in CI on every change.
 *
 * Determinism here is a consensus property, not a tidiness one: two hubs that
 * saw the same prices in a different order must sign the same bytes, so any
 * change that makes aggregation order-dependent is a fork and not a bug.
 */

const assert = require('assert');
const OracleConsensus = require('../../src/oracle/consensus');

// The aggregation/serialization methods don't touch the DB, peers, or identity,
// so we exercise them on a bare prototype instance.
function aggregator() { return Object.create(OracleConsensus.prototype); }

// Build a submissions Map<sender, {prices}> from a [sender, prices] list,
// applying an index permutation to simulate different network arrival orders.
function submissions(entries, order) {
    const seq = order ? order.map((i) => entries[i]) : entries;
    return new Map(seq.map(([s, prices]) => [s, { prices }]));
}
const priceMap = (results) => Object.fromEntries(results.map((p) => [p.coinPair, p.price]));

const oc = aggregator();

// 7 validators. BTC/USD carries an outlier (99999) that trimming must drop.
// v6 lists its pairs LTC-first so that, under a reversed arrival order, the
// aggregate array comes out in a DIFFERENT order than the forward order -
// which is exactly what the canonical (pair-sorted) payload must absorb.
const ENTRIES = [
    ['v0', [{ coinPair: 'BTC/USD', price: '100' }, { coinPair: 'LTC/USD', price: '70' }]],
    ['v1', [{ coinPair: 'BTC/USD', price: '200' }, { coinPair: 'LTC/USD', price: '72' }]],
    ['v2', [{ coinPair: 'BTC/USD', price: '300' }, { coinPair: 'LTC/USD', price: '74' }]],
    ['v3', [{ coinPair: 'BTC/USD', price: '400' }, { coinPair: 'LTC/USD', price: '76' }]],
    ['v4', [{ coinPair: 'BTC/USD', price: '500' }, { coinPair: 'LTC/USD', price: '78' }]],
    ['v5', [{ coinPair: 'BTC/USD', price: '600' }, { coinPair: 'LTC/USD', price: '80' }]],
    ['v6', [{ coinPair: 'LTC/USD', price: '80' }, { coinPair: 'BTC/USD', price: '99999' }]]
];

const FWD = [0, 1, 2, 3, 4, 5, 6];

const REV = [6, 5, 4, 3, 2, 1, 0];

const MIX = [3, 0, 6, 1, 5, 2, 4];

function registerSuitePart1() {
    it('trimmed median is correct and discards outliers @regression-p0', function () {
        const m = priceMap(oc.aggregateAll(submissions(ENTRIES)));
        // BTC/USD [100,200,300,400,500,600,99999] → trim 1/side → [200..600] → 400
        assert.strictEqual(m['BTC/USD'], '400.00000000', 'outlier not trimmed');
        // LTC/USD [70,72,74,76,78,80,80] → trim 1/side → [72,74,76,78,80] → 76
        assert.strictEqual(m['LTC/USD'], '76.00000000');
    });
}

function registerSuitePart2() {
    it('per-pair result is independent of submission arrival order @regression-p0', function () {
        const a = priceMap(oc.aggregateAll(submissions(ENTRIES, FWD)));
        const b = priceMap(oc.aggregateAll(submissions(ENTRIES, REV)));
        const c = priceMap(oc.aggregateAll(submissions(ENTRIES, MIX)));
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(a, c);
    });
}

function registerSuitePart3() {
    it('canonical PRICE v0 payload is byte-identical regardless of order @regression-p0', function () {
        const round = 42, ts = 1700000000;
        const build = (order) => oc.buildPriceV0Payload(round, ts, oc.aggregateAll(submissions(ENTRIES, order)));
        const fwd = build(FWD), rev = build(REV), mix = build(MIX);
        // Sanity: the payload sort must still absorb a genuinely out-of-order
        // input, so feed it one explicitly. (aggregateAll emits canonical order
        // itself, so reading the divergence straight off it would make the
        // assertion below a tautology; the un-canonical array has to be built by
        // hand.)
        const agg = oc.aggregateAll(submissions(ENTRIES, FWD));
        assert.ok(agg.length > 1, 'need >1 pair for the sort to be observable');
        const scrambled = oc.buildPriceV0Payload(round, ts, agg.slice().reverse());
        assert.strictEqual(fwd, scrambled, 'PRICE v0 payload sort did not absorb a reordered price array');
        assert.strictEqual(fwd, rev, 'canonical payload diverged with arrival order - signatures would not match');
        assert.strictEqual(fwd, mix);
    });
}

// The aggregate ARRAY itself is canonical, not just the payload built from
// it. It is what PROPOSE propagates and what price_snapshots stores, so two
// hubs with identical prices produce identical bytes. Consensus-breaking,
// and it shipped ungated with the pre-launch batch rather than behind an
// activation, so there is no height at which the old order is still valid.
function registerSuitePart4() {
    it('aggregate array order is canonical, not arrival-dependent @regression-p0', function () {
        const a = oc.aggregateAll(submissions(ENTRIES, FWD));
        const b = oc.aggregateAll(submissions(ENTRIES, REV));
        const c = oc.aggregateAll(submissions(ENTRIES, MIX));
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(a, c);
        assert.deepStrictEqual(a.map((p) => p.coinPair), ['BTC/USD', 'LTC/USD']);
    });
}

// The round digest is canonical over its own preimage too, so a digest
// re-derived from LOCAL aggregation matches the leader's.
function registerSuitePart5() {
    it('round digest is invariant to arrival order and to array order @regression-p0', function () {
        const dFwd = oc.digest(42, oc.aggregateAll(submissions(ENTRIES, FWD)));
        const dRev = oc.digest(42, oc.aggregateAll(submissions(ENTRIES, REV)));
        assert.strictEqual(dFwd, dRev, 'digest diverged with arrival order');
        const agg = oc.aggregateAll(submissions(ENTRIES, FWD));
        assert.strictEqual(dFwd, oc.digest(42, agg.slice().reverse()), 'digest diverged with array order');
    });
}

describe('Regression: Oracle determinism', function () {
    registerSuitePart1();
    registerSuitePart2();
    registerSuitePart3();
    registerSuitePart4();
    registerSuitePart5();

});
