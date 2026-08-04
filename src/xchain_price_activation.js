/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * XCHAIN/USD round-composition activation gate (, spec §8 / §10 step 5).
 *
 * WHAT ACTIVATES IS ROUND COMPOSITION, nothing else. At/above the gate a
 * price-capability validator includes the derived XCHAIN/USD pair in the round it
 * submits and signs; below it, the pair is absent exactly as it is today. This is
 * consensus-visible because it changes which actions are valid on LTC and DOGE
 * (today: none that bear a fee, since the pivot pair those fees price against does
 * not exist; after: those paying a correctly-sized output).
 *
 * HUB-ONLY, AND DELIBERATELY NOT VENDORED. Nothing in indexer validation changes -
 * getFeeOraclePrices is untouched and asks for a pair that now exists - so
 * protocol_changes.js gets no entry and there is no indexer twin to keep
 * byte-identical. Indexer replay determinism needs no gate at all: getLatestPrice
 * selects historical price_snapshots rows by block/time, so replaying blocks from
 * before the pair existed reads the same absent-pair state as it always did.
 * Contrast price_pair_activation.js, which DOES have an indexer twin because the
 * on-chain PRICE v0 parser enforces the same bound.
 *
 * KEYED ON THE ROUND'S CANONICAL START INSTANT (epochStart + round x interval),
 * and this choice is load-bearing rather than incidental.
 *
 * The obvious alternative, the round's BTC reference block time, is what lands in
 * the signed payload - but at COMPOSITION time each hub has read its own chain tip,
 * and those differ. Two hubs a block apart across the gate instant would disagree
 * about whether the pair belongs in the round: one submits it, one does not. That
 * is not a benign split. The  unverifiable-pair gate withholds co-sign from
 * any follower that has neither a local submission for a pair nor finalized history
 * for it, and at the gate instant there is BY DEFINITION no finalized history, so
 * the abstaining hub withholds co-sign on the WHOLE round - all 36 pairs - and 1800
 * seconds later fee validation fails on every chain. Precisely the outage this item
 * exists to prevent, reached through the fix for it.
 *
 * The round's start instant has no such skew: ORACLE_EPOCH_START is required to be
 * federation-uniform (OracleRound throws without it, naming that requirement) and
 * the interval is a shared constant, so every hub computes bit-identically the same
 * instant for the same round number and the whole federation flips composition on
 * the same round. It is still "the round's consensus time" in the §8 sense - the
 * round NUMBER is literally derived from it - and it satisfies §8's one-key rule:
 * this is the only quantity the gate reads, with no "equivalents" a second
 * implementation could gate on instead.
 *
 * ORDERING AGAINST THE WIRE-FORMAT GATE IS A HARD INVARIANT, enforced by test.
 * PRICE_PAIR_WIDEN_ACTIVATION must fire at or before this gate on every network.
 * Reversed, a hub composes a pair the on-chain parser still rejects as malformed
 * and every round carrying it dies at ingest. §6 states the rollout as: widen the
 * format fleet-wide while nothing proposes the pair, land the derived source on
 * every hub, and only then let a leader include XCHAIN/USD.
 *
 ********************************************************************/

'use strict';

const { PRICE_PAIR_WIDEN_ACTIVATION } = require('./price_pair_activation.js');

// Per-network activation TIME, Unix seconds, matching the unit the wire-format gate
// uses so the two are directly comparable.
//
// UNARMED on mainnet: 9999999999 is a far-future sentinel (year 2286), NOT a
// scheduled flag-day. The arming instant is  D6, an open operator decision,
// and it is the same decision that arms PRICE_PAIR_WIDEN_ACTIVATION - the two are
// armed together, this one at or after that one. The usual contract-era stamp
// 1786060800 (2026-08-07) is unusable because it postdates the early-September
// launch target and would leave LTC/DOGE native-coin fees unpayable through launch.
//
// testnet/regtest are genesis-on, so the pair is composed on every test venue and
// in the suites today. §8 notes testnet is EXPECTED to be steerable (free public
// MINT plus open venues), so monitoring must not alert on testnet price excursions.
const XCHAIN_PRICE_ACTIVATION = {
    mainnet: 9999999999,  // UNARMED sentinel - see  D6
    testnet: 0,
    regtest: 0,
};

