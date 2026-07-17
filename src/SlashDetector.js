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
 * XChain Hub - Slash Detector
 *
 * Monitors validator behavior and records slash proposals for:
 * - Price deviation > threshold from consensus
 * - Repeated deviation (3+ rounds in 24 hours)
 * - Non-participation (consecutive missed rounds)
 *
 * Detection only: rows land as status 'pending' evidence. Enforcement is
 * governance-mediated : SlashGovernance turns a validator's pending
 * rows into a SLASH_PENALTY governance proposal and a passed vote executes
 * the penalty. On-chain stake slashing stays in the indexer (WI-2).
 *
 ********************************************************************/

const { ORACLE_DEVIATION_THRESHOLD } = require('./constants');
const bcmath = require('./bcmath.js');

const MAX_DEVIATIONS_PER_VALIDATOR = 1000;

class SlashDetector {

    constructor(hub) {
        this.hub = hub;
        this.db  = hub.db;

        // Price-deviation slash band. Defaults to the federation-uniform
        // ORACLE_DEVIATION_THRESHOLD (constants.js), the same band the oracle
        // co-sign gate (OracleConsensus._handlePropose) and the exactly-2-source
        // publish gate (_aggregate) enforce, so by default we never slash a
        // submission the federation just co-signed. A SLASH_DEVIATION_THRESHOLD
        // override (env / governance) is still honored, but guarded:
        //  - TIGHTER than the co-sign band would slash submitters INSIDE the
        //    co-signed band (the exact inversion of the "never sign a price we
        //    would slash" invariant), so it fails fast at construction;
        //  - LOOSER only lets some co-sign-rejected deviations go unslashed
        //    (a leniency/liveness asymmetry, not wrongful slashing), so it warns.
        this.deviationThreshold = parseFloat(hub.p2pConfig.SLASH_DEVIATION_THRESHOLD) || ORACLE_DEVIATION_THRESHOLD;
        if (this.deviationThreshold < ORACLE_DEVIATION_THRESHOLD) {
            throw new Error('SLASH_DEVIATION_THRESHOLD (' + this.deviationThreshold +
                ') is below the federation-uniform ORACLE_DEVIATION_THRESHOLD (' +
                ORACLE_DEVIATION_THRESHOLD + '): this would slash submissions inside the ' +
                'co-signed band. Remove the override or set it >= the oracle band.');
        }
        if (this.deviationThreshold !== ORACLE_DEVIATION_THRESHOLD) {
            console.warn('SlashDetector: SLASH_DEVIATION_THRESHOLD=' + this.deviationThreshold +
                ' diverges from the federation-uniform ORACLE_DEVIATION_THRESHOLD=' +
                ORACLE_DEVIATION_THRESHOLD + '; deviations between the two bands will be ' +
                'co-sign-rejected but never slashed.');
        }
        this.missedRoundsThreshold = parseInt(hub.p2pConfig.SLASH_MISSED_ROUNDS_THRESHOLD || '30');     // 30 rounds

        // Track consecutive missed rounds per validator: Map<pubkey, count>
        this.missedRounds = new Map();

        // Track deviations in 24h window: Map<pubkey, [{ round, timestamp }]>
        this.recentDeviations = new Map();

        // Latch per validator so repeated_deviation fires once per crossing
        // of the 3-in-24h threshold, not on every deviation while the window
        // stays saturated: Map<pubkey, bool>
        this.repeatedDeviationFired = new Map();

        // Latch per validator so non_participation fires once per crossing of
        // the missed-rounds threshold. It is set only after the proposal row
        // persists, so a failed DB write leaves the offense un-latched and it
        // retries on the next missed round instead of being lost. Re-arms when
        // the validator participates again: Map<pubkey, bool>
        this.nonParticipationFired = new Map();
    }

    // Check a finalized round for slashable offenses
    // submissions: Map<sender, { prices, sources, timestamp }> (from OracleRound)
    // finalizedPrices: [{ coinPair, price }] (from OracleConsensus aggregation)
    // participants: array of validator pubkeys that submitted
    // allValidators: array of { pubkey, addr } (full validator set)
    async checkRound(round, submissions, finalizedPrices, participants, allValidators) {
        await this._checkDeviations(round, submissions, finalizedPrices);
        await this._checkParticipation(round, participants, allValidators);
    }

