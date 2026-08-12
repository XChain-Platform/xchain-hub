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
 * XChain Hub - Oracle deviation band (, reviews-store seq 2400)
 *
 * ONE deviation formula for every oracle price gate, so the accept/withhold/
 * slash boundary is a single band federation-wide:
 *
 *     deviation = |value - reference| / reference
 *
 * where `reference` is always the canonical MEAN-side price (the leader's
 * proposed aggregate, the finalized round price, or the 2-source midpoint),
 * never a submitter-local value. Three call sites share this module:
 *
 *   1. Publish-side 2-source liveness gate (OracleConsensus._aggregate):
 *      each of two sorted submissions {lo, hi} deviates from their mean
 *      m = (lo+hi)/2 by |hi-m|/m = (hi-lo)/(hi+lo), so the gate is expressed
 *      as `twoSourceSpreadExceeds` WITHOUT computing a rounded intermediate
 *      mean. Rounds at scale 18 like sites 2 and 3: the pre-helper code used
 *      scale 8, which truncated a boundary spread back INSIDE the band the
 *      other two gates already read as outside it ()
 *      (CONSENSUS-CRITICAL: deploy fleet-wide atomically).
 *   2. Co-sign admission gate (OracleConsensus._handlePropose): the
 *      follower's local aggregate measured against the PROPOSED price as
 *      reference. (Before  this divided by the local value, opening a
 *      price-ratio window where the leader publishes a pair the follower
 *      then withholds the whole round over.)
 *   3. Slash detection (SlashDetector._checkDeviations): a submission
 *      measured against the FINALIZED round price as reference.
 *
 * All arithmetic is bcmath bignumber per the platform mandate, so the
 * +-band-boundary has no float-ULP ambiguity; comparisons use strict `>`
 * (exactly-at-threshold is inside the band on every path).
 *
 ********************************************************************/

const bcmath = require('../bcmath.js');

/**
 * Canonical mean-relative deviation of `value` from `reference`:
 * |value - reference| / reference, as a bcmath bignumber at `scale` decimals.
 * A zero/invalid reference yields deviation 0 (bcdiv's guard); callers must
 * pre-check reference > 0, as all three sites already do.
 */
function deviationFrom(value, reference, scale) {
    let diff    = bcmath.bcsub(value, reference, scale);
    let absDiff = bcmath.bclt(diff, 0) ? bcmath.bcmul(diff, '-1', scale) : diff;
    return bcmath.bcdiv(absDiff, reference, scale);
}

/** True when deviationFrom(value, reference) exceeds `threshold` (strict >). */
function exceedsBand(value, reference, threshold, scale) {
    return bcmath.bcgt(deviationFrom(value, reference, scale), String(threshold));
}

/**
 * Mean-relative deviation of each of two sorted submissions {lo, hi} from
 * their own midpoint: (hi - lo) / (hi + lo). Algebraically identical to
 * deviationFrom(hi, (lo+hi)/2) but computed without a rounded intermediate
 * mean, preserving the exact arithmetic of the original 2-source gate.
 */
function twoSourceSpread(lo, hi, scale) {
    return bcmath.bcdiv(bcmath.bcsub(hi, lo, scale), bcmath.bcadd(lo, hi, scale), scale);
}

/** True when twoSourceSpread(lo, hi) exceeds `threshold` (strict >). */
function twoSourceSpreadExceeds(lo, hi, threshold, scale) {
    return bcmath.bcgt(twoSourceSpread(lo, hi, scale), String(threshold));
}

module.exports = { deviationFrom, exceedsBand, twoSourceSpread, twoSourceSpreadExceeds };
