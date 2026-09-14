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
 * XChain Hub - Oracle Consensus: the co-sign gate
 *
 * What a follower checks before it signs a leader price: the hard bound, the canonical
 * pair whitelist, the deviation band against this hub own aggregate or the last
 * finalized price, and the coverage check for a pair the proposer suppressed.
 *
 ********************************************************************/

'use strict';

const { PRICE_MAX, ORACLE_DEVIATION_THRESHOLD, ORACLE_MAX_CHANGE_PER_ROUND } = require('../../constants.js');
const bcmath            = require('../../bcmath.js');
const devband           = require('../../lib/deviation_band.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Exclude the PROPOSER's own submission from the deviation reference: a
// Byzantine leader/fallback must not be its own co-sign reference. With its
// gossiped submission in the reference, a pair only IT submitted (in our local
// view) self-validates at deviation 0, letting it inject any (0, PRICE_MAX)
// price for pairs we did not independently fetch. Excluding it makes such a
// pair fall through to the historical-snapshot bound below.
// Resolve the proposer's verified pubkey and exclude EVERY addr bound to
// it, not just envelope.sender: the registry may bind one key to several
// addrs (see addrForPubkey / leaderSubmissionAddr), so a leader can gossip
// its submission from addr A and PROPOSE from addr B. An addr-only exclusion
// would leave A's price in the reference and let the pair self-validate at
// deviation 0. Mirror leaderSubmissionAddr's pubkey resolution; keep the
// raw-addr guard as a belt-and-suspenders fallback for unknown-pubkey addrs.
function proposerExcludedAggregate(envelope, submissions) {
    let refSubs = new Map();
    let proposerPk = this.resolveSenderPubkey(envelope.sender);
    if (submissions) for (let [addr, sub] of submissions) {
        if (addr === envelope.sender) continue;
        let pk = (sub && sub.pubkey) ? String(sub.pubkey).toLowerCase() : this.resolveSenderPubkey(addr);
        if (proposerPk && pk === proposerPk) continue;
        refSubs.set(addr, sub);
    }
    let localByPair  = new Map((this._aggregateAll(refSubs) || []).map(a => [a.coinPair, a.price]));
    return localByPair;
}

// Canonical mean-relative band (shared deviation_band helper):
// deviation = |local - proposed| / proposed, i.e. the follower's own
// aggregate measured against the PROPOSED price as reference, the same
// reference orientation as the publish-side 2-source gate ((hi-lo)/(hi+lo)
// = each submitter vs the mean) and SlashDetector (submission vs the
// finalized price). Dividing by `local` instead (the previous approach) opened a
// ratio window r in (1.10, 1.10526] at the 5% band where the leader
// publishes a 2-source pair the follower then withholds the whole round
// over, with no durable record. CONSENSUS-CRITICAL: deploy fleet-wide
// atomically.
// Branch on the shared exceedsBand() comparator, not a locally
// written bcgt: the band boundary (strict >, and the threshold's
// string coercion) is then one definition shared with the slash
// gate, so it cannot be edited on one side of the accept/slash pair
// and not the other. deviation is recomputed inside the branch for
// the pct/metadata only, which keeps the co-sign path at exactly one
// computation and costs a second bcdiv solely on a reject.
function localDeviationRejected(p, local, devThreshold, reject) {
    if (devband.exceedsBand(local, p.price, devThreshold, 18)) {
        let deviation = devband.deviationFrom(local, p.price, 18);
        let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
        reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
            '% from local ' + local + ' (> ' + (devThreshold * 100) + '%)',
            { reason: 'deviation', proposed: String(p.price), local: String(local), deviation: bcmath.bcformat(deviation, 18) });
        return true;
    }
    return false;
}