    async _checkDeviations(round, submissions, finalizedPrices) {
        if (!submissions || !finalizedPrices) return;

        let finalizedMap = {};
        for (let fp of finalizedPrices) {
            finalizedMap[fp.coinPair] = fp.price;
        }

        // Check each validator's submission against the finalized prices.
        // The unique offense signal is (validator, round): one proposal per
        // deviating validator per round, with the deviating pairs aggregated
        // into the evidence (one row per pair flooded the table: 34 pairs ×
        // rounds × hubs, unbounded).
        for (let [sender, sub] of submissions) {
            if (!sub.prices || !Array.isArray(sub.prices)) continue;

            let pubkey = this._resolveValidatorPubkey(sender);
            if (!pubkey) continue;

            let deviatingPairs = [];
            for (let p of sub.prices) {
                let finalPriceStr = finalizedMap[p.coinPair];
                let finalPrice = parseFloat(finalPriceStr);
                if (!finalPrice || finalPrice === 0) continue;

                let submittedPrice = parseFloat(p.price);
                if (isNaN(submittedPrice) || submittedPrice === 0) continue;

                // Exact-decimal deviation, mirroring the co-sign admission band in
                // OracleConsensus._handlePropose (bcsub/bcdiv/bcgt at scale 18). Float
                // arithmetic here re-introduced ULP error at the +-band boundary, so an
                // exactly-threshold submission was co-signed yet slashed. Both sides of
                // the band must be decided by the same exact comparison.
                let diff      = bcmath.bcsub(String(p.price), String(finalPriceStr), 18);
                let absDiff   = bcmath.bclt(diff, 0) ? bcmath.bcmul(diff, '-1', 18) : diff;
                let deviation = bcmath.bcdiv(absDiff, String(finalPriceStr), 18);

                if (bcmath.bcgt(deviation, String(this.deviationThreshold))) {
                    let pct = bcmath.bcformat(bcmath.bcmul(deviation, '100', 4), 4);
                    console.warn('Slash: Validator ' + pubkey.substring(0, 16) + '... deviated ' +
                        pct + '% on ' + p.coinPair + ' in round ' + round);

                    deviatingPairs.push({
                        coinPair: p.coinPair,
                        submitted: submittedPrice,
                        finalized: finalPrice,
                        deviation: pct + '%'
                    });
                }
            }

            if (deviatingPairs.length > 0) {
                await this._recordSlashProposal(pubkey, 'price_deviation', round,
                    JSON.stringify({
                        pairCount: deviatingPairs.length,
                        pairs: deviatingPairs
                    })
                );

                // Track once per (validator, round) for the repeated-deviation check
                await this._trackDeviation(pubkey, round);
            }
        }
    }

    async _checkParticipation(round, participants, allValidators) {
        if (!allValidators || allValidators.length === 0) return;

        let participantSet = new Set(participants);

        for (let v of allValidators) {
            if (participantSet.has(v.pubkey)) {
                this.missedRounds.set(v.pubkey, 0);
                // Re-arm the latch so a fresh miss-streak can be reported again.
                this.nonParticipationFired.set(v.pubkey, false);
            } else {
                let missed = (this.missedRounds.get(v.pubkey) || 0) + 1;
                this.missedRounds.set(v.pubkey, missed);

                // Fire once per streak at or past the threshold. `>=` plus the
                // latch keeps a single proposal per crossing while staying
                // retry-safe: an exact `===` fired only at the precise count, so
                // a DB write that failed at the threshold (errors are swallowed
                // in _recordSlashProposal) could never be retried and the offense
                // was lost. The latch is set only after the row persists.
                if (missed >= this.missedRoundsThreshold && !this.nonParticipationFired.get(v.pubkey)) {
                    console.warn('Slash: Validator ' + v.pubkey.substring(0, 16) +
                        '... missed ' + missed + ' consecutive rounds');

                    // Latch optimistically BEFORE the await, then re-arm if the write
                    // failed. checkRound is driven by the un-serialized round:finalized
                    // listener, so two overlapping finalizations could both read the
                    // latch as false during the first call's DB round-trip and record a
                    // duplicate proposal. Setting the latch first closes that TOCTOU
                    // window while a failed write still re-arms for a retry next round.
                    this.nonParticipationFired.set(v.pubkey, true);
                    let recorded = await this._recordSlashProposal(v.pubkey, 'non_participation', round,
                        JSON.stringify({ missedRounds: missed })
                    );
                    if (!recorded) this.nonParticipationFired.set(v.pubkey, false);
                }
            }
        }
    }

