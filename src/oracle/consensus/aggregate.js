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
 *
 * XChain Hub - Oracle Consensus: aggregation
 *
 * The trimmed median every hub must compute identically: the per-pair value set, the
 * trim, the even-split deviation gate, the per-round move clamp, and the canonical
 * digest preimage the round is proposed and voted on under.
 *
 ********************************************************************/

'use strict';

const crypto            = require('crypto');
const { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD } = require('../../constants.js');
const bcmath            = require('../../bcmath.js');
const devband           = require('../../consensus/deviation_band.js');
const { maxChangeForPair } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

const TRIM_PERCENT = 0.15;  // Discard top and bottom 15% of submissions

// Every in-bounds price the round offers for `coinPair`, one value per sender so a
// submission repeating a pair cannot shift the trim boundary.
function collectPairValues(submissions, coinPair) {
    // Collect all prices for this pair. Keep the original string `s` alongside a
    // float `f` used only for ordering. The median value itself is computed in
    // bignumber (bcmath) per the platform's bignumber mandate, so the
    // signed aggregate carries no float/`.toFixed` rounding artifact.
    let values = [];
    for (let [sender, sub] of submissions) {
        if (sub.prices && Array.isArray(sub.prices)) {
            for (let p of sub.prices) {
                if (p.coinPair === coinPair && p.price) {
                    let val = parseFloat(p.price);
                    if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                        values.push({ f: val, s: String(p.price) });
                        // Cap each sender at one data point per pair. A
                        // submission could contain N entries for the same
                        // pair; counting them all would inflate values.length
                        // and shift the trim boundary, letting an outlier
                        // survive. Stop after the first valid value.
                        break;
                    }
                }
            }
        }
    }
    return values;
}

// Sort ascending and trim both tails; null (logged) when the trim empties the set.
function trimPairValues(values, coinPair) {
    // Sort ascending (ordering only; float compare is fine here)
    values.sort((a, b) => a.f - b.f);

    // Trim top and bottom 15%. Use Math.ceil so at least one value is trimmed
    // once N >= 4 (Math.floor yields 0 for all N <= 6, making the trim a no-op
    // in small federations and leaving a single in-bounds outlier able to shift
    // a 2-source median by ~50%).
    let trimCount = Math.ceil(values.length * TRIM_PERCENT);
    if (trimCount > 0 && values.length > 2 * trimCount) {
        values = values.slice(trimCount, values.length - trimCount);
    }
    // Defensive: the slice above always leaves >= 1 value when it runs, but
    // if trimming ever empties the array, surface the drop instead of
    // silently omitting the pair (item #180).
    if (values.length === 0) {
        logger.warn('Oracle: dropping ' + coinPair + ' this round: trimming emptied the value set');
        return null;
    }
    return values;
}

// Compute median in bignumber (no float midpoint average / .toFixed artifact)
function medianOf(values, mid) {
    let median;
    if (values.length % 2 === 0) {
        // Round ONCE (item 7663). The sum and the quotient carry scale 18 and only the
        // final bcformat quantizes to the published 8. The previous scale-8 add plus
        // scale-8 divide rounded twice, and near the 8-decimal ulp that put the median
        // one ulp OUTSIDE the value both middles agree on: two submissions of
        // 0.0000001425 each quantize to 0.00000014, while bcadd(...,8) gave 0.00000029
        // and halving that gave 0.00000015. A co-signer re-deriving over the
        // proposer-excluded set lands on 0.00000014 and the band in handlePropose
        // scores 6.667%, rejecting the WHOLE proposal, so one pair wedged the round.
        // Rounding once restores the invariant the even-split gate below relies on:
        // quantization is monotone, so if both middles quantize to X, so does their
        // exact mean. Inert for 8-decimal producers (the scale-8 add was already exact
        // for them); it moves the published value only for finer-than-8-decimal input.
        // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
        median = bcmath.bcformat(bcmath.bcdiv(bcmath.bcadd(values[mid - 1].s, values[mid].s, 18), '2', 18), 8);
    } else {
        median = bcmath.bcformat(values[mid].s, 8);
    }
    return median;
}