// The wider historical band for a pair this hub did not price locally, computed with the
// clamp's own arithmetic so a maximally clamped aggregate passes by construction.
function historicalBandRejected(p, lastPrice, reject) {
    // Shared deviation_band helper; reference = last finalized
    // price, already the canonical orientation here (behavior-preserving).
    let deviation = devband.deviationFrom(p.price, lastPrice, 18);
    // Use a wider band than the live-submission check to allow for
    // genuine price movement between rounds, while still bounding a Byzantine
    // leader from injecting values that are orders of magnitude off. The band
    // is ORACLE_MAX_CHANGE_PER_ROUND, which is what the aggregation clamp
    // (clampToLastFinalized) emits for every pair EXCEPT those carrying a
    // tighter per-pair override (maxChangeForPair; XCHAIN/USD is at 10%).
    //
    // Deliberately NOT maxChangeForPair() here, and this asymmetry is
    // load-bearing. The gate must never be tighter than the clamp, so it
    // holds at the GLOBAL maximum: that keeps it a superset of every
    // per-pair clamp, and for an overridden pair being merely permissive
    // costs nothing (no honest leader can propose a move the clamp did not
    // bound, and a follower that DID submit locally is checked against its
    // own value by the much tighter ORACLE_DEVIATION_THRESHOLD above).
    //
    // Bound with the CLAMP'S OWN arithmetic rather than the 18dp deviation
    // ratio. Holding the same threshold was not enough: the clamp takes an
    // 8dp ROUND_HALF_UP delta off the last price, so whenever last*pct
    // rounds up (last='0.11111111' -> maxDelta '0.02777778' -> hi
    // '0.13888889' -> ratio 0.2500000225) the maximally-clamped aggregate
    // landed a hair over the ratio line and every honest follower without a
    // local submission rejected it - wedging the round the clamp was
    // protecting, exactly on the fat-tail move it exists for (item 4940).
    // Recomputing hi/lo with the identical bcmul/bcadd/bcsub at scale 8
    // makes a clamped price pass by construction, at the same threshold, for
    // every pair. `deviation` above is kept for the reject message/metadata.
    // CONSENSUS-CRITICAL: deploy fleet-wide atomically.
    let histDelta = bcmath.bcmul(lastPrice, String(ORACLE_MAX_CHANGE_PER_ROUND), 8);
    let histHi    = bcmath.bcadd(lastPrice, histDelta, 8);
    let histLo    = bcmath.bcsub(lastPrice, histDelta, 8);
    if (bcmath.bcgt(p.price, histHi) || bcmath.bclt(p.price, histLo)) {
        let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
        reject(p.coinPair, 'proposed ' + p.price + ' deviates ' + pct +
            '% from last finalized ' + lastPrice + ' (no local submission, threshold ' + (ORACLE_MAX_CHANGE_PER_ROUND * 100) + '%)',
            { reason: 'historical-deviation', proposed: String(p.price), lastFinalized: String(lastPrice), deviation: bcmath.bcformat(deviation, 18) });
        return true;
    }
    return false;
}

// A pair with no live local aggregate: judged against the last finalized price, or
// withheld outright when this hub can verify it against nothing.
function historicalRejected(p, reject) {
    // No live local submission for this pair. Apply a tighter sanity check
    // against the most recent finalized snapshot price when available, so a
    // Byzantine leader cannot inject any (0, PRICE_MAX) value for pairs that
    // quorum co-signers happened to not fetch in this round.
    let lastPrice = this.getLastFinalizedPrice(p.coinPair);
    if (lastPrice !== null && bcmath.bcgt(lastPrice, '0')) {
        return historicalBandRejected(p, lastPrice, reject);
    } else if (!this.allowUnverifiedPairs) {
        // No live local aggregate AND no finalized history means
        // this follower can verify the value against nothing; only the
        // (0, PRICE_MAX) clamp would apply. Withhold co-sign (same
        // fail-safe path as a deviation disagreement) so a Byzantine
        // leader who is the sole submitter for a brand-new pair cannot
        // get an arbitrary value quorum co-signed. The pair finalizes
        // once at least one co-signer prices it locally (next fetch
        // cycle); ORACLE_ALLOW_UNVERIFIED_PAIRS=true restores the old
        // clamp-only leniency for deliberate single-fetcher setups.
        reject(p.coinPair, 'proposed ' + p.price + ' is unverifiable: no local submission and no finalized history',
            { reason: 'unverifiable-new-pair', proposed: String(p.price) });
        return true;
    }
    return false;
}

// One proposed pair against the co-sign bounds: true when the round must be withheld.
function priceRejected(p, localByPair, canonicalPairs, devThreshold, reject) {
    let val = parseFloat(p.price);
    if (!(Number.isFinite(val) && val > 0 && val < PRICE_MAX)) {
        reject(p.coinPair, 'price ' + p.price + ' outside (0, PRICE_MAX)',
            { reason: 'out-of-range', proposed: String(p.price) });
        return true;
    }
    // Canonical-pair membership: withhold co-sign on any pair ingest would
    // have dropped, closing the fabricated-pair injection path (same fail-safe
    // withhold path as a deviation disagreement). Skipped when the whitelist is
    // empty/absent so a stale source cannot freeze honest followers.
    if (canonicalPairs && !canonicalPairs.has(p.coinPair)) {
        reject(p.coinPair, 'pair not in canonical whitelist',
            { reason: 'non-canonical-pair', proposed: String(p.price) });
        return true;
    }
    let local = localByPair.get(p.coinPair);
    if (local !== undefined && local !== null && bcmath.bcgt(local, '0')) {
        return localDeviationRejected(p, local, devThreshold, reject);
    }
    return historicalRejected.call(this, p, reject);
}

