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
 * The detection passes live beside this file as prototype mixins:
 * slash_detector/deviations.js (price deviation and its 24-hour repeat window),
 * slash_detector/participation.js (the sliding missed-rounds window) and
 * slash_detector/options.js (the deviation band and its override guards).
 *
 ********************************************************************/

const crypto = require('crypto');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
const { resolveDeviationThreshold } = require('./slash_detector/options.js');
const deviationsMixin    = require('./slash_detector/deviations.js');
const participationMixin = require('./slash_detector/participation.js');

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
// (test/unit/validators/governance/slash_proposals_rpc.test.js).
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

        // Resolve the price-deviation band: ORACLE_DEVIATION_THRESHOLD unless a guarded
        // SLASH_DEVIATION_THRESHOLD override applies. It is a FLOOR checkDeviations widens in
        // a clamped round; options.js documents why a tighter or non-finite override throws.
        this.deviationThreshold = resolveDeviationThreshold(hub.p2pConfig);
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
        await this.checkDeviations(round, submissions, finalizedPrices);
        await this.checkParticipation(round, participants, allValidators);
    }

    // Returns true only when the row persisted, so callers can latch a
    // once-per-crossing offense on success and safely retry on a failed write.
    async recordSlashProposal(validatorPubkey, offenseType, round, evidence) {
        if (typeof validatorPubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(validatorPubkey)) {
            logger.warn('SlashDetector: Invalid pubkey format; skipping slash proposal');
            return false;
        }
        try {
            await this.db.createSlashProposal(validatorPubkey, offenseType, round, evidence);
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('Error recording slash proposal:', e));
            return false;
        }
    }

    resolveValidatorPubkey(addr) {
        let pm = this.hub.getPeerManager();
        if (!pm || !pm.validatorPubkeys) return null;
        return pm.validatorPubkeys.get(addr) || null;
    }

    async getPendingProposals() {
        return await this.db.findPendingSlashProposals();
    }

    async getProposalsForValidator(validatorPubkey) {
        return await this.db.findRecentSlashProposalsByValidator(validatorPubkey);
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
        // Validate and normalise here, where the domain rules live; the statement
        // itself is assembled in db/slash_proposals.js from the values that pass.
        let statusFilter = null;
        let pubkeyFilter = null;
        if (status) {
            if (!PROPOSAL_STATUSES.includes(String(status)))
                throw new Error('status must be one of: ' + PROPOSAL_STATUSES.join(', '));
            statusFilter = String(status);
        }
        if (validatorPubkey) {
            let pk = String(validatorPubkey).toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(pk))
                throw new Error('validator_pubkey must be 64 hex characters');
            pubkeyFilter = pk;
        }
        let lim = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_PAGE, 1), MAX_PAGE);
        let rows = await this.db.findSlashProposalsFiltered(statusFilter, pubkeyFilter, lim);
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
            logger.warn('SlashDetector: Invalid pubkey for attestation divergence; skipping');
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
        await this.recordSlashProposal(pk, 'attestation_divergence', pseudoRound, evidence);
    }
}

// Install each mixin non-enumerably and stubbable, as src/db/index.js does, so a moved
// method is indistinguishable from a class method to for...in, Object.keys and sinon.
// A name already on the prototype throws at load rather than overwriting silently.
function installMixins(target, mixins) {
    for (const mixin of mixins) {
        const descriptors = {};
        for (const name of Object.keys(mixin)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate SlashDetector method: ' + name + ' is already defined on ' +
                    'SlashDetector.prototype. Two slash detector mixins, or a mixin and the class, claim the same name.');
            descriptors[name] = { value: mixin[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installMixins(SlashDetector.prototype, [deviationsMixin, participationMixin]);

module.exports = Object.assign(SlashDetector, {
    // Exported so the published digest can be pinned against SlashGovernance's
    // per-row leg by test, and recomputed by any other hub-side consumer without a
    // second copy of the construction.
    hashEvidence,
    PROPOSAL_STATUSES,
    MAX_PAGE
});
