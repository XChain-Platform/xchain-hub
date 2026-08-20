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
 * - Non-participation (missed-rounds rate over a sliding round window)
 *
 * Detection only: rows land as status 'pending' evidence. Enforcement is
 * governance-mediated: SlashGovernance turns a validator's pending
 * rows into a SLASH_PENALTY governance proposal and a passed vote executes
 * the penalty. On-chain stake slashing stays in the indexer.
 *
 ********************************************************************/

const crypto = require('crypto');
const { ORACLE_DEVIATION_THRESHOLD } = require('./constants');
const bcmath = require('./bcmath.js');
const devband = require('./lib/deviation_band.js');

const MAX_DEVIATIONS_PER_VALIDATOR = 1000;

// Page bound for the public read surface, matching Governance.getProposals /
// Governance.getVotes exactly (default 50, hard cap 500). The API layer's
// validateLimit only rejects a limit above 10000, so without this the RPC would
// hand out 10000 rows per call; every other list RPC the explorer reads caps
// itself server-side and this one must too.
const DEFAULT_PAGE = 50;
const MAX_PAGE     = 500;

const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'];

// Digest published in place of the verbatim `evidence` blob. SHA-256 over the
// evidence TEXT exactly as stored, so it is
// BYTE-IDENTICAL to the per-row leg of SlashGovernance.computeEvidenceHash: the
// value an outside party sees on a row is the same value that feeds the
// content-hash the electorate votes on, so anyone holding an evidence blob can
// recompute sha256(blob) and prove it is the row named here, and re-derive the
// SLASH_PENALTY parameter's aggregate hash from a published set. Canonicalizing
// (re-parse + re-serialize the JSON) would break that correspondence and depend
// on a JSON round-trip that silently rewrites number formatting, so the raw
// stored bytes are hashed. A null evidence hashes as the empty string, same as
// SlashGovernance. Cross-file drift is pinned by a parity test
// (test/unit/slashProposalsRpc.test.js).
//
// This is a REPUBLICATION control, not confidentiality: the evidence space is
// low-entropy (a fixed template with a few numeric fields), so a party who knows
// the template can brute-force it back. That is accepted, because the property
// actually needed here is independent verifiability, which a keyed/salted digest
// would destroy. What the digest does buy is that the hub's own POST surface
// cannot bulk-dump the verbatim text of accusations that nobody has adjudicated.
function hashEvidence(evidence) {
    return crypto.createHash('sha256')
        .update(String(evidence == null ? '' : evidence))
        .digest('hex');
}

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

        // Sliding window (in rounds) over which missed rounds are counted.
        // A consecutive-miss counter reset to 0 on ANY participation let a
        // validator at 1-in-30 participation evade forever;
        // counting misses over the last N rounds catches sustained low-rate
        // participation while a fully consecutive streak still fires at the
        // same round it used to. The window must be at least the threshold or
        // the offense could never fire, so a smaller override fails fast.
        this.participationWindowSize = parseInt(hub.p2pConfig.SLASH_PARTICIPATION_WINDOW || String(this.missedRoundsThreshold * 2));
        if (this.participationWindowSize < this.missedRoundsThreshold) {
            throw new Error('SLASH_PARTICIPATION_WINDOW (' + this.participationWindowSize +
                ') is below SLASH_MISSED_ROUNDS_THRESHOLD (' + this.missedRoundsThreshold +
                '): the non-participation offense could never fire. Set it >= the threshold.');
        }

        // Per-validator participation history over the sliding window:
        // Map<pubkey, { history: boolean[] (true = missed, newest last), missed: count }>
        this.participation = new Map();

        // Track deviations in 24h window: Map<pubkey, [{ round, timestamp }]>
        this.recentDeviations = new Map();

        // Latch per validator so repeated_deviation fires once per crossing
        // of the 3-in-24h threshold, not on every deviation while the window
        // stays saturated: Map<pubkey, bool>
        this.repeatedDeviationFired = new Map();

        // Latch per validator so non_participation fires once per crossing of
        // the windowed missed-rounds threshold. It is set only after the
        // proposal row persists, so a failed DB write leaves the offense
        // un-latched and it retries on the next missed round instead of being
        // lost. Re-arms only when the windowed miss count falls back below the
        // threshold (i.e. participation genuinely recovers), never on a single
        // token participation: Map<pubkey, bool>
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
                if (devband.exceedsBand(String(p.price), String(finalPriceStr), this.deviationThreshold, 18)) {
                    let deviation = devband.deviationFrom(String(p.price), String(finalPriceStr), 18);
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

        // Drop tracking state for pubkeys no longer in the known validator set
        // before recording this round (SLASH-MAP-NO-GC-1). Without this the four
        // per-validator maps kept one entry per pubkey ever seen, so a key
        // rotation leaked an entry forever over the process lifetime.
        this._gcValidatorState(allValidators);

        let participantSet = new Set(participants);

        for (let v of allValidators) {
            let entry = this.participation.get(v.pubkey);
            if (!entry) {
                entry = { history: [], missed: 0 };
                this.participation.set(v.pubkey, entry);
            }

            // Record this round's outcome in the sliding window (true = missed).
            let missedThisRound = !participantSet.has(v.pubkey);
            entry.history.push(missedThisRound);
            if (missedThisRound) entry.missed++;
            if (entry.history.length > this.participationWindowSize) {
                if (entry.history.shift()) entry.missed--;
            }

            if (entry.missed < this.missedRoundsThreshold) {
                // Windowed miss count is back under the threshold: the validator
                // is genuinely participating again, so re-arm the latch. A single
                // token participation while the window stays saturated does NOT
                // reach here (that reset was the earlier evasion this window closes).
                this.nonParticipationFired.set(v.pubkey, false);
                continue;
            }

            // Fire once per crossing at or past the threshold. `>=` plus the
            // latch keeps a single proposal per crossing while staying
            // retry-safe: an exact `===` fired only at the precise count, so
            // a DB write that failed at the threshold (errors are swallowed
            // in _recordSlashProposal) could never be retried and the offense
            // was lost. The latch is set only after the row persists.
            if (!this.nonParticipationFired.get(v.pubkey)) {
                let rate = ((entry.history.length - entry.missed) / entry.history.length).toFixed(4);
                console.warn('Slash: Validator ' + v.pubkey.substring(0, 16) +
                    '... missed ' + entry.missed + ' of the last ' + entry.history.length +
                    ' rounds (participation rate ' + rate + ')');

                // Latch optimistically BEFORE the await, then re-arm if the write
                // failed. checkRound is driven by the un-serialized round:finalized
                // listener, so two overlapping finalizations could both read the
                // latch as false during the first call's DB round-trip and record a
                // duplicate proposal. Setting the latch first closes that TOCTOU
                // window while a failed write still re-arms for a retry next round.
                this.nonParticipationFired.set(v.pubkey, true);
                let recorded = await this._recordSlashProposal(v.pubkey, 'non_participation', round,
                    JSON.stringify({
                        missedRounds: entry.missed,
                        windowRounds: entry.history.length,
                        participationRate: rate
                    })
                );
                if (!recorded) this.nonParticipationFired.set(v.pubkey, false);
            }
        }
    }

    // Bound the per-validator tracking maps to the currently-known validator set
    // so a signing-key rotation does not leak a map entry per retired pubkey for
    // the process lifetime (SLASH-MAP-NO-GC-1). A pubkey is kept if it is in this
    // round's validator set OR still in the live peer registry: a deviating
    // validator is recorded via _resolveValidatorPubkey off the registry and may
    // be known there before/without appearing in the round's `allValidators`, so
    // reconciling against the registry too never drops an active validator's
    // window. A dropped-then-returning validator simply restarts its window,
    // which only makes non-participation detection more lenient, never wrongful.
    _gcValidatorState(allValidators) {
        let live = new Set();
        for (let v of allValidators) if (v && v.pubkey) live.add(v.pubkey);
        let pm = this.hub.getPeerManager && this.hub.getPeerManager();
        if (pm && pm.validatorPubkeys) {
            for (let pk of pm.validatorPubkeys.values()) if (pk) live.add(pk);
        }
        for (let map of [this.participation, this.recentDeviations,
                         this.repeatedDeviationFired, this.nonParticipationFired]) {
            for (let key of map.keys()) if (!live.has(key)) map.delete(key);
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

    // Public read surface behind the unauthenticated `getslashproposals` RPC
    // (explorer M3.6). Three things separate it from getPendingProposals above,
    // which is an internal, all-pending, unbounded read:
    //
    //  1. ALL statuses are published, not only 'pending' (operator ruling
    //     2026-08-20, option (b)), optionally narrowed by status and/or pubkey.
    //  2. It is BOUNDED server-side (MAX_PAGE), like Governance.getProposals.
    //     The API layer's validateLimit alone would admit 10000.
    //  3. The verbatim `evidence` blob NEVER leaves this method. Rows carry
    //     evidence_hash instead (see hashEvidence). Redacting explorer-side
    //     would not be enough: the hub's own POST surface serves this same RPC
    //     to any caller, so the redaction has to happen here, before the row is
    //     returned. The output object is built field-by-field from an allowlist
    //     rather than by deleting `evidence` from the row, so a column added to
    //     slash_proposals later cannot silently start publishing itself.
    //
    // Rows are unadjudicated ACCUSATIONS until governance rules on them (see the
    // 2026-07-16 ruling recorded in SlashGovernance: these are evidence, not
    // enforcement). status is the only thing that says which, so it is always
    // present on every row and callers must render it.
    //
    // ORDER BY id DESC (not created_at) so the page order matches the
    // AUTO_INCREMENT cursor the explorer pages on; created_at is a
    // second-granularity TIMESTAMP and ties within a burst of detections.
    async getSlashProposals({ status, validatorPubkey, limit } = {}) {
        let where = [];
        let args  = [];
        if (status) {
            if (!PROPOSAL_STATUSES.includes(String(status)))
                throw new Error('status must be one of: ' + PROPOSAL_STATUSES.join(', '));
            where.push('status = ?');
            args.push(String(status));
        }
        if (validatorPubkey) {
            let pk = String(validatorPubkey).toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(pk))
                throw new Error('validator_pubkey must be 64 hex characters');
            where.push('validator_pubkey = ?');
            args.push(pk);
        }
        let lim = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_PAGE, 1), MAX_PAGE);
        let query = 'SELECT id, validator_pubkey, offense_type, round_number, evidence, status, created_at ' +
                    'FROM slash_proposals';
        if (where.length) query += ' WHERE ' + where.join(' AND ');
        query += ' ORDER BY id DESC LIMIT ' + lim;
        let rows = await this.db.doQuery(query, args);
        return (rows || []).map(r => ({
            id:               r.id,
            validator_pubkey: r.validator_pubkey,
            offense_type:     r.offense_type,
            round_number:     r.round_number,
            evidence_hash:    hashEvidence(r.evidence),
            status:           r.status,
            created_at:       r.created_at
        }));
    }

    // Record an attestation-divergence offense: a validator's PROPOSE body
    // didn't match the quorum-agreed winner. Only meaningful for providers
    // using byte_equality consensus. For judge_model providers, the winner
    // is one of many semantically-equivalent candidates and "not the winner"
    // doesn't imply "wrong". The caller filters by provider strategy.
    //
    // `requestId` is used as the round key. Evidence captures the request
    // metadata, validator's proposed body hash, and the winning body hash.
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
// Exported so the published digest can be pinned against SlashGovernance's
// per-row leg by test, and recomputed by any other hub-side consumer without a
// second copy of the construction.
module.exports.hashEvidence      = hashEvidence;
module.exports.PROPOSAL_STATUSES = PROPOSAL_STATUSES;
module.exports.MAX_PAGE          = MAX_PAGE;