// Whether a round starting at `roundTimeSeconds` on `network` should carry the
// derived XCHAIN/USD pair.
//
// Fails CLOSED on anything it cannot evaluate: an unparseable time or an
// unrecognized network yields false, i.e. omit the pair. Closed is safe in this
// direction and only in this direction. Omitting the pair when it was due costs a
// round of carry-forward staleness that the next round repairs; INCLUDING it when
// it was not due puts a pair in a signed round that peers reject wholesale, taking
// the other 36 pairs down with it.
function isXchainPriceActive(roundTimeSeconds, network) {
    // Reject the empty-ish values BEFORE Number(), which maps null, '' and false to
    // a perfectly finite 0. On a genesis-on network (threshold 0) that 0 reads as
    // ACTIVE, so a missing time would silently compose the pair instead of failing
    // closed as this function promises. Same trap price_pair_activation.js documents.
    if (roundTimeSeconds === null || roundTimeSeconds === undefined ||
        roundTimeSeconds === '' || typeof roundTimeSeconds === 'boolean') return false;
    let t = Number(roundTimeSeconds);
    if (!Number.isFinite(t)) return false;
    let threshold = XCHAIN_PRICE_ACTIVATION[network];
    if (threshold === undefined) return false;
    return t >= threshold;
}

// The canonical start instant of `round`, in Unix seconds: the quantity the gate is
// keyed on. Pure and federation-uniform given the shared epoch and interval, which
// is the whole reason the gate reads this rather than a locally-observed chain tip.
//
// Returns null when either input is unusable, which the caller must treat as "do not
// compose the pair" rather than as a zero.
function roundStartSeconds(round, epochStartMs, roundIntervalMs) {
    if (!Number.isInteger(round) || round < 0) return null;
    // COERCE, do not type-check. OracleRound takes ORACLE_ROUND_INTERVAL straight
    // from config without parsing, so in a real deployment it arrives as the STRING
    // '600000' and Number.isFinite('600000') is false. A strict type check here
    // therefore returned null for every hub with a configured interval and silently
    // held the gate shut on every network - which reads as correct on mainnet (also
    // shut) and is why this needs a genesis-on network to catch.
    //
    // Number() is safe for the empty-ish values that matter: '' and null both map to
    // 0, and an interval of 0 is rejected below, so neither can produce a bogus
    // instant. Booleans are excluded outright - Number(true) is 1, a plausible-looking
    // interval that is certainly a caller error.
    if (typeof epochStartMs === 'boolean' || typeof roundIntervalMs === 'boolean') return null;
    let epoch    = Number(epochStartMs);
    let interval = Number(roundIntervalMs);
    if (!Number.isFinite(epoch) || !Number.isFinite(interval)) return null;
    if (interval <= 0) return null;
    return Math.floor((epoch + round * interval) / 1000);
}

// The rollout ordering invariant, exported so it can be asserted rather than merely
// commented: the wire format must widen at or before composition starts on every
// network. True today and must stay true through D6 arming.
function widenPrecedesComposition() {
    return Object.keys(XCHAIN_PRICE_ACTIVATION).every((net) => {
        let widen = PRICE_PAIR_WIDEN_ACTIVATION[net];
        let compose = XCHAIN_PRICE_ACTIVATION[net];
        return widen !== undefined && compose !== undefined && widen <= compose;
    });
}

module.exports = {
    XCHAIN_PRICE_ACTIVATION,
    isXchainPriceActive,
    roundStartSeconds,
    widenPrecedesComposition,
};