// Even-split deviation gate (items 4496, 5333). An even-length set has no real
// median: the aggregate below is the MEAN of the two middle values, so a two-camp
// feed disagreement publishes a price NO submitter stands behind. The sort leaves
// nothing between values[mid-1] and values[mid], so every value sits at or beyond
// one of them and the CLOSEST submitter's deviation from that mean is exactly
// (hi - lo) / (hi + lo). Refuse to publish the pair once that exceeds
// ORACLE_DEVIATION_THRESHOLD, i.e. once the mean would put every submitter outside
// the band. That matches SlashDetector's default band (it defaults to this same
// ORACLE_DEVIATION_THRESHOLD and fail-fasts on a tighter override), so we never
// federation-sign a price we would then slash; the pair is simply omitted this
// round and consumers hold the last snapshot.
// The gate runs AFTER the trim, not before it (item 5333). A raw-count-only N==2
// check missed every set the ceil-trim REDUCES to an even split - N=4 leaves 2
// values, N=6 and N=8 leave 4 - and there the leader published the unbackable mean
// while every honest follower, re-deriving over the proposer-excluded (odd) set,
// landed on a single camp value, tripped the co-sign band in handlePropose and
// rejected the WHOLE proposal, so one pair's disagreement wedged the entire round
// in the finalization timeout with no skipped-round row. A 2-value set is never
// trimmed (values.length > 2 * trimCount is false at N=2), so this placement
// strictly subsumes the old raw N==2 check rather than adding a second gate.
// Shared deviation_band helper: (hi-lo)/(hi+lo), no rounded intermediate mean.
// Scale 18, NOT the original inline scale 8: the co-sign gate (handlePropose) and
// SlashDetector both round at 18, so a scale-8 publish gate truncates a boundary
// spread back inside the band and federation-signs a price the other two gates then
// withhold or slash. Uses the hardcoded constant (not an env value) and bignumber
// math so every hub gates identically.
// CONSENSUS-CRITICAL: deploy fleet-wide atomically.
//
// The gate measures the ROUNDED median, not the exact midpoint (item 7067). The
// exact-midpoint form ((hi-lo)/(hi+lo)) answered a question no other gate asks:
// the price a co-signer receives is the 8-decimal median computed below, and
// rounding moves it off the midpoint by up to half an ulp, which is enough to
// straddle the band. Measured, not reasoned: 0.09500010 and 0.10500011 spread
// 0.049999997500002625 (inside), median 0.10000011, and the low submission then
// sits 0.0500000449999505 from THAT (outside). A follower re-deriving over the
// proposer-excluded set lands on 0.09500010, trips the identical band in
// handlePropose, and rejects the WHOLE proposal, so one boundary pair wedges the
// round in a finalization timeout. Both middles are checked because rounding moves
// the reference toward one of them and away from the other, so either can be the
// far side; with 8-decimal submissions (what every producer emits) that is the
// only difference from the midpoint form, and it is strictly the safe direction.
// Both SIDES are quantized to 8 decimals first, because that is the comparison
// handlePropose actually performs: the follower's local aggregate is itself an
// 8-decimal median, so measuring a raw sub-8-decimal submission against a rounded
// reference would score quantization error as feed disagreement and drop a pair
// every submitter agreed on exactly (found by the fuzz property, at 1.05e-8: one
// 8-decimal ulp is 5% of a price that small).
function evenSplitRejected(values, mid, median, coinPair) {
    // sorted ascending, both > 0; quantized to the published scale (see above)
    let lo = bcmath.bcformat(values[mid - 1].s, 8), hi = bcmath.bcformat(values[mid].s, 8);
    // The gate is UNCONDITIONAL (item 7663). No short-circuit for the case where
    // both middles quantize to the same price, even though one camp cannot
    // disagree with itself: that reasoning holds only while the median is rounded
    // twice, and under double rounding the skip fires in exactly the unanimous
    // case where the published median can sit one ulp off the camp's own value,
    // making the one check that catches it the one being skipped. With the median
    // rounded once above, lo === hi implies median === lo, and both band calls
    // measure a value against itself and score 0, so the unconditional form
    // costs no pair that would publish today. What it buys is a standing guarantee
    // that the leader never federation-signs a price its own middle submissions
    // would withhold on, whatever later sub-ulp divergence reaches this point.
    if (devband.exceedsBand(lo, median, ORACLE_DEVIATION_THRESHOLD, 18) ||
        devband.exceedsBand(hi, median, ORACLE_DEVIATION_THRESHOLD, 18)) {
        logger.warn('Oracle: dropping ' + coinPair + ' this round: the two middle values '
            + 'disagree beyond the ' + (ORACLE_DEVIATION_THRESHOLD * 100) + '% mean-deviation gate ('
            + lo + ' vs ' + hi + '), so the published price ' + median
            + ' would put every submitter outside the band');
        return true;
    }
    return false;
}

