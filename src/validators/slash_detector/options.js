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
 * XChain Hub - Slash Detector: the price-deviation band a detector is built with.
 *
 * The band and the guards on its override are resolved once, at construction, and
 * a guard that fails throws there, so a detector that would slash inside the
 * co-signed band is never built.
 *
 ********************************************************************/

const { ORACLE_DEVIATION_THRESHOLD } = require('../../constants');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Price-deviation slash band. Defaults to the federation-uniform
// ORACLE_DEVIATION_THRESHOLD (constants.js), the same band the oracle
// co-sign gate (OracleConsensus._handlePropose) and the exactly-2-source
// publish gate (_aggregate) enforce, so by default we never slash a
// submission the federation just co-signed. This is the band's FLOOR, not
// the band in force every round: in a round where the aggregation clamp
// moved a pair's published price, checkDeviations widens that pair by
// maxChangeForPair, because the clamp is licensed to publish that far from
// the median every submitter stood behind (item 5833).
// A SLASH_DEVIATION_THRESHOLD override (env / governance) is still
// honored, but guarded:
//  - TIGHTER than the co-sign band would slash submitters INSIDE the
//    co-signed band (the exact inversion of the "never sign a price we
//    would slash" invariant), so it fails fast at construction;
//  - LOOSER only lets some co-sign-rejected deviations go unslashed
//    (a leniency/liveness asymmetry, not wrongful slashing), so it warns.
// Read on PRESENCE, never on truthiness. `parseFloat(x) || DEFAULT` ate the two
// values the guards below exist to catch: an explicit 0 is the TIGHTEST band an
// operator can express and therefore the exact inversion the throw is for, but it
// is falsy, so it silently became the default and neither the throw nor the warn
// ever fired. Dropping the `||` makes the finiteness check load-bearing rather
// than cosmetic: a typo'd value now parses to NaN, which passes both guards below
// (`NaN < x` is false, `NaN !== x` is true) and would reach checkDeviations.
// The band is not compared with a JS `>` there but handed to
// deviation_band.exceedsBand, and that was executed rather than reasoned about:
// with a NaN band it returns TRUE for any deviation at all (0.1% off the
// published price included), so a NaN band does not disable slashing, it slashes
// the whole honest federation. That is a direct breach of the never-slash-inside-
// the-co-signed-band invariant stated above, which is why a non-finite override
// must throw at construction and not fall back. Same dead-knob class the
// ORACLE_SUBMISSIONS_RETENTION_ROUNDS passthrough already guards at api.js:395.
function resolveDeviationThreshold(p2pConfig) {
    let rawBand = p2pConfig.SLASH_DEVIATION_THRESHOLD;
    let hasBand = rawBand !== undefined && rawBand !== null && String(rawBand).trim() !== '';
    let deviationThreshold = hasBand ? parseFloat(rawBand) : ORACLE_DEVIATION_THRESHOLD;
    if (hasBand && !Number.isFinite(deviationThreshold)) {
        throw new Error('SLASH_DEVIATION_THRESHOLD (' + rawBand + ') is not a valid number: ' +
            'remove the override or set it to a finite value >= the federation-uniform ' +
            'ORACLE_DEVIATION_THRESHOLD (' + ORACLE_DEVIATION_THRESHOLD + ').');
    }
    if (deviationThreshold < ORACLE_DEVIATION_THRESHOLD) {
        throw new Error('SLASH_DEVIATION_THRESHOLD (' + deviationThreshold +
            ') is below the federation-uniform ORACLE_DEVIATION_THRESHOLD (' +
            ORACLE_DEVIATION_THRESHOLD + '): this would slash submissions inside the ' +
            'co-signed band. Remove the override or set it >= the oracle band.');
    }
    if (deviationThreshold !== ORACLE_DEVIATION_THRESHOLD) {
        logger.warn('SlashDetector: SLASH_DEVIATION_THRESHOLD=' + deviationThreshold +
            ' diverges from the federation-uniform ORACLE_DEVIATION_THRESHOLD=' +
            ORACLE_DEVIATION_THRESHOLD + '; deviations between the two bands will be ' +
            'co-sign-rejected but never slashed.');
    }
    return deviationThreshold;
}

module.exports = { resolveDeviationThreshold };
