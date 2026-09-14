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
 * XChain Hub - Oracle Consensus: the seat split
 *
 * Which seat this hub holds in an open round: the leader proposes at once, the elected
 * fallback arms a grace timer and re-elects over the submissions it can see when the
 * grace expires, and everyone else waits.
 *
 ********************************************************************/

'use strict';

const { FALLBACK_GRACE_MS } = require('./constants.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The seat this hub takes once a round is open here: leader, elected fallback, or a
// follower that only waits. Split out of finalizeRound, which calls it as its last act.
function takeSeat(round, submissions, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys) {
    let seat = { round, submissions, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys };
    let leader   = this._getLeader(round, memberPubkeys);
    let myAddr   = this.peerManager.validatorAddr;
    let isLeader = this.isLeaderIdentity(leader, myAddr, this.resolveSenderPubkey(myAddr));
    // Every return past this point is a seat, not an outcome: stamp it on the
    // watchdog entry so the abandonment record names what this hub waited on.
    if (isLeader) {
        this.noteRoundSeat(round, 'leader');
        this.proposeRound(round, submissions, false, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys)
            .catch(err => logger.error(nodeUtil.format('Oracle: proposal for round ' + round + ' failed:', err && err.message)));
        return;
    }
    // Follower path. Record when this round became ready to finalize so the
    // receiver-side leader-timeout grace in _handlePropose measures the same
    // window every other hub does.
    this.markRoundReady(round);

    let leaderSubAddr   = this.leaderSubmissionAddr(submissions, leader);
    let leaderSubmitted = leaderSubAddr != null;
    if (leaderSubmitted) {
        awaitLeaderOrFallback.call(this, seat, leader, leaderSubAddr, myAddr);
        return;
    }
    fallbackWithoutLeader.call(this, seat, myAddr);
}

// The elected fallback's grace timer: only the lowest-addr submitter other than the leader
// arms one, and it re-elects over the submission set as it stands when the grace expires.
function awaitLeaderOrFallback(seat, leader, leaderSubAddr, myAddr) {
    let { round, submissions, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys } = seat;
    // The leader has a submission on record and is expected to broadcast
    // ORACLE_PROPOSE. But a leader can gossip its submission and then
    // crash before proposing, leaving every follower waiting out the full
    // finalization window. Arm a shorter leader-timeout: if no PROPOSE has
    // populated pendingRounds by then, the lowest-addr submitter OTHER THAN
    // the (presumed-dead) leader takes over as fallback proposer. Only the
    // elected fallback arms a timer; a live leader proposes immediately, so
    // by the time this fires the round is already taken and we abort.
    let fb = [...submissions.keys()].filter(a => a !== leaderSubAddr).sort()[0];
    if (fb === myAddr) {
        this.noteRoundSeat(round, 'elected_fallback_awaiting_leader', { leader: leaderSubAddr });
        let t = setTimeout(() => {
            this.leaderTimers.delete(round);
            if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
            // Same snapshot membership filter as the election above so a
            // non-member submitter arriving during the grace cannot shift
            // the fallback election (Oracle M1).
            let subs = this.filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
            if (!subs || subs.size === 0) {
                this.noteRoundSeat(round, 'fallback_without_member_submissions', { leader: leaderSubAddr });
                return;
            }
            // Re-elect against the (possibly grown) submission set in case
            // gossip delivered more submitters during the grace.
            let fb2 = [...subs.keys()].filter(a => a !== this.leaderSubmissionAddr(subs, leader)).sort()[0];
            if (fb2 !== myAddr) {
                this.noteRoundSeat(round, 'awaiting_other_fallback', { leader: leaderSubAddr, fallback: fb2 });
                return;
            }
            this.noteRoundSeat(round, 'fallback_proposer', { leader: leaderSubAddr });
            this.proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys)
                .catch(err => logger.error(nodeUtil.format('Oracle: fallback proposal for round ' + round + ' failed:', err && err.message)));
        }, this.leaderTimeout + FALLBACK_GRACE_MS);
        // Don't let an armed grace timer keep the process alive on its own;
        // the hub stays up via its other listeners. Cleared on stop().
        if (t.unref) t.unref();
        this.leaderTimers.set(round, t);
        return;
    }
    this.noteRoundSeat(round, 'follower_awaiting_leader', { leader: leaderSubAddr, fallback: fb });
    return;
}

// The leader has no submission at all: the lowest-addr submitter proposes after a grace.
function fallbackWithoutLeader(seat, myAddr) {
    let { round, submissions, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys } = seat;
    // Leader has no submission. Lowest addr (lex) among submitters takes over.
    let fallbackAddr = [...submissions.keys()].sort()[0];
    if (fallbackAddr !== myAddr) {
        // Someone else is the fallback. Wait for their PROPOSE.
        this.noteRoundSeat(round, 'awaiting_other_fallback', { leader: null, fallback: fallbackAddr });
        return;
    }

    // I'm the fallback. Grace period in case a real-leader PROPOSE is in flight;
    // if pendingRounds gets populated during the grace, abort.
    this.noteRoundSeat(round, 'fallback_in_grace', { leader: null });
    let t = setTimeout(() => {
        this.leaderTimers.delete(round);
        if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
        // Filter to snapshot members, matching the election above (Oracle M1).
        let subs = this.filterSubmissionsToSnapshot(this.oracleRound.getSubmissions(round), memberPubkeys);
        if (!subs || subs.size === 0) {
            this.noteRoundSeat(round, 'fallback_without_member_submissions', { leader: null });
            return;
        }
        this.noteRoundSeat(round, 'fallback_proposer', { leader: null });
        this.proposeRound(round, subs, true, btcBlockHeight, btcBlockTime, snapshot, quorum, weighted, memberPubkeys)
            .catch(err => logger.error(nodeUtil.format('Oracle: fallback proposal for round ' + round + ' failed:', err && err.message)));
    }, FALLBACK_GRACE_MS);
    // Don't let this grace timer keep the process alive on its own; register
    // it so stop() can cancel it, matching the sibling timer above.
    if (t.unref) t.unref();
    this.leaderTimers.set(round, t);
}

module.exports = { takeSeat };
