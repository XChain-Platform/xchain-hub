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
 * XChain Hub - Slash Detector: price deviation, as a SlashDetector.prototype mixin.
 *
 * One price_deviation proposal per deviating validator per round, the pairs whose
 * published price the aggregation clamp moved (which widen the band that round), and
 * the 24-hour window that turns three deviations into a repeated_deviation offense.
 *
 ********************************************************************/

const bcmath = require('../../bcmath.js');
const devband = require('../../consensus/deviation_band.js');
// The per-round move bound the aggregation clamp applies, read from its one definition
// in OracleConsensus (item 5833). Requiring the module for a helper only; OracleConsensus
// does not require this file, so there is no cycle.
const { maxChangeForPair } = require('../../oracle/consensus.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

const MAX_DEVIATIONS_PER_VALIDATOR = 1000;

// The deviating pairs in one submitter's price list: one entry per pair whose submitted
// price sits outside the band in force for that pair this round. Pairs with no usable
// finalized or submitted price are skipped, never counted as deviations.
function deviatingPairsFor(detector, pubkey, prices, finalizedMap, clampedPairs, round) {
    let deviatingPairs = [];
    for (let p of prices) {
        let finalPriceStr = finalizedMap[p.coinPair];
        let finalPrice = parseFloat(finalPriceStr);
        if (!finalPrice || finalPrice === 0) continue;

        let submittedPrice = parseFloat(p.price);
        if (isNaN(submittedPrice) || submittedPrice === 0) continue;

        // Canonical mean-relative deviation via the shared deviation_band helper:
        // |submitted - finalized| / finalized at scale 18, the same
        // formula and reference orientation as the co-sign admission gate and the
        // publish-side 2-source gate in OracleConsensus. This site was already
        // reference-relative pre-helper (behavior-preserving). Exact-decimal
        // bcmath (no float ULP at the +-band boundary): both sides of the band
        // must be decided by the same exact comparison, so an exactly-threshold
        // submission is never co-signed yet slashed. Branch on the shared
        // exceedsBand() comparator rather than a locally written bcgt, so that
        // "same exact comparison" is one definition this gate and the co-sign
        // admission gate both call, not two copies that agree today. deviation
        // is recomputed inside the branch for the pct only, which costs a second
        // bcdiv solely on the rare slash path.
        //
        // Widen the band by the pair's clamp allowance in a round where the clamp
        // actually bound (item 5833). The band is measured against the CLAMPED
        // published price while submissions are raw, and the clamp is licensed to
        // move the published price up to maxChangeForPair away from the median every
        // submitter stood behind, so a genuine fat-tail move put every honest
        // submitter outside a 5% band and recorded price_deviation against the whole
        // federation. Widening only in clamped rounds keeps the band exactly as tight
        // as the co-sign gate in every normal round; the reference stays the uniform
        // published price, so evidence bodies and their hashes are unchanged.
        let band = detector.deviationThreshold;
        if (clampedPairs.has(p.coinPair)) band += maxChangeForPair(p.coinPair);
        if (devband.exceedsBand(String(p.price), String(finalPriceStr), band, 18)) {
            let deviation = devband.deviationFrom(String(p.price), String(finalPriceStr), 18);
            let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
            logger.warn('Slash: Validator ' + pubkey.substring(0, 16) + '... deviated ' +
                pct + '% on ' + p.coinPair + ' in round ' + round);

            deviatingPairs.push({
                coinPair: p.coinPair,
                submitted: submittedPrice,
                finalized: finalPrice,
                deviation: pct + '%'
            });
        }
    }
    return deviatingPairs;
}

module.exports = {

    async checkDeviations(round, submissions, finalizedPrices) {
        if (!submissions || !finalizedPrices) return;

        let finalizedMap = {};
        for (let fp of finalizedPrices) {
            finalizedMap[fp.coinPair] = fp.price;
        }

        // Pairs whose published price was CLAMPED this round get a wider band (item 5833).
        let clampedPairs = this.clampLimitedPairs(round, finalizedMap);

        // Check each validator's submission against the finalized prices.
        // The unique offense signal is (validator, round): one proposal per
        // deviating validator per round, with the deviating pairs aggregated
        // into the evidence (one row per pair flooded the table: 34 pairs ×
        // rounds × hubs, unbounded).
        for (let [sender, sub] of submissions) {
            if (!sub.prices || !Array.isArray(sub.prices)) continue;

            let pubkey = this.resolveValidatorPubkey(sender);
            if (!pubkey) continue;

            let deviatingPairs = deviatingPairsFor(this, pubkey, sub.prices, finalizedMap, clampedPairs, round);

            if (deviatingPairs.length > 0) {
                await this.recordSlashProposal(pubkey, 'price_deviation', round,
                    JSON.stringify({
                        pairCount: deviatingPairs.length,
                        pairs: deviatingPairs
                    })
                );

                // Track once per (validator, round) for the repeated-deviation check
                await this.trackDeviation(pubkey, round);
            }
        }
    },

    // The pairs whose published price for `round` sits ON a clamp bound, i.e. the pairs
    // OracleConsensus.clampToLastFinalized actually moved. Derived, not carried: no
    // field is added to round:finalized, no wire format changes and no query is issued,
    // so accusation sets and SlashGovernance evidence hashes stay byte-identical.
    //
    // The reference comes from the consensus engine's own retained clamp basis for this
    // exact round (getClampReference), which is the value the aggregate was clamped
    // against, not a re-read that could have moved since. Bounds are recomputed with the
    // clamp's own scale-8 bcmath and compared NUMERICALLY rather than by string equality,
    // so a re-formatted trailing digit cannot silently un-detect a clamp.
    //
    // Fail-soft to TODAY's behaviour: no engine, or no reference for this round, yields
    // an empty set and the band stays at this.deviationThreshold. That never slashes
    // anyone the tight band would have spared, it only fails to widen.
    clampLimitedPairs(round, finalizedMap) {
        let clamped = new Set();
        let engine  = this.hub && this.hub.oracleConsensus;
        let basis   = (engine && typeof engine.getClampReference === 'function')
            ? engine.getClampReference(round) : null;
        if (!basis) return clamped;

        for (let coinPair of Object.keys(finalizedMap || {})) {
            let published = finalizedMap[coinPair];
            if (published === null || published === undefined) continue;
            let last = basis.get(coinPair);
            if (last === null || last === undefined || !bcmath.bcgt(String(last), '0')) continue;
            let maxDelta = bcmath.bcmul(String(last), String(maxChangeForPair(coinPair)), 8);
            let hi = bcmath.bcadd(String(last), maxDelta, 8);
            let lo = bcmath.bcsub(String(last), maxDelta, 8);
            // The clamp never publishes outside [lo, hi], so "at or past a bound" is
            // "on the bound". A median landing exactly on a bound counts as clamped too:
            // that widens the band on a round the clamp would have published the same
            // price for, which is leniency, never a wrongful slash.
            if (!bcmath.bclt(String(published), hi) || !bcmath.bcgt(String(published), lo)) {
                clamped.add(coinPair);
            }
        }
        return clamped;
    },

    async trackDeviation(pubkey, round) {
        if (!this.recentDeviations.has(pubkey)) {
            this.recentDeviations.set(pubkey, []);
        }

        let deviations = this.recentDeviations.get(pubkey);
        deviations.push({ round: round, timestamp: Date.now() });

        // Prune entries older than 24 hours
        let cutoff = Date.now() - (24 * 60 * 60 * 1000);
        deviations = deviations.filter(d => d.timestamp > cutoff);

        // Enforce memory bound
        if (deviations.length > MAX_DEVIATIONS_PER_VALIDATOR) {
            deviations = deviations.slice(deviations.length - MAX_DEVIATIONS_PER_VALIDATOR);
        }

        this.recentDeviations.set(pubkey, deviations);

        // 3+ deviations in 24h → repeated deviation. Fire once per crossing
        // of the threshold (latched), not on every deviation while the window
        // stays ≥3. The latch re-arms when pruning drops the window below 3.
        if (deviations.length >= 3) {
            if (!this.repeatedDeviationFired.get(pubkey)) {
                logger.warn('Slash: Validator ' + pubkey.substring(0, 16) +
                    '... has 3+ price deviations in 24 hours');

                // Latch optimistically BEFORE the await, then re-arm on a failed write.
                // Setting it first closes the TOCTOU window: this method is now awaited
                // but overlapping deviations for the same validator would otherwise all
                // read the latch as false during the DB round-trip and each record a
                // duplicate. Re-arming on failure preserves retry-safety, the original
                // bug was a latch set before an un-awaited write that, on failure, was
                // never retried because the saturated window never re-armed it.
                this.repeatedDeviationFired.set(pubkey, true);
                let recorded = await this.recordSlashProposal(pubkey, 'repeated_deviation', round,
                    JSON.stringify({
                        deviationsIn24h: deviations.length,
                        rounds: deviations.slice(-50).map(d => d.round)
                    })
                );
                if (!recorded) this.repeatedDeviationFired.set(pubkey, false);
            }
        } else {
            this.repeatedDeviationFired.set(pubkey, false);
        }
    }
};
