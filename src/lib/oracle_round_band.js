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
 * XChain Hub - Oracle round-number plausibility band
 *
 * An oracle round number is DERIVED, never chosen:
 *
 *     round = floor((now - ORACLE_EPOCH_START) / ORACLE_ROUND_INTERVAL)
 *
 * (OracleRound._executeRound). Every hub in a federation shares the epoch and
 * the interval, so a hub's own wall clock is a complete upper bound on every
 * round number an honest peer can ever present. A round numbered ahead of that
 * bound was not produced by the schedule: it is a corrupt row, a fixture, or a
 * peer with a broken clock.
 *
 * WHY THIS EXISTS. The regtest hub's price_snapshots carried
 * round_number 888100012 beside real rounds near 51688. That value is a
 * deliberate e2e price SENTINEL, written straight into the regtest DB by the
 * wallet / e2e price-seed fixtures so `clearSeedSentinels` can find and delete
 * exactly its own rows; the number is far out of band precisely so it always
 * outranks a derived round in a "highest round wins" selection. Nothing wrote
 * it through the hub, and nothing on a real network would. But the same column
 * on a validator is what the lost-round detector keys on, and one
 * out-of-band row there either swallows the whole gap scan or invents a
 * hundred-million-round hole. Hence two defences, both built on this module:
 * the ingest paths refuse an out-of-band round at WRITE time, and the
 * diagnostics RPC reports any row already stored outside the band so a
 * detector reading the hub can drop it instead of being fooled by it.
 *
 * THE BAND IS ONE-SIDED, and deliberately so. The past side is legitimately
 * wide: a chain-only node replaying history, an indexer catching up, or a
 * batch publisher covering an hour-long window all push rounds that are hours
 * or days old, and refusing those would drop real consensus output. The FUTURE
 * side is the one that cannot happen honestly, so that is the side that
 * rejects. `futureTolerance` absorbs ordinary clock skew between federation
 * members (a couple of round intervals), nothing more.
 *
 ********************************************************************/

'use strict';

// Rounds ahead of this hub's own current round that still count as plausible.
// Sized for clock skew between federation members, not for outages: a peer more
// than two round intervals ahead of local time is misconfigured, not early.
const DEFAULT_FUTURE_ROUND_TOLERANCE = 2;

/**
 * The round number the schedule is on at `nowMs`.
 *
 * COERCES its inputs rather than type-checking them, for the same reason
 * xchain_price_activation.roundStartSeconds does: OracleRound takes
 * ORACLE_ROUND_INTERVAL straight from config, so in a real deployment the
 * interval arrives as the STRING '600000' and a strict check would return null
 * on every configured hub - a failure that reads as "no band" and is invisible.
 * Booleans are excluded outright (Number(true) is 1, a plausible-looking
 * interval that is certainly a caller error).
 *
 * Returns null when the schedule cannot be resolved (no epoch, no interval, a
 * clock before the epoch). Null means "unknown", and every caller here treats
 * unknown as "do not judge", never as "reject".
 */
function currentRoundAt(nowMs, epochStartMs, roundIntervalMs) {
    if (typeof nowMs === 'boolean' || typeof epochStartMs === 'boolean' ||
        typeof roundIntervalMs === 'boolean') return null;
    let now      = Number(nowMs);
    let epoch    = Number(epochStartMs);
    let interval = Number(roundIntervalMs);
    if (!Number.isFinite(now) || !Number.isFinite(epoch) || !Number.isFinite(interval)) return null;
    if (interval <= 0) return null;
    if (now < epoch) return null;                 // clock before the epoch: unresolvable
    let round = Math.floor((now - epoch) / interval);
    return Number.isSafeInteger(round) ? round : null;
}

/**
 * The plausible round band for a hub, as { current, max, tolerance }.
 *
 * `max` is the highest round number this hub will accept as honestly produced.
 * There is no `min` beyond zero: see the one-sidedness note in the header.
 *
 * Returns null when the schedule is unresolvable, which callers must read as
 * "no opinion" rather than as a rejection.
 */
function roundBand(opts) {
    let o = opts || {};
    let current = currentRoundAt(
        o.nowMs === undefined ? Date.now() : o.nowMs, o.epochStartMs, o.roundIntervalMs);
    if (current === null) return null;
    let tolerance = Number(o.futureTolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0) tolerance = DEFAULT_FUTURE_ROUND_TOLERANCE;
    tolerance = Math.floor(tolerance);
    return { current: current, max: current + tolerance, tolerance: tolerance };
}

/**
 * Is `round` outside the band?
 *
 * True only for a value that cannot have come from the schedule: a non-integer,
 * a negative, or one past `band.max`. A null band (unresolvable schedule) makes
 * this false for every integral round: the check fails OPEN, because a hub that
 * cannot resolve its own schedule must not start refusing its federation's
 * consensus output on a guess.
 */
function isRoundImplausible(round, band) {
    let n = Number(round);
    if (!Number.isSafeInteger(n) || n < 0) return true;
    if (!band) return false;
    return n > band.max;
}

/**
 * One-line reason for a rejection or a diagnostic, e.g.
 *   "round 888100012 is 888048324 rounds past this hub's current round 51688"
 * Callers put this in a log line or an RPC field; it never carries a secret.
 */
function describeImplausibleRound(round, band) {
    let n = Number(round);
    if (!Number.isSafeInteger(n) || n < 0) {
        return 'round ' + String(round) + ' is not a usable round number';
    }
    if (!band) return 'round ' + n + ' could not be judged (oracle schedule unresolved)';
    return 'round ' + n + ' is ' + (n - band.current) +
           " rounds past this hub's current round " + band.current +
           ' (tolerance ' + band.tolerance + ')';
}

/**
 * Split a list of round numbers into the plausible ones and the out-of-band
 * ones. This is what a lost-round / gap detector wants: it can walk `inBand`
 * for real holes and report `outOfBand` as its own finding, instead of either
 * abandoning the scan or inventing a hundred-million-round gap.
 *
 * Input order is irrelevant; both lists come back ascending and de-duplicated.
 */
function partitionRounds(rounds, band) {
    let seen = new Set();
    let inBand = [];
    let outOfBand = [];
    for (let r of rounds || []) {
        let n = Number(r);
        if (seen.has(n)) continue;
        seen.add(n);
        (isRoundImplausible(n, band) ? outOfBand : inBand).push(n);
    }
    let asc = (a, b) => a - b;
    // Out-of-band values may be non-numeric (NaN sorts unstably), so keep them
    // in encounter order unless every one of them is a number.
    inBand.sort(asc);
    if (outOfBand.every((n) => Number.isFinite(n))) outOfBand.sort(asc);
    return { inBand: inBand, outOfBand: outOfBand };
}

module.exports = {
    DEFAULT_FUTURE_ROUND_TOLERANCE,
    currentRoundAt,
    roundBand,
    isRoundImplausible,
    describeImplausibleRound,
    partitionRounds,
};
