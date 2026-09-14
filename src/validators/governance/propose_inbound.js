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
 * XChain Hub - the inbound GOV_PROPOSE path, as a Governance.prototype mixin.
 *
 * What a hub does with a proposal another validator broadcast, which is mostly
 * refusing it: every gate here exists because a Byzantine peer can broadcast a raw
 * GOV_PROPOSE that never went through propose(), so each check propose() makes on
 * the proposing side is re-made here on the receiving side. A drop is silent by
 * design - the proposal is never recorded, so no later GOV_RESULT can apply it.
 *
 * The gates are separate methods rather than one long handler so each one states
 * the attack it closes next to the code that closes it; the handler is the order
 * they run in, which is unchanged.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { parseCapabilityMinStakeParam, MIN_STAKE_GOVERNANCE_DISABLED } = require('../capability_registry.js');
const { parseAttestationProviderParam } = require('../provider_registry.js');
const { noteDrop } = require('../../consensus/diagnostics');
const { COOLDOWN_DAYS, minActivationBlock } = require('./rules.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// What an inbound gate returns when the proposal must be dropped rather than
// recorded. A Symbol, because the two gates that use it also return legitimate
// values - null activation, null snapshot JSON - and a falsy sentinel would make a
// dropped proposal indistinguishable from a legal one.
const DROP = Symbol('drop the inbound proposal');

module.exports = {

    async _handlePropose(envelope) {
        let { proposalId, parameter, currentValue, proposedValue, rationale, proposerPubkey, activationBlock } = envelope.data;
        if (!proposalId || !parameter) return;

        if (!this.inboundProposalSenderAdmits(envelope, proposalId, parameter, proposerPubkey)) return;

        let activation = this.resolveInboundActivation(proposalId, parameter, activationBlock);
        if (activation === DROP) return;

        if (!this.inboundProposalBoundsHold(proposalId, parameter, currentValue, proposedValue)) return;

        // Compute voting_end LOCALLY (voting_start = NOW() + votingPeriod) rather than
        // trusting the proposer-supplied wire value (GOV-VOTINGEND-FORGE-1). votingPeriod
        // is a required federation-uniform constant, so every honest hub derives the same
        // window within gossip-delivery skew (seconds), far inside the >=60s tally margin.
        // Trusting the wire value let a single Byzantine validator broadcast a raw
        // GOV_PROPOSE with a far-future votingEnd: the row's voting_end <= NOW() never
        // matches in checkExpiredProposals, so it is never tallied and never leaves
        // 'voting', and propose() then refuses every honest proposal for that parameter
        // ('Active proposal already exists') -- permanent governance censorship of that
        // knob, repeatable across every parameter. GOV_RESULT also trusts this voting_end
        // in its early-result guard, so a forged future window blocks recovery too.
        let localVotingEnd = new Date(Date.now() + this.votingPeriod);

        let snapshotJson = this.inboundProposalSnapshotJson(envelope, proposalId, parameter);
        if (snapshotJson === DROP) return;

        if (!await this.inboundProposalCooldownClears(proposalId, parameter)) return;

        this.db.createGovernanceProposalByProposalIdAndProposerPubkey(proposalId, proposerPubkey || '', parameter, currentValue, proposedValue, rationale || '', localVotingEnd, activation, snapshotJson).catch(e => logger.error(nodeUtil.format('Governance: failed to persist inbound proposal %s:', proposalId, e)));
        // INSERT IGNORE already absorbs a duplicate proposal_id without raising, so the only
        // failures reaching here are real (dropped DB connection, deadlock, value-too-long,
        // schema drift). Logging them ties "why didn't node X vote on proposal P?" to its cause.
    },

    // The three gates that decide whether this hub will look at the proposal at all:
    // the sender is a registered validator, the declared proposer is the sender's own
    // registered key, and the parameter is not one governance may not move here. False
    // means dropped, and a drop is silent by design: nothing is recorded, so no later
    // GOV_RESULT for it can apply.
    inboundProposalSenderAdmits(envelope, proposalId, parameter, proposerPubkey) {
        // Only registered validators may seed a proposal into every hub's DB. Without
        // this gate an authenticated-but-Byzantine peer could stream unbounded distinct
        // proposalIds (unbounded governance_proposals growth on every hub, a DoS), and
        // any non-validator that slips past a null-registry window could inject
        // proposals. Mirrors the _isKnownSender gate on GOV_RESULT / GOV_VOTE.
        if (!this._isKnownSender(envelope.sender)) {
            noteDrop({ reason: 'unknown_sender', phase: 'gov_propose', sender: envelope.sender, envelope });
            return false;
        }

        // Bind the declared proposerPubkey to the authenticated sender (GOV-PROPOSER-SPOOF-1).
        // proposer_pubkey is persisted verbatim from the wire and surfaced by getProposals /
        // the explorer, so a Byzantine validator could otherwise attribute its proposal to
        // ANOTHER validator's signing key (an attribution spoof). The peer registry maps the
        // sender addr to its registered signing key; when that registry is authoritative
        // (non-empty, i.e. _isKnownSender is enforcing membership rather than in the genuine
        // pre-bootstrap lenient window) require the sender's registered pubkey to equal the
        // declared proposerPubkey, dropping a mismatch (never recorded). An empty registry
        // keeps the legacy record-as-is behaviour so bootstrap is unaffected, matching the
        // leniency of the _isKnownSender gate above. Honest proposals always pass: propose()
        // broadcasts under the proposer's own identity, so the sender's registered key IS the
        // proposerPubkey.
        let proposerRegistry = this.peerManager && this.peerManager.validatorPubkeys;
        if (proposerRegistry && proposerRegistry.size > 0) {
            let senderPk = String(proposerRegistry.get(envelope.sender) || '').toLowerCase();
            if (!senderPk || senderPk !== String(proposerPubkey || '').toLowerCase()) {
                logger.warn('Governance: dropping inbound proposal ' + proposalId + ' (' + parameter +
                    '): proposerPubkey does not bind to the sending validator (attribution spoof guard)');
                return false;
            }
        }

        // Pre-launch pin (#4352): drop a peer's CAPABILITY_*_MIN_STAKE proposal so this hub
        // never records or votes on it. With no local row, a later GOV_RESULT UPDATE matches
        // 0 rows and never emits proposal:finalized, so the threshold stays pinned.
        if (MIN_STAKE_GOVERNANCE_DISABLED && parseCapabilityMinStakeParam(parameter)) {
            logger.warn('Governance: dropping inbound CAPABILITY_*_MIN_STAKE proposal ' + proposalId +
                ' (' + parameter + '); governance MIN_STAKE changes are disabled pre-launch (#4352)');
            return false;
        }

        return true;
    },

    // The activation height to persist for this proposal: a validated number for a
    // block-anchored parameter, a peer-supplied one passed through unchecked for any
    // other, null when none rides on the wire, and DROP when the proposal must not be
    // recorded at all.
    resolveInboundActivation(proposalId, parameter, activationBlock) {
        // Persist the proposer-declared activation block for block-anchored parameters
        // (capability MIN_STAKE and ATTESTATION_PROVIDER). Every hub stores the proposer's
        // value so the anchor is federation-uniform (#3703). However, a dishonest proposer
        // could supply an already-past block or one that is far too soon, defeating the
        // safety buffer designed to ensure every hub finalizes before the change activates.
        // Re-validate the min-bound using this hub's local best-observed block height and
        // the same formula as `computeActivationBlock`. A block that passes the proposer's
        // own validation will always pass here (followers lag the leader's block height by
        // at most a few blocks, and the safety buffer is 50 blocks wide). A forged too-soon
        // block is rejected; the proposal is silently dropped so the network never records it.
        let isBlockAnchored = !!(parseCapabilityMinStakeParam(parameter) || parseAttestationProviderParam(parameter));
        let activation = null;
        if (isBlockAnchored) {
            let raw = this.hub ? this.hub._latestBlockIndex : null;
            let latest = (raw !== null && raw !== undefined) ? Number(raw) : null;
            if (activationBlock === undefined || activationBlock === null || !Number.isInteger(Number(activationBlock))) {
                // Block-anchored parameter arrived with no valid activation block; drop.
                logger.warn('Governance: dropping inbound block-anchored proposal ' + proposalId +
                    ' (' + parameter + '): missing or non-integer activation_block');
                return DROP;
            }
            let ab = Number(activationBlock);
            if (latest !== null && Number.isInteger(latest)) {
                let minAb = minActivationBlock(latest, this.votingPeriod);
                if (ab < minAb) {
                    logger.warn('Governance: dropping inbound proposal ' + proposalId +
                        ' (' + parameter + '): activation_block ' + ab + ' is below follower min ' + minAb);
                    return DROP;
                }
            } else {
                // Tipless follower: we have no observed block height to validate the
                // proposer-declared activation_block against. Persisting an unvalidated
                // activation_block could let a dishonest proposer inject a too-soon
                // activation. Drop and wait until the hub has a tip so the min-bound
                // check can run properly.
                logger.warn('Governance: dropping inbound block-anchored proposal ' + proposalId +
                    ' (' + parameter + '): cannot validate activation_block ' + ab +
                    ' without a local tip (tipless follower); will re-evaluate when tip is available');
                return DROP;
            }
            activation = ab;
        } else if (activationBlock !== undefined && activationBlock !== null && Number.isInteger(Number(activationBlock))) {
            // Non-block-anchored parameter: persist a peer-supplied activation_block if it
            // happens to be present (for forward compatibility), but do NOT enforce any min.
            activation = Number(activationBlock);
        }
        return activation;
    },

    // The follower half of the change bounds. False means dropped.
    inboundProposalBoundsHold(proposalId, parameter, currentValue, proposedValue) {
        // Re-validate the change bounds on the follower path, mirroring the
        // activation_block re-check above. propose() enforces them locally, but a
        // Byzantine peer can broadcast a raw GOV_PROPOSE that never went through
        // propose(); without this, every hub records and votes on an out-of-bounds
        // change. Drop it (never record it) so the whole federation ignores it,
        // matching the MIN_STAKE and block-anchor drops above. validateChangeBounds
        // is a no-op for non-numeric parameters, so only numeric out-of-bounds
        // proposals are affected.
        //
        // DEPLOY NOTE: enforce fleet-wide in one coordinated upgrade. During a
        // mixed-version window, fixed hubs drop an out-of-bounds Byzantine proposal
        // while unfixed hubs persist it, so the two disagree on its existence (and
        // could reach different tally outcomes). Legitimate proposals always pass
        // bounds (propose() validated them), so honest traffic never diverges.
        try {
            this.validateChangeBounds(parameter, currentValue, proposedValue);
        } catch (e) {
            logger.warn('Governance: dropping inbound proposal ' + proposalId + ' (' + parameter +
                '): change exceeds allowed bounds: ' + e.message);
            return false;
        }
        return true;
    },

    // The electorate snapshot to persist: its JSON when the proposer's snapshot matches
    // this hub's own set, null for a legacy row below the activation, and DROP once the
    // snapshot lock is active and the snapshot is missing or does not match.
    inboundProposalSnapshotJson(envelope, proposalId, parameter) {
        // R2-M2: re-validate the proposer's electorate snapshot against THIS hub's
        // own set (never trust it blind -- a Byzantine proposer would ship a
        // self-only snapshot to shrink the denominator to 1-of-1). Exact-set match
        // required, mirroring the activation_block re-validation above. Once the
        // snapshot-lock is active a proposal that omits a valid snapshot is dropped
        // (never recorded), so no unlocked proposal enters the electorate; below
        // activation an invalid/absent snapshot persists as NULL (legacy tally).
        let snap        = this.parseSnapshot(envelope.data.validatorSnapshot);
        let snapValid   = !!snap && this.snapshotMatchesLocalSet(snap);
        if (this.isSnapshotLockActive() && !snapValid) {
            logger.warn('Governance: dropping inbound proposal ' + proposalId + ' (' + parameter +
                '): snapshot-lock active but validator_snapshot is missing or does not match the local set');
            return DROP;
        }
        let snapshotJson = snapValid ? JSON.stringify(snap) : null;
        return snapshotJson;
    },

    // The follower half of the re-proposal cooldown. False means dropped; a failed read
    // returns true, which is the fail-open this gate states.
    async inboundProposalCooldownClears(proposalId, parameter) {
        // Re-enforce propose()'s re-proposal cooldown on the follower path
        // (stress-sweep #12). propose() refuses a new proposal for a parameter whose
        // most recent 'failed' proposal is still inside the COOLDOWN_DAYS window, but
        // that gate lived only on the proposing hub: a Byzantine validator that skips
        // propose() and broadcasts a raw GOV_PROPOSE could otherwise get every hub to
        // record and vote on a proposal that violates the anti-spam cooldown. Mirror
        // the same check here (same COOLDOWN_DAYS constant and the same locally-stored
        // voting_end every hub recorded from the failed round's GOV_PROPOSE), so the
        // federation drops it uniformly. Only the one-active-per-parameter uniqueness
        // guard is deliberately NOT mirrored here: two honest hubs can propose the same
        // parameter simultaneously, and dropping one needs a deterministic cross-hub
        // tie-break (else hubs diverge on which survives) -- left for a designed change.
        //
        // DEPLOY NOTE: enforce fleet-wide in one coordinated upgrade (same as the
        // change-bounds re-check above). During a mixed-version window a fixed hub
        // drops a cooled-down Byzantine proposal while an unfixed hub records it, so the
        // two disagree on its existence. Honest proposals always pass (propose() already
        // enforced the cooldown before broadcasting), so honest traffic never diverges.
        // Fail-open on a DB read error so a transient hiccup never drops an honest
        // proposal.
        try {
            let rejected = await this.db.getGovernanceProposalByParameter(parameter);
            if (rejected.length > 0) {
                let cooldownEnd = new Date(rejected[0].voting_end).getTime() + (COOLDOWN_DAYS * 86400000);
                if (Date.now() < cooldownEnd) {
                    let daysLeft = ((cooldownEnd - Date.now()) / 86400000).toFixed(1);
                    logger.warn('Governance: dropping inbound proposal ' + proposalId + ' (' + parameter +
                        '): parameter is in re-proposal cooldown (' + daysLeft + ' days remaining)');
                    return false;
                }
            }
        } catch (e) {
            logger.error(nodeUtil.format('Governance: cooldown re-check failed for inbound proposal %s (%s); proceeding (fail-open):',
                proposalId, parameter, e && e.message ? e.message : e));
        }
        return true;
    }

};
