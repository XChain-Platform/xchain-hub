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
 * XChain Hub - PBFT Consensus Engine: view change
 *
 * Leader failover: VIEW_CHANGE tallying, NEW_VIEW adoption, and the initiator
 * that starts a view change when a round times out.
 *
 * src/consensus/pbft.js installs every method below on Consensus.prototype,
 * non-enumerable like the class's own methods, so callers, stubs and the e2e
 * harness keep reaching them as consensus.<method>().
 *
 ********************************************************************/

'use strict';

const { PBFT_VIEW_CHANGE, PBFT_NEW_VIEW } = require('./message_types.js');
const { noteDrop } = require('../diagnostics');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Resolve the round-locked quorum CONTEXT (count vs stake), matching
// checkPrepareQuorum/checkCommitQuorum so view-change acceptance can't
// diverge from the rest of the round under validator churn. Followers
// still hold the proposal; the node that initiated the view change
// recovers the context from viewChangeQuorums (its proposal was removed by
// the triggering timeout). A live count quorum is the last-resort fallback.
function viewChangeContext(self, seq) {
    let proposal = self.pendingProposals.get(seq);
    if (proposal && typeof proposal.quorum === 'number') {
        return { quorum: proposal.quorum, weighted: !!proposal.weighted, validators: proposal.validators || [],
                 memberPubkeys: proposal.memberPubkeys || null };
    }
    if (self.viewChangeQuorums.has(seq)) return self.viewChangeQuorums.get(seq);
    return { quorum: self.getQuorum(), weighted: false, validators: [], memberPubkeys: null };
}

// A view change that reached quorum: adopt the view, announce NEW_VIEW when this
// hub is the new leader, and drop the tallies the advance has made unreachable.
function acceptViewChange(self, view, seq, vcCtx) {
    // View change accepted; update view and check if we're the new leader.
    // The new leader comes from the round's pinned population,
    // the same one PRE_PREPARE was validated against, so a view change
    // cannot hand the round to a node the rest of the federation would
    // not recognize as leader.
    self.view = view;
    let newLeader = self.getLeader(seq, vcCtx.memberPubkeys || null);
    if (self.isLeaderIdentity(newLeader, self.peerManager.validatorAddr, self.selfPubkey())) {
        logger.info('PBFT: View change to view ' + view + '; this node is the new leader');
        self.peerManager.broadcast(PBFT_NEW_VIEW, { view: view, seq: seq });
    }
    self.pendingViewChanges.delete(view);
    self.pendingViewChangePubkeys.delete(view);
    self.viewChangeQuorums.delete(seq);

    // Prune sub-quorum entries for any view we've now advanced past.
    // A view-change round that never reached quorum (e.g. only one peer
    // timed out while the rest stayed healthy) otherwise leaves its Set
    // in pendingViewChanges forever; under a flapping network those
    // stale entries accumulate without bound. Views are monotonic, so
    // anything strictly below the new view can never gather more votes.
    // Mirrors the viewChangeQuorums prune in initiateViewChange.
    for (let v of self.pendingViewChanges.keys()) {
        if (v < self.view) self.pendingViewChanges.delete(v);
    }
    for (let v of self.pendingViewChangePubkeys.keys()) {
        if (v < self.view) self.pendingViewChangePubkeys.delete(v);
    }
}

// Max views ahead of the local view that an inbound VIEW_CHANGE may name. Bounds
// pendingViewChanges to at most this many live buckets so a Byzantine validator
// cannot seed unbounded entries with ever-increasing view numbers. Leader failover
// only ever advances the view a handful of steps, so this clears real churn easily.
const MAX_VIEW_SKEW = 100;