    async _trackDeviation(pubkey, round) {
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
                console.warn('Slash: Validator ' + pubkey.substring(0, 16) +
                    '... has 3+ price deviations in 24 hours');

                // Latch optimistically BEFORE the await, then re-arm on a failed write.
                // Setting it first closes the TOCTOU window: this method is now awaited
                // but overlapping deviations for the same validator would otherwise all
                // read the latch as false during the DB round-trip and each record a
                // duplicate. Re-arming on failure preserves retry-safety, the original
                // bug was a latch set before an un-awaited write that, on failure, was
                // never retried because the saturated window never re-armed it.
                this.repeatedDeviationFired.set(pubkey, true);
                let recorded = await this._recordSlashProposal(pubkey, 'repeated_deviation', round,
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

    // Returns true only when the row persisted, so callers can latch a
    // once-per-crossing offense on success and safely retry on a failed write.
    async _recordSlashProposal(validatorPubkey, offenseType, round, evidence) {
        if (typeof validatorPubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(validatorPubkey)) {
            console.warn('SlashDetector: Invalid pubkey format; skipping slash proposal');
            return false;
        }
        let query = `INSERT INTO slash_proposals (validator_pubkey, offense_type, round_number, evidence)
                     VALUES (?, ?, ?, ?)`;
        try {
            await this.db.doQuery(query, [validatorPubkey, offenseType, round, evidence]);
            return true;
        } catch (e) {
            console.error('Error recording slash proposal:', e);
            return false;
        }
    }

    _resolveValidatorPubkey(addr) {
        let pm = this.hub.getPeerManager();
        if (!pm || !pm.validatorPubkeys) return null;
        return pm.validatorPubkeys.get(addr) || null;
    }

    async getPendingProposals() {
        let query = "SELECT * FROM slash_proposals WHERE status = 'pending' ORDER BY created_at DESC";
        return await this.db.doQuery(query);
    }

    async getProposalsForValidator(validatorPubkey) {
        let query = "SELECT * FROM slash_proposals WHERE validator_pubkey = ? ORDER BY created_at DESC LIMIT 50";
        return await this.db.doQuery(query, [validatorPubkey]);
    }

    // Record an attestation-divergence offense: a validator's PROPOSE body
    // didn't match the quorum-agreed winner. Only meaningful for providers
    // using byte_equality consensus. For judge_model providers, the winner
    // is one of many semantically-equivalent candidates and "not the winner"
    // doesn't imply "wrong". The caller filters by provider strategy.
    //
    // `requestId` is used as the round key. Evidence captures the request
    // metadata, validator's proposed body hash, and the winning body hash.
    //
    // Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md §8.3
    async recordAttestationDivergence(validatorPubkey, requestId, providerId, proposedBodyHash, winnerBodyHash){
        if(!validatorPubkey || !requestId) return;
        let pk = String(validatorPubkey).toLowerCase();
        if(!/^[0-9a-fA-F]{64}$/.test(pk)){
            console.warn('SlashDetector: Invalid pubkey for attestation divergence; skipping');
            return;
        }
        let evidence = JSON.stringify({
            requestId:        String(requestId).toLowerCase(),
            providerId:       String(providerId || ''),
            proposedBodyHash: String(proposedBodyHash || ''),
            winnerBodyHash:   String(winnerBodyHash || '')
        });
        // requestId is hex; lift the first 8 chars as a round-equivalent
        // pseudo-counter so existing slash_proposals.round_number column is
        // populated with something monotonic-ish per offense (cosmetic: the
        // unique signal is validator_pubkey + offense_type + evidence).
        let pseudoRound = parseInt(String(requestId).substring(0, 8), 16) || 0;
        await this._recordSlashProposal(pk, 'attestation_divergence', pseudoRound, evidence);
    }
}

module.exports = SlashDetector;
