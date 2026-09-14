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
 * XChain Hub - the inbound GOV_VOTE path, as a Governance.prototype mixin.
 *
 * Persisting a vote and deciding whether a gossiped one counts. A vote is
 * consensus-tally-affecting state written by a peer, so it is authenticated by its
 * OWN signature rather than by whoever relayed it, bounded by the proposal's voting
 * window, and refused outright when it carries no usable seq (GOV-VOTE-REPLAY-1).
 *
 * The sender gate lives here too, because it is the same question the vote path and
 * the result path both ask: is this sender a registered validator at all.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const ValidatorIdentity = require('../identity.js');
const { voteSigningPayload, normalizeVoteSeq } = require('./rules.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // GOV-VOTE-REPLAY-1: persist a vote, accepting it ONLY when its seq is
    // strictly greater than the seq already stored for this
    // (proposal_id, voter_pubkey). One statement rather than read-compare-write:
    // handleVote is fire-and-forget and several gossiped copies of the same
    // voter's votes can be in flight at once, so a read-then-write would leave a
    // TOCTOU window in which the loser lands last and wins. GREATEST keeps the
    // stored seq monotonic even when a superseded copy arrives late, so the
    // stale copy cannot lower the bar for the next replay.
    async upsertVote(proposalId, voterPubkey, vote, signature, seq) {
        return this.db.setGovernanceVote(proposalId, voterPubkey, vote, String(signature || ''), seq);
    },

    async handleVote(envelope) {
        let { proposalId, vote, voterPubkey, signature, seq } = envelope.data;
        if (!proposalId || !vote || !voterPubkey) return;

        // GOV-VOTE-REPLAY-1: a vote with no usable seq is refused outright rather
        // than admitted with a default. Admitting seq=0 would rebuild exactly the
        // replayable payload this fix removes, so the gossip wire format is
        // deliberately BREAKING here: a legacy peer's votes are dropped, not
        // counted. Safe to do now precisely because the mainnet validator registry
        // is empty (getvalidators returns []) and one hub runs each mainnet chain,
        // so there is no mixed-version federation to fragment. That window closes
        // as soon as external validators register.
        let voteSeq = normalizeVoteSeq(seq);
        if (!voteSeq) {
            logger.warn('Governance: dropped vote on ' + proposalId + ' from ' + voterPubkey +
                ': missing or invalid seq (a legacy peer, or a replay stripped of its seq)');
            return;
        }

        if (!this.voteIsAuthentic(proposalId, vote, voterPubkey, signature, voteSeq)) return;
        if (!await this.voteCountsOnThisProposal(proposalId, voterPubkey)) return;

        this.upsertVote(proposalId, voterPubkey, vote, signature, voteSeq)
            .catch(e => logger.error(nodeUtil.format('Governance: failed to persist inbound vote for proposal %s from %s:',
                proposalId, voterPubkey, e)));
        // A vote is consensus-tally-affecting state: a silently-dropped write here makes this
        // node's tally diverge from peers that succeeded, with no symptom until operators
        // compare counts. Log it so a tally mismatch is traceable to the specific dropped write.
    },

    // Was this vote cast by the key it claims, and is that key a validator?
    voteIsAuthentic(proposalId, vote, voterPubkey, signature, voteSeq) {
        // Authenticate the vote before persisting (consensus-tally-affecting). The
        // table is keyed by (proposal_id, voter_pubkey), so without this ONE validator
        // that passes the transport sig layer could insert a row per FABRICATED
        // voterPubkey and single-handedly meet quorum + approval on any proposal.
        // Authenticate the vote by its OWN signature (like the PBFT engines),
        // independent of the relaying sender:
        //   1. voterPubkey must be a registered validator's signing key, and
        //   2. the ed25519 signature must verify over the canonical vote payload
        //      (byte-identical to what vote() signs), proving the holder of
        //      voterPubkey cast it.
        // An attacker can therefore only ever cast one vote, under its own key -- which
        // it could do legitimately anyway. Membership is checked against validatorSet
        // (the same set the tally denominator is derived from).
        let pk = String(voterPubkey).toLowerCase();
        if (!this.validatorSet.some(v => String(v.pubkey).toLowerCase() === pk)) return false;
        let payload = voteSigningPayload(proposalId, vote, voterPubkey, voteSeq);
        if (!ValidatorIdentity.verify(payload, String(signature || ''), voterPubkey)) return false;
        return true;
    },

    // Is the proposal still open on THIS hub, and is the voter in its electorate?
    async voteCountsOnThisProposal(proposalId, voterPubkey) {
        let pk = String(voterPubkey).toLowerCase();
        // Drop a gossiped vote for a proposal that is not OPEN on this hub (GOV-LATEVOTE-1).
        // The honest vote() path already refuses a vote once voting_end has passed, but this
        // gossip-acceptance path had no such guard, so a validly-signed GOV_VOTE broadcast in
        // the window between voting_end and the leader's tally tick (<= tallyInterval) was
        // upserted and counted, letting a boundary proposal be flipped after its close.
        // Require a local status='voting' row whose voting_end is still in the future; a
        // proposal this hub never recorded (no row) is dropped rather than counted blind.
        let prows;
        try {
            prows = await this.db.getGovernanceProposalElectorateInVoting(proposalId);
        } catch (e) {
            logger.error(nodeUtil.format('Governance: failed to look up proposal for inbound vote %s:', proposalId, e && e.message ? e.message : e));
            return false;
        }
        if (!prows.length || new Date(prows[0].voting_end).getTime() < Date.now()) return false;

        // R2-M2: on a snapshot-locked proposal, only a member of the LOCKED set
        // may be counted. The validatorSet gate above admits anyone registered
        // now; a validator added after the proposal opened must not vote on it.
        let electorate = this.parseSnapshot(prows[0].validator_snapshot);
        if (electorate && !electorate.some(e => e.pubkey === pk)) return false;
        return true;
    },

    // True if `sender` is a registered validator. Mirrors OracleConsensus._isKnownSender:
    // the P2P sig layer already authenticates the sender, but a forged sender that slipped
    // past a null-registry window must not be trusted. Null registry fails closed; an empty
    // registry stays lenient ONLY until a chain-effective signer set exists
    // (genuine pre-bootstrap, where the sig layer rejects unknowns).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) {
            // Empty-registry leniency is for the genuine pre-bootstrap window ONLY
            // (G-1): once the on-chain snapshot has produced a non-empty
            // effective signer set, an empty registry is a misconfiguration or
            // wipe window, not bootstrap, and counting unattributable senders
            // would reopen count-mode quorum forgery. Fail closed instead.
            let signerSet = this.peerManager.effectiveSignerSet;
            return !(signerSet && signerSet.size > 0);
        }
        return registry.has(sender);
    }

};