module.exports = {

    handleViewChange(envelope) {
        let { view, seq } = envelope.data;
        if (typeof view !== 'number' || typeof seq !== 'number') return;

        // A VIEW_CHANGE must never rewind the view. Without this, a quorum of votes
        // for a view LOWER than the local one rewinds this.view, changing leader
        // election (seq+view)%N and desyncing rotation across the federation during
        // ordinary partition recovery. The bound is STRICT less-than, not <=: a node
        // that initiated a view change advances this.view to the target and then
        // collects inbound votes FOR that same view, so votes where view == this.view
        // are legitimate and must still be counted. The forward-skew cap bounds
        // pendingViewChanges to at most MAX_VIEW_SKEW live buckets, so a Byzantine
        // validator cannot seed unbounded entries with ever-increasing view numbers.
        if (view < this.view || view > this.view + MAX_VIEW_SKEW) return;

        // Only count VIEW_CHANGE votes from registered validators; view-change
        // quorum is the same Set.size tally as PREPARE/COMMIT.
        if (!this.isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'view_change', sender: envelope.sender, envelope });
            return;
        }

        if (!this.pendingViewChanges.has(view)) {
            this.pendingViewChanges.set(view, new Set());
        }
        this.pendingViewChanges.get(view).add(envelope.sender);

        let vcCtx = viewChangeContext(this, seq);
        if (vcCtx.quorum === 0) return;

        // View-change votes are tallied by SIGNING KEY in both quorum modes, for the
        // same reason PREPARE/COMMIT are: an addr-keyed count would let one key force
        // a view change by naming several, and would not count a chain-attributed
        // validator at all.
        if (!this.pendingViewChangePubkeys.has(view))
            this.pendingViewChangePubkeys.set(view, new Set());
        let vcPk = this.resolveSenderPubkey(envelope);
        if (vcPk) this.pendingViewChangePubkeys.get(view).add(vcPk);

        if (this.quorumMet(vcCtx, this.pendingViewChanges.get(view), this.pendingViewChangePubkeys.get(view)))
            acceptViewChange(this, view, seq, vcCtx);
    },

    // Handle NEW_VIEW: adopt a new leader's view, but only when the
    // announcement is authentic. Two guards close a liveness attack in which
    // any authenticated-but-not-leader validator could otherwise advance every
    // follower's view arbitrarily and thereby steer (seq + view) % N leader
    // election toward a node of its choosing (itself or a crashed peer):
    //
    //   1. Monotonicity: a NEW_VIEW may only move the view FORWARD, never
    //      rewind it to a lower view the announcer controls.
    //   2. Leader identity: the announcer must be the rotation-designated
    //      leader for the CLAIMED (seq, view), mirroring the isRealLeader
    //      check OracleConsensus applies to its PROPOSE handler. A Byzantine
    //      node can therefore only ever announce views in which it is already
    //      the legitimate leader; it can never point followers at another node.
    //
    // The 2f+1 VIEW_CHANGE quorum that authorizes the transition is enforced
    // on the broadcasting side (handleViewChange emits NEW_VIEW only after
    // collecting quorum). NEW_VIEW envelopes carry no vote proofs, and a
    // lagging follower that missed the VIEW_CHANGE round legitimately relies on
    // the leader's announcement to catch up, so the quorum is not (and, given
    // the wire format, cannot be) re-verified here.
    handleNewView(envelope) {
        let { view, seq } = envelope.data;
        if (typeof view !== 'number' || typeof seq !== 'number') return;

        // A NEW_VIEW must advance the view, never rewind it.
        if (view <= this.view) return;

        // Validate the announcer against the claimed view's designated leader,
        // evaluated at the CLAIMED view rather than the local one. With no
        // leader to validate against, the announcement is rejected.
        //
        // This is the deliberately partial half: a NEW_VIEW envelope carries no
        // block height, so this handler cannot lock a snapshot of its own and
        // cannot be pinned the way the other sites are. It does the best it can
        // and reuses the round's pinned population when this hub still holds it
        // (a pending proposal for `seq`, or the view-change context the
        // initiator stashed), because handleViewChange now elects the new
        // leader from exactly that set: without this, the pinned leader's own
        // NEW_VIEW would be rejected by every peer still checking the live set,
        // turning the fix into a liveness stall. When neither survives, the live
        // set is used, unchanged from before. That residual window (a hub with
        // no round context for `seq`, whose live set has drifted from the
        // block-locked staker set) is the divergence the operator accepted on
        // 2026-08-11 when ruling this fix landable as a partial one.
        let memberPubkeys = this.memberPubkeysForSeq(seq);
        let expectedLeader = this.leaderAt(seq, view, memberPubkeys);
        if (!expectedLeader ||
            !this.isLeaderIdentity(expectedLeader, envelope.sender, this.resolveSenderPubkey(envelope))) {
            logger.warn('PBFT: Ignoring NEW_VIEW for view ' + view +
                ' from non-leader ' + envelope.sender);
            return;
        }

        this.view = view;
        logger.info('PBFT: New view ' + view + ' announced by ' + envelope.sender);
    },

    // Initiate a view change (called when leader times out). The weighted context
    // (lockedWeighted + lockedValidators) is captured by the caller BEFORE the
    // proposal is deleted, so the stake-weighted view-change tally can run even
    // though the proposal is gone.
    initiateViewChange(seq, lockedQuorum, lockedWeighted, lockedValidators, lockedMemberPubkeys) {
        this.view++;
        logger.info('PBFT: Initiating view change to view ' + this.view + ' (seq ' + seq + ')');

        // Stash the round-locked quorum CONTEXT for this seq so handleViewChange
        // tallies view-change votes against the proposal-creation snapshot. The
        // proposal is already gone from pendingProposals (the triggering timeout
        // removed it before calling us), so this is the only place the initiator
        // can recover it. Carries weighted + validators so the weighted tally can
        // resolve. Prune rounds already applied to keep the map bounded (seq is
        // monotonic, so applied seqs never recur).
        if (typeof lockedQuorum === 'number') {
            for (let s of this.viewChangeQuorums.keys()) {
                if (s <= this.lastAppliedSeq) this.viewChangeQuorums.delete(s);
            }
            this.viewChangeQuorums.set(seq, {
                quorum:     lockedQuorum,
                weighted:   !!lockedWeighted,
                validators: lockedValidators || [],
                // The round's pinned leader-election population, so the
                // initiator (whose proposal the timeout already removed) still
                // elects the new leader from the set the round was opened over.
                memberPubkeys: lockedMemberPubkeys || null
            });
        }

        this.peerManager.broadcast(PBFT_VIEW_CHANGE, {
            view: this.view,
            seq:  seq
        });

        if (!this.pendingViewChanges.has(this.view)) {
            this.pendingViewChanges.set(this.view, new Set());
        }
        this.pendingViewChanges.get(this.view).add(this.peerManager.validatorAddr);
        if (lockedWeighted) {
            if (!this.pendingViewChangePubkeys.has(this.view))
                this.pendingViewChangePubkeys.set(this.view, new Set());
            this.addSelfPubkey(this.pendingViewChangePubkeys.get(this.view));
        }
    }
};
