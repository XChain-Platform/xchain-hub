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
 * XChain Hub - PRICE batch cadence ceiling
 *
 * The PRICE batch rail and the native-coin fee gate are two halves of one
 * timing contract, and until this module existed nothing tied them together.
 *
 * The rail publishes one on-chain wire per WINDOW of ORACLE_BATCH_WINDOW_ROUNDS
 * finalized rounds. The fee gate (xchain-indexer getFeeOraclePrices ->
 * getLatestPrice) refuses to price an action whose block time is more than
 * ORACLE_MAX_PRICE_AGE_SECONDS past the newest snapshot it can see, and the
 * newest snapshot a chain reader can see is the LAST round of the most recently
 * landed batch. So the age of the freshest snapshot sawtooths: it resets when a
 * batch lands and then climbs for a whole window before the next one does.
 *
 * The peak of that sawtooth is
 *
 *     windowRounds * roundInterval + grace + landingReserve
 *
 * where `grace` is ORACLE_BATCH_GRACE_MS (the straggler wait armed when the
 * window's last round finalizes) and `landingReserve` covers assembly, the
 * co-signing round, the broadcast and the DOGE confirmation before the batch is
 * readable on chain.
 *
 * Shipped defaults put that peak at 6 * 600s + 300s + 300s = 4200s (about 4080s
 * at the ~180s landing latency actually measured, against the 300s budgeted here)
 * against a 1800s bound: measured on public testnet 2026-09-01, TDOGE published
 * PRICE on a steady 3600s cadence and fee-bearing actions were unpriceable for
 * the majority of every hour. Nothing was broken in the publisher,
 * the aggregator, or the wire; the window was simply sized without reference to
 * the bound it has to fit inside. The batching spec's own review checked that
 * batching cannot FORK fee validity (both sides of the comparison are
 * chain-derived) and stopped there, which is true and not the question.
 *
 * This module derives the largest window that fits, so the two knobs cannot
 * drift apart again: the ceiling moves on its own if the round cadence, the
 * grace, or the pinned staleness bound ever changes.
 *
 * Non-consensus, deliberately. Batch validation is range-agnostic
 * (OracleBatchSigner derives its own window for whatever [first,last] a leader
 * proposes), so hubs running different window sizes elect different leaders and
 * may double-cover a range, which is idempotent at ingest. That is what makes
 * this deployable without a flag day.
 *
 ********************************************************************/

'use strict';

const coins = require('../coins/index.js');

// Time from a window closing (its last round plus the straggler grace) to the
// batch being READABLE on chain: assembly, the co-signing round, the broadcast,
// and one DOGE confirmation plus indexing. Measured at ~180s on public testnet
// 2026-09-01 (windows closing at :55 landed at ~:58); 300s is that with headroom,
// and it is the only term here an operator has any reason to retune, so it is a
// knob rather than a constant.
const DEFAULT_BATCH_LANDING_RESERVE_MS = 300000;

// The window size the rail shipped with before the ceiling existed. Used ONLY
// when the staleness bound cannot be resolved at all, so behaviour is unchanged
// on a build whose coin registry is unreadable rather than silently retuned by a
// lookup failure.
const LEGACY_BATCH_WINDOW_ROUNDS = 6;

/**
 * Peak age, at the moment just before the next batch lands, of the freshest
 * price snapshot a chain reader can see under this window.
 *
 * @param {number} windowRounds rounds per published batch
 * @param {{roundIntervalMs:number, graceMs:number, landingReserveMs:number}} opts
 * @returns {number|null} milliseconds, or null when any input is unusable
 */
function worstCaseSnapshotAgeMs(windowRounds, opts) {
    opts = opts || {};
    let k        = Number(windowRounds);
    let interval = Number(opts.roundIntervalMs);
    let grace    = Number(opts.graceMs);
    let reserve  = Number(opts.landingReserveMs);
    if (!Number.isFinite(k) || k <= 0)              return null;
    if (!Number.isFinite(interval) || interval <= 0) return null;
    if (!Number.isFinite(grace) || grace < 0)        return null;
    if (!Number.isFinite(reserve) || reserve < 0)    return null;
    return (k * interval) + grace + reserve;
}

/**
 * The largest window whose sawtooth peak still fits the staleness bound.
 *
 * @param {{maxPriceAgeMs:number, roundIntervalMs:number, graceMs:number,
 *          landingReserveMs:number}} opts
 * @returns {{ceiling:number|null, budgetMs:number|null, satisfiable:boolean}}
 *   `ceiling` null means no bound could be derived (the caller keeps its own
 *   default and clamps nothing). `satisfiable` false means even a one-round
 *   window overruns the bound, so the ceiling returned is the floor value 1 and
 *   the deployment needs a shorter round interval or a smaller grace: publishing
 *   more often cannot help below one round per wire.
 */
function maxBatchWindowRounds(opts) {
    opts = opts || {};
    let maxAge   = Number(opts.maxPriceAgeMs);
    let interval = Number(opts.roundIntervalMs);
    let grace    = Number(opts.graceMs);
    let reserve  = Number(opts.landingReserveMs);
    let unbounded = { ceiling: null, budgetMs: null, satisfiable: true };

    // A non-positive or unresolvable bound is the indexer's own "staleness gate
    // disabled" state (regtest sets 0 to turn it off). Nothing to fit inside.
    if (!Number.isFinite(maxAge) || maxAge <= 0)      return unbounded;
    if (!Number.isFinite(interval) || interval <= 0)  return unbounded;
    if (!Number.isFinite(grace) || grace < 0)         return unbounded;
    if (!Number.isFinite(reserve) || reserve < 0)     return unbounded;

    let budget  = maxAge - grace - reserve;
    let ceiling = Math.floor(budget / interval);
    if (ceiling < 1) return { ceiling: 1, budgetMs: budget, satisfiable: false };
    return { ceiling: ceiling, budgetMs: budget, satisfiable: true };
}

/**
 * The consensus-pinned fee-price staleness bound, in milliseconds, from the
 * canonical coin registry. Never read from env: the key is content-hashed into
 * CONSENSUS_CONFIG_PIN and the indexer reads only the pinned bundle, so an env
 * value here would size the window against a bound no node enforces
 * (XChainHub._oracleMaxAgeSeconds says the same thing for its own quotes).
 *
 * The TIGHTEST bound in the registry wins, not the landing chain's. One batch rail
 * feeds every chain's fee gate: the wire lands on DOGE, but the snapshots it carries
 * are what an LTC action is priced against too, and each chain judges the age with
 * its OWN ORACLE_MAX_PRICE_AGE_SECONDS. Sizing the window against DOGE alone would
 * therefore re-open the cadence question on any chain the registry ever gives a shorter bound
 * to: the rail would look correctly sized while the strictest gate kept failing. The
 * values are equal at 1800s on every network today, so this changes no deployment; it
 * removes the way a one-line registry edit could silently un-fix this.
 *
 * Falls back to the landing chain and then to the same BTC candidates
 * XChainHub._registryOracleMaxAge uses, so an unknown network still resolves rather
 * than leaving the rail unbounded.
 *
 * @param {string} network 'mainnet' | 'testnet' | 'regtest'
 * @returns {number|null} milliseconds, or null when the registry is unreadable
 */
function pinnedMaxPriceAgeMs(network) {
    let net = network || 'mainnet';
    let tightest = null;
    for (let tick of (coins.ALLOWED_COINS || [])) {
        try {
            let cfg = coins.getCoinConfig(tick, net);
            let age = Number(cfg && cfg.ORACLE_MAX_PRICE_AGE_SECONDS);
            if (!Number.isFinite(age) || age <= 0) continue;
            if (tightest === null || age < tightest) tightest = age;
        } catch (e) { /* this tick is not configured on this network; the others still count */ }
    }
    if (tightest !== null) return tightest * 1000;

    // Nothing resolved on this network (an unknown network name, most likely).
    let candidates = [['DOGE', net], ['BTC', net], ['BTC', 'mainnet']];
    for (let [tick, n] of candidates) {
        try {
            let cfg = coins.getCoinConfig(tick, n);
            let age = Number(cfg && cfg.ORACLE_MAX_PRICE_AGE_SECONDS);
            if (Number.isFinite(age) && age > 0) return age * 1000;
        } catch (e) { /* non-registry tick or unknown network; try the next candidate */ }
    }
    return null;
}

module.exports = { worstCaseSnapshotAgeMs, maxBatchWindowRounds, pinnedMaxPriceAgeMs,
                   DEFAULT_BATCH_LANDING_RESERVE_MS, LEGACY_BATCH_WINDOW_ROUNDS };
