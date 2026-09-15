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
 * XChain Hub - PBFT Consensus Engine: votes and quorum
 *
 * PREPARE and COMMIT handling: the early-arrival vote buffer, the prepare and
 * commit quorum checks, and the apply that follows a commit quorum.
 *
 * src/consensus/pbft.js installs every method below on Consensus.prototype,
 * non-enumerable like the class's own methods, so callers, stubs and the e2e
 * harness keep reaching them as consensus.<method>().
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { PBFT_COMMIT } = require('./message_types.js');
const { noteDrop } = require('../diagnostics');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Early-arrival buffer bounds (the config-change twin of the OracleConsensus /
// AttestationConsensus buffers, finding F7).
//
// handlePrePrepare is ASYNC (it locks the validator snapshot at the leader's
// block boundary, an out-of-process call) while handlePrepare/_handleCommit are
// synchronous and, before this buffer, dropped any vote for a seq this hub had
// not opened yet. A leader whose own stake already meets the round's threshold
// broadcasts PRE_PREPARE and COMMIT back to back, so on a busy host the COMMIT
// routinely overtakes the follower's snapshot lock and is discarded with nothing
// left to re-deliver it: the round finalizes on the leader and NO follower ever
// applies it. A stake-weighted round cannot self-heal from this loss the way a
// count round usually does, because the lost vote can be the only one heavy
// enough to carry the threshold.
//
// `seq` comes from attacker-controlled envelope data, so both dimensions are
// bounded: distinct seq keys (FIFO eviction on the oldest) and votes per seq.
// Replay goes through the normal handlers, so nothing here widens what counts as
// a vote; it only stops one being thrown away.
const EARLY_VOTE_MAX_SEQS     = 64;
const EARLY_VOTE_MAX_PER_SEQ  = 64;

module.exports = {

    // --- Early-arrival vote buffering (the config-change twin of finding F7) ---

    pruneEarlyVotes(now) {
        now = now || Date.now();
        for (let [seq, expiresAt] of this.earlyVoteTtl) {
            // Expired, or the round has since been applied and is finished.
            if (expiresAt <= now || seq <= this.lastAppliedSeq) {
                this.earlyVotes.delete(seq);
                this.earlyVoteTtl.delete(seq);
            }
        }
    },

    // Hold a vote for a round this hub has not opened yet. Callers have already
    // established that the sender is a registered validator, so nothing here
    // accepts a message the handlers would have refused; it only defers one.
    bufferEarlyVote(envelope) {
        let seq = envelope && envelope.data ? envelope.data.seq : null;
        if (!Number.isInteger(seq) || seq <= 0) return false;
        // An applied round is finished, and a replay in progress is already
        // draining this very seq; buffering either would only churn.
        if (seq <= this.lastAppliedSeq) return false;
        if (this._replayingSeq === seq) return false;

        let now = Date.now();
        this.pruneEarlyVotes(now);

        let bucket = this.earlyVotes.get(seq);
        if (!bucket) {
            // Bound the number of distinct buffered seqs (the sender picks seq).
            // Map iteration is insertion-ordered, so evict the OLDEST key first.
            while (this.earlyVotes.size >= EARLY_VOTE_MAX_SEQS) {
                let oldest = this.earlyVotes.keys().next().value;
                this.earlyVotes.delete(oldest);
                this.earlyVoteTtl.delete(oldest);
            }
            bucket = [];
            this.earlyVotes.set(seq, bucket);
        }
        if (bucket.length >= EARLY_VOTE_MAX_PER_SEQ) return false;

        bucket.push(envelope);
        this.earlyVoteTtl.set(seq, now + this.timeout);
        return true;
    },

    // Deliver the votes this hub held for `seq`, now that it has a proposal to
    // count them against. Replayed through the normal dispatch path, in arrival
    // order, with the queue removed up front so a replay cannot re-buffer.
    replayEarlyVotes(seq) {
        let bucket = this.earlyVotes.get(seq);
        if (!bucket || bucket.length === 0) return 0;
        this.earlyVotes.delete(seq);
        this.earlyVoteTtl.delete(seq);

        this._replayingSeq = seq;
        try {
            for (let env of bucket) {
                try { this._handleMessage(env); }
                catch (e) {
                    logger.error(nodeUtil.format('PBFT: error replaying a buffered vote for seq %s:', seq,
                        e && e.message ? e.message : e));
                }
            }
        } finally {
            this._replayingSeq = null;
        }
        logger.info('PBFT: replayed ' + bucket.length + ' vote(s) that arrived for seq ' + seq +
            ' before this hub opened the round');
        return bucket.length;
    },

    handlePrepare(envelope) {
        let { seq, configDigest } = envelope.data;
        if (!seq || !configDigest) return;

        // Only count PREPARE votes from registered validators.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'prepare', sender: envelope.sender, envelope });
            return;
        }

        let proposal = this.pendingProposals.get(seq);
        // No proposal yet: this hub is still locking the snapshot for a
        // PRE_PREPARE it has already received (or has yet to receive it). Hold
        // the vote rather than discard it; see EARLY_VOTE_MAX_SEQS.
        if (!proposal) { this.bufferEarlyVote(envelope); return; }

        if (configDigest !== proposal.digest) return;

        proposal.prepares.add(envelope.sender);
        if (proposal.preparePubkeys) {
            let pk = this.resolveSenderPubkey(envelope);
            if (pk) proposal.preparePubkeys.add(pk);
        }

        this.checkPrepareQuorum(seq);
    },

    checkPrepareQuorum(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (!proposal || proposal.resolved) return;

        // Use the round's locked quorum (federation snapshot at the BTC
        // block boundary), not a live recompute. This keeps every hub in
        // lockstep across the round. Weighted rounds tally signer stake.
        if (this.quorumMet(proposal, proposal.prepares, proposal.preparePubkeys)) {
            if (!proposal._commitSent) {
                proposal._commitSent = true;

                proposal.commits.add(this.peerManager.validatorAddr);
                this.addSelfPubkey(proposal.commitPubkeys);

                this.peerManager.broadcast(PBFT_COMMIT, Object.assign({
                    seq:          seq,
                    configDigest: proposal.digest
                }, this.equivVote(seq, proposal.view, proposal.digest, proposal.btcBlockHeight)));

                this.checkCommitQuorum(seq);
            }
        }
    },

    _handleCommit(envelope) {
        let { seq, configDigest } = envelope.data;
        if (!seq || !configDigest) return;

        // Only count COMMIT votes from registered validators.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'commit', sender: envelope.sender, envelope });
            return;
        }

        let proposal = this.pendingProposals.get(seq);
        // The vote that this buffer exists for: a leader heavy enough to meet the
        // round's threshold alone sends COMMIT immediately after PRE_PREPARE, so
        // it regularly overtakes the follower's snapshot lock.
        if (!proposal) { this.bufferEarlyVote(envelope); return; }

        if (configDigest !== proposal.digest) return;

        proposal.commits.add(envelope.sender);
        if (proposal.commitPubkeys) {
            let pk = this.resolveSenderPubkey(envelope);
            if (pk) proposal.commitPubkeys.add(pk);
        }

        this.checkCommitQuorum(seq);
    },

    checkCommitQuorum(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (!proposal || proposal.applied || proposal._applying) return;

        // Same quorum rule as checkPrepareQuorum; see quorumMet.
        if (this.quorumMet(proposal, proposal.commits, proposal.commitPubkeys)) {
            // Synchronous in-flight guard, distinct from the durable `applied` marker.
            // applyConfig/saveSeq are async, and `applied` is only set after they
            // resolve (deliberately, so a saveSeq failure leaves it false for retry).
            // Without this flag a second COMMIT that reaches quorum in a later event-loop
            // turn while the apply is still pending would pass the `!applied` gate and run
            // applyConfig a second time for one committed round. Harmless for today's
            // idempotent config upsert, but a hazard for any future non-idempotent apply.
            // Cleared in the catch so a failed apply can still be retried.
            proposal._applying = true;
            // proposal.applied is set AFTER both applyConfig and saveSeq succeed.
            // Setting it early (before the awaits) would silence the stale-seq gate
            // on re-entry but leave applied=true after a saveSeq failure, so the
            // config is durable but lastAppliedSeq is not advanced and the seq row
            // is never persisted. The comment at ~565 ("the proposal is NOT marked
            // applied") was the intent; this matches the code to that intent.
            this.applyConfig(proposal.config)
                .then(() => persistAppliedRound(this, proposal, seq))
                .catch((err) => unlockFailedApply(this, proposal, seq, err));
        }
    }
};