module.exports = {

    aggregateAll(submissions) {
        if (!submissions) return [];   // no submission map for this round (guard: for..of undefined throws)
        let coinPairs = new Set();
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair) coinPairs.add(p.coinPair);
                }
            }
        }

        let results = [];
        for (let pair of coinPairs) {
            let price = this.aggregate(submissions, pair);
            if (price !== null) {
                results.push({ coinPair: pair, price: price });
            }
        }
        // Emit in canonical pair order rather than coinPairs Set
        // insertion order (first-seen across submissions, i.e. a function of
        // arrival order). The per-pair VALUES were already order-invariant; the
        // ARRAY was not, and this array is what gets propagated on PROPOSE and
        // stored in price_snapshots, so two hubs with identical prices produced
        // different bytes for the same round. digest canonicalizes its own
        // preimage independently (defence in depth for wire payloads this
        // method did not build), and buildPriceV0Payload already sorted; this
        // makes the propagated and stored array agree with both.
        return results.sort((a, b) => {
            if (a.coinPair < b.coinPair) return -1;
            if (a.coinPair > b.coinPair) return 1;
            return 0;
        });
    },

    // Aggregate a single coin pair using trimmed median
    aggregate(submissions, coinPair) {
        if (!submissions) return null;
        let values = collectPairValues(submissions, coinPair);

        if (values.length === 0) {
            // Surface the drop (item #180): without this line a pair whose every
            // submission fails the >0 / <PRICE_MAX clamp (or is absent) vanishes
            // from the round with no signal at all.
            logger.warn('Oracle: dropping ' + coinPair + ' this round: no usable submission '
                + 'values (all missing, non-numeric, or outside the price clamp)');
            return null;
        }

        values = trimPairValues(values, coinPair);
        if (values === null) return null;

        let mid = Math.floor(values.length / 2);
        let median = medianOf(values, mid);

        // deviation_band's stated precondition: a zero reference makes bcdiv's guard
        // return deviation 0, so every gate below it would pass vacuously. A median that
        // rounds to zero is also not a price anything can be denominated in, so drop the
        // pair rather than federation-sign a 0.00000000. Unreachable from an 8-decimal
        // producer, which already refuses a value that formats to zero.
        if (!bcmath.bcgt(median, '0')) {
            logger.warn('Oracle: dropping ' + coinPair + ' this round: the aggregate rounds to '
                + median + ' at 8 decimals, which is not a publishable price');
            return null;
        }

        if (values.length % 2 === 0 && evenSplitRejected(values, mid, median, coinPair)) return null;
        return this.clampToLastFinalized(coinPair, median);
    },

    // Per-pair bounded-change clamp. The trim + median above bound what a
    // MINORITY of bad feeds can do; nothing bounds the aggregate itself, so a real
    // fat-tail print (or a majority of correlated bad sources) still lands in one
    // round and immediately drives USD-pegged fee math. Bound the finalized price's
    // per-round movement to ORACLE_MAX_CHANGE_PER_ROUND relative to the pair's last
    // FINALIZED snapshot: a genuine sustained move walks to the new level over a few
    // rounds (cache updates each finalized round), a one-round spike is absorbed.
    // Federation-uniform ARITHMETIC, converging reference: the bound and the formula are
    // identical on every hub, and _lastFinalizedPrices is derived from price_snapshots,
    // not from this process's finalize history (seeded at start, advanced by every
    // finalized round this hub stores, folded from the push-ingest stream, and re-seeded
    // on a timer). It is NOT identical by construction: a hub that missed the round its
    // peers just finalized clamps against an older reference until one of those writers
    // catches it up, so two hubs can straddle a finalization for up to one re-seed
    // interval (item 5834; closing the window entirely is a separate, deliberate
    // round-aligned change). No history (brand-new pair, cold standalone cache) means no
    // clamp; the unverifiable-pair gate covers that case on the co-sign side.
    // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
    clampToLastFinalized(coinPair, price) {
        let last = this.getLastFinalizedPrice(coinPair);
        if (last === null || !bcmath.bcgt(last, '0')) return price;
        let pct = maxChangeForPair(coinPair);
        let maxDelta = bcmath.bcmul(last, String(pct), 8);
        let hi = bcmath.bcadd(last, maxDelta, 8);
        let lo = bcmath.bcsub(last, maxDelta, 8);
        if (bcmath.bcgt(price, hi)) {
            logger.warn('Oracle: clamping ' + coinPair + ' aggregate ' + price + ' to ' +
                bcmath.bcformat(hi, 8) + ' (last finalized ' + last + ', max +' +
                (pct * 100) + '%/round)');
            return bcmath.bcformat(hi, 8);
        }
        if (bcmath.bclt(price, lo)) {
            logger.warn('Oracle: clamping ' + coinPair + ' aggregate ' + price + ' to ' +
                bcmath.bcformat(lo, 8) + ' (last finalized ' + last + ', max -' +
                (pct * 100) + '%/round)');
            return bcmath.bcformat(lo, 8);
        }
        return price;
    },

    // Canonicalize the digest PREIMAGE, not just hash whatever array
    // arrived. `aggregateAll` emits its results in coinPairs Set insertion
    // order (first-seen across submissions), which is a function of submission
    // ARRIVAL order, not of the round's content. Raw JSON.stringify therefore
    // made the digest depend on that arrival order, plus on the key order of
    // each entry object as the proposer happened to serialize it. Today that is
    // masked because followers re-hash the LEADER's propagated array, so both
    // sides see the same order; the moment any path re-derives a digest from
    // its OWN aggregation (or a proposer reorders a payload it re-serializes),
    // two honest hubs disagree on the digest for identical prices and the round
    // stalls. Canonicalizing makes the digest a function of the {pair -> price}
    // mapping alone.
    //
    // Shape: entries sorted by coinPair, projected to exactly [coinPair, price]
    // as strings in fixed order. String coercion mirrors the DEX's
    // canonicalMatch discipline (a numeric 80 and the string '80' are the same
    // price and must hash alike). Projection also means a padded extra field on
    // the wire cannot change the digest; the per-pair semantic validation on the
    // PROPOSE path, and the separately signed PRICE v0 canonical, are what bind
    // the values themselves. `prices` itself is never mutated or reordered: only
    // the preimage is canonical, so stored rows and the propagated array are
    // untouched.
    //
    // Consensus-breaking (every round digest changes), so it ships ungated with
    // the pre-launch batch and its mandatory fleet-wide rebase.
    canonicalDigestPrices(prices) {
        if (!Array.isArray(prices)) return prices;
        return prices
            .map(p => ({
                coinPair: (p && p.coinPair !== undefined && p.coinPair !== null) ? String(p.coinPair) : '',
                price:    (p && p.price    !== undefined && p.price    !== null) ? String(p.price)    : ''
            }))
            .sort((a, b) => {
                if (a.coinPair < b.coinPair) return -1;
                if (a.coinPair > b.coinPair) return 1;
                // Duplicate pairs are not produced by aggregateAll, but a wire
                // payload can carry them; order them by price so the digest is
                // still total rather than arrival-dependent.
                if (a.price < b.price) return -1;
                if (a.price > b.price) return 1;
                return 0;
            });
    },

    digest(round, prices) {
        let payload = JSON.stringify({ round: round, prices: this.canonicalDigestPrices(prices) });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
};