// Coverage check. The per-price loop above only bounds the pairs the
// proposer chose to INCLUDE; it never checks for pairs the proposer
// dropped. Withhold co-sign (same fail-safe path as a deviation
// disagreement) so a pair a Byzantine leader SUPPRESSED can't silently
// freeze consumers on the prior snapshot for the round window.
function coverageRejects(prices, submissions, localByPair, reject) {
    if (!Array.isArray(prices) || prices.length === 0) {
        reject('(all)', 'empty or malformed price set', { reason: 'empty-proposal' });
        return true;
    }
    let proposedPairs = new Set(prices.map(p => p && p.coinPair));
    // Reproduce the LEADER's aggregation before demanding coverage. An honest
    // leader aggregates the full member submission set, so a pair its
    // `_aggregate` legitimately returned null for (the exactly-2-source
    // deviation gate, an emptied trim) is honestly absent from the proposal.
    // `localByPair` is the proposer-EXCLUDED reference, correct for the value
    // checks above and wrong here: a pair submitted by the leader plus exactly
    // one other hub looks single-source in that view, never reaches the
    // 2-source gate, and tripped this loop on every honest round the two feeds
    // disagreed - withholding all 36+ pairs and leaving no snapshot at all
    // (item 4939). Demand coverage only where BOTH views price the pair, which
    // is the suppression case and a strict subset of the old condition.
    let leaderByPair = new Set((this._aggregateAll(submissions) || []).map(a => a && a.coinPair));
    for (let coinPair of localByPair.keys()) {
        if (!leaderByPair.has(coinPair)) continue;
        if (!proposedPairs.has(coinPair)) {
            reject(coinPair, 'priced locally but omitted from proposal', { reason: 'missing-pairs' });
            return true;
        }
    }
    return false;
}

// Content-validate the proposed prices before co-signing. Leadership rotates round-robin, so
// a Byzantine or feed-broken validator gets a leader turn; without this check honest followers
// would PREPARE/COMMIT and contribute signatures to whatever prices it proposed (the digest
// check only proves the proposer's array hashes to its own digest). Mirror CrossChainEngine's
// "never trust the proposer's claim": reject (no PREPARE/sign) any pair outside the hard
// PRICE_MAX bound, or (when this hub has its own aggregate for the pair) more than the
// federation-uniform ORACLE_DEVIATION_THRESHOLD away from it. This gate deliberately does
// NOT read the per-operator SLASH_DEVIATION_THRESHOLD (constants.js explains why: per-hub
// bands would split accept/withhold decisions at the +-band edge); SlashDetector defaults
// its slash band to the same constant and fail-fasts on a tighter override, so by default
// we never co-sign exactly what we'd be slashed for.
// Fix (seq 4083): for pairs where this hub has no local submission, also check the last
// finalized price_snapshots value if available, to narrow the acceptance window beyond the
// very loose PRICE_MAX bound. Without this a Byzantine leader can inject any price in
// (0, PRICE_MAX) for any pair that quorum co-signers did not price locally.
function coSignGateRejects(round, envelope, prices, submissions) {
    let localByPair = proposerExcludedAggregate.call(this, envelope, submissions);
    // Federation-uniform deviation band (shared constant, not per-hub config) so
    // every hub's accept/withhold boundary is identical; deviation is computed in
    // bignumber (bcmath) per the platform mandate, removing the +-band-boundary
    // float-ULP ambiguity. A reject emits oracle:propose-rejected so a feed-
    // disagreement withhold is distinguishable from a leader crash.
    let devThreshold = ORACLE_DEVIATION_THRESHOLD;
    // Canonical-pair whitelist for the co-sign gate. Ingest already drops a
    // fabricated pair (OracleRound.canonicalPairs, built from
    // PriceFetcher.getCoinPairs()), but the propose path never re-checked it:
    // a pair the leader invents has no live local aggregate and no finalized
    // history, so both deviation gates below are structurally absent and it
    // falls through with only the (0, PRICE_MAX) bound. A single Byzantine
    // round-robin leader could thus get a non-canonical pair (e.g. BTC/ZZZ)
    // quorum co-signed and finalized. Read the SAME set the ingest path uses
    // (this.oracleRound.canonicalPairs) so the two cannot drift. Fail-open on
    // an empty/absent whitelist (bootstrap / misconfig) so honest followers
    // never withhold on legitimate pairs when the source is momentarily stale.
    let canonicalPairs = (this.oracleRound &&
        this.oracleRound.canonicalPairs && this.oracleRound.canonicalPairs.size)
        ? this.oracleRound.canonicalPairs
        : null;
    let reject = (coinPair, detail, extra) => {
        logger.warn('Oracle: rejecting PROPOSE round ' + round + ' from ' + envelope.sender +
            ': ' + coinPair + ' ' + detail);
        this.emit('oracle:propose-rejected', Object.assign({ round, sender: envelope.sender, coinPair }, extra || {}));
    };
    for (let p of prices) {
        if (priceRejected.call(this, p, localByPair, canonicalPairs, devThreshold, reject)) return true;
    }
    return coverageRejects.call(this, prices, submissions, localByPair, reject);
}

module.exports = { coSignGateRejects };