// The apply's second half, awaited by the same promise chain the inline callback
// ran in: persist the seq, then mark the round applied and answer the proposer.
async function persistAppliedRound(self, proposal, seq) {
    // Persist the sequence together with the apply: await so that a
    // failure propagates to the catch below and leaves proposal.applied
    // false. If the seq write is lost, the config rows and last_seq
    // diverge and a seq-invalidation consumer would serve stale config;
    // leaving applied=false lets the proposal be re-queued until the
    // seq persists.
    await self.saveSeq(seq);

    // Mark applied only after both steps succeed.
    proposal.applied = true;
    if (seq > self.lastAppliedSeq) self.lastAppliedSeq = seq;

    // Resolve the proposer's promise (if we initiated)
    if (!proposal.resolved && proposal.resolve) {
        proposal.resolved = true;
        if (proposal.timer) clearTimeout(proposal.timer);
        proposal.resolve(true);
    }

    self.pendingProposals.delete(seq);

    logger.info('PBFT: Config applied (seq ' + seq + ', ' +
        proposal.prepares.size + ' prepares, ' +
        proposal.commits.size + ' commits)');
}

// A failed apply or seq write, from either half of the chain above.
function unlockFailedApply(self, proposal, seq, err) {
    // proposal.applied remains false; leave the proposal in
    // pendingProposals so incoming COMMIT messages trigger a retry
    // when the DB recovers. Reject the proposer's promise if present
    // so the caller can surface the error.
    logger.error(nodeUtil.format('PBFT: Error applying config (seq %s):', seq, err.message));
    // Clear the in-flight guard so a subsequent COMMIT can retry the apply
    // when the DB recovers (proposal.applied is still false).
    proposal._applying = false;
    if (!proposal.resolved && proposal.reject) {
        proposal.resolved = true;
        if (proposal.timer) clearTimeout(proposal.timer);
        proposal.reject(err);
        self.pendingProposals.delete(seq);
    }
    // No delete when there is no reject handler (follower path): the
    // proposal stays pending so a retry can be triggered externally.
}
