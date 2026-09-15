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
 * XChain Hub - the inbound GOV_RESULT path, as a Governance.prototype mixin.
 *
 * The federation-final outcome, applied first-writer-wins. For a snapshot-locked
 * proposal the wire status is a LIVENESS TRIGGER and never an oracle (R2-H2): this
 * hub ingests the leader's authenticated vote evidence, re-tallies locally against
 * the locked electorate and applies its own result, so a leader that ground the
 * proposal id to elect itself cannot hand followers a status they did not derive.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const ValidatorIdentity = require('../identity.js');
const { noteDrop } = require('../../consensus/diagnostics');
const { voteSigningPayload, normalizeVoteSeq, GOV_SNAPSHOT_MAX_VALIDATORS } = require('./rules.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    async handleResult(envelope) {
        let { proposalId, status } = envelope.data;
        if (!proposalId || !status) return;

        if (!this.resultComesFromTallyLeader(envelope, proposalId)) return;

        // Reject a result that arrives before the voting window closes: the legitimate leader
        // only tallies after voting_end (checkExpiredProposals), so an early result is
        // spurious. Compare the LOCALLY-stored voting_end (recorded from GOV_PROPOSE on every
        // hub); a proposal this hub never saw has no row and is dropped rather than applied
        // blind. Safe against clock skew in practice -- the timer-driven tally fires well after
        // voting_end, so a follower receiving the result is already past it too.
        let prows;
        try {
            prows = await this.db.getGovernanceProposalElectorate(proposalId);
        } catch (e) { return; }
        if (!prows.length || new Date(prows[0].voting_end).getTime() > Date.now()) return;

        let applyStatus = await this.resolveResultStatus(envelope, proposalId, status, prows[0]);
        if (applyStatus === null) return;

        // Update proposal status locally. Guard side effects on the status-transition (was 'voting')
        // so the tally leader's own loopback of this GOV_RESULT -- which already applied + emitted in
        // tallyProposal -- affects 0 rows here and does not double-emit.
        let res;
        try {
            res = await this.db.updateGovernanceProposal(applyStatus, proposalId);
        } catch (e) { return; }

        if (applyStatus === 'passed' && res && res.affectedRows > 0) await this.emitFinalized(proposalId);
    },

    // Is this GOV_RESULT from the one hub entitled to send it: a registered sender, and
    // the proposal's own deterministic tally leader?
    resultComesFromTallyLeader(envelope, proposalId) {
        // Authenticate the result. GOV_RESULT is the federation-final outcome, applied
        // first-writer-wins under the status='voting' guard below -- so it MUST come only from
        // the proposal's deterministic tally leader (the single hub that runs tallyProposal).
        // Without this, any one registered validator could broadcast a forged 'passed' that
        // every follower records while the real leader tallies the true outcome locally --
        // a permanent governance split-brain. The tally side is already leader-pinned
        // (isTallyLeader); this closes the result-ACCEPTANCE side. The leader's own loopback
        // of its broadcast still passes (sender == leader) and is absorbed by the 0-row guard.
        if (!this.isKnownSender(envelope.sender)) {
            noteDrop({ reason: 'unknown_sender', phase: 'gov_result', sender: envelope.sender, envelope });
            return false;
        }
        let leader = this.getProposalLeader(proposalId);
        if (!leader || leader.addr !== envelope.sender) return false;
        return true;
    },

    // The status to apply: the leader's wire status for a legacy row, and for a
    // snapshot-locked one this hub's OWN re-tally over the locked electorate. null when
    // the vote evidence could not be read, which leaves the row untouched.
    async resolveResultStatus(envelope, proposalId, status, prow) {
        let electorate  = this.parseSnapshot(prow.validator_snapshot);
        let applyStatus = status;
        // R2-H2: for a snapshot-locked proposal the wire `status` is a LIVENESS
        // TRIGGER, not an oracle. A validator that grinds `proposalId` (it embeds
        // Date.now()) to make itself the deterministic leader could otherwise
        // broadcast 'passed' with zero approvals and every follower would record
        // it. Instead: ingest the leader's authenticated vote evidence (recovers
        // any GOV_VOTE gossip this follower missed), re-tally LOCALLY against the
        // locked electorate, and apply the local result. Legacy (NULL-snapshot)
        // rows keep the historical apply-wire-status behaviour (re-tallying them
        // against a per-hub-divergent live set would itself fork; this is why
        // R2-M2 gates R2-H2).
        if (electorate) {
            await this.ingestResultVotes(proposalId, envelope.data.votes, electorate);
            let votes;
            try {
                votes = await this.db.findGovernanceVotes(proposalId);
            } catch (e) { return null; }
            let localResult = this.computeTally(votes, electorate).approved ? 'passed' : 'failed';
            if (localResult !== status) {
                logger.warn('Governance: GOV_RESULT status mismatch from leader ' + envelope.sender +
                    ' on ' + proposalId + ': wire=' + status + ' local=' + localResult +
                    ' (applying local re-tally)');
            }
            applyStatus = localResult;
        }
        return applyStatus;
    },

    // Emit 'proposal:finalized' for a passed proposal. Best-effort: the status is
    // already persisted, so a failed read here loses the apply, never the record.
    async emitFinalized(proposalId) {
        // A passed proposal's 'proposal:finalized' listeners (capability hot-reload, provider
        // registry) are registered on EVERY hub, but tallyProposal only runs on the deterministic
        // tally leader -- so without emitting here followers update the row yet never APPLY the
        // change, and capability thresholds (min_stake etc.) diverge federation-wide until restart.
        // Emit on the same transition + payload shape the leader uses in tallyProposal; the
        // caller has already checked that transition (a passed status that changed a row).
        try {
            let rows = await this.db.getGovernanceProposalParameterChange(proposalId);
            if (rows.length) {
                this.emit('proposal:finalized', {
                    proposalId: proposalId,
                    parameter:  rows[0].parameter,
                    oldValue:   rows[0].current_value,
                    newValue:   rows[0].proposed_value,
                    activationBlock: rows[0].activation_block
                });
            }
        } catch (e) { /* best-effort: status already persisted */ }
    },

    // R2-H2: ingest the vote evidence carried on GOV_RESULT so a follower that
    // missed some GOV_VOTE gossip can still reproduce the leader's tally. Each
    // entry is self-authenticating and independently checked (never trusted
    // because the leader relayed it): the voter must be in the locked electorate,
    // and its ed25519 signature must verify over the exact canonical payload
    // vote()/handleVote sign. Upsert is idempotent, so the leader's own loopback
    // and duplicate deliveries are harmless. A malformed/oversized `votes` array
    // is skipped (the local re-tally still runs on whatever votes we already hold).
    async ingestResultVotes(proposalId, wireVotes, electorate) {
        if (!Array.isArray(wireVotes) || wireVotes.length > GOV_SNAPSHOT_MAX_VALIDATORS) return;
        let members = new Set(electorate.map(e => e.pubkey));
        for (let v of wireVotes) {
            if (!v || typeof v.voterPubkey !== 'string' || (v.vote !== 'approve' && v.vote !== 'reject')) continue;
            let pk = v.voterPubkey.toLowerCase();
            if (!members.has(pk)) continue;
            // GOV-VOTE-REPLAY-1: same rule as the gossip path. Evidence without a
            // usable seq is skipped rather than defaulted, so a leader cannot
            // launder a replayed vote back in by stripping its seq.
            let seq = normalizeVoteSeq(v.seq);
            if (!seq) continue;
            let payload = voteSigningPayload(proposalId, v.vote, v.voterPubkey, seq);
            if (!ValidatorIdentity.verify(payload, String(v.signature || ''), v.voterPubkey)) continue;
            try {
                await this.upsertVote(proposalId, v.voterPubkey, v.vote, v.signature, seq);
            } catch (e) {
                logger.error(nodeUtil.format('Governance: failed to ingest GOV_RESULT vote evidence for %s from %s:',
                    proposalId, v.voterPubkey, e && e.message ? e.message : e));
            }
        }
    }

};
