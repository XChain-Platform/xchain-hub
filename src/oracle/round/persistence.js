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
 * XChain Hub - Oracle Round Persistence
 *
 * Everything the round path writes to or prunes from the oracle_submissions
 * audit table, plus the stake-weight fallback that attributes a sender the
 * local registry has no row for.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Place a sender as member, non_member or unresolved at the round's block. No feed, no
// key, or a feed without the lookup keeps the original refusal (non_member).
async function stakeMembership(feed, blockIndex, senderPubkey) {
    if (!senderPubkey || !feed || typeof feed.membership !== 'function') return { status: 'non_member' };
    try {
        let status = await feed.membership('price', blockIndex, senderPubkey);
        if (status !== 'unresolved') return { status: status };
        return { status: status, reason: 'stake-weight snapshot unavailable at block ' + blockIndex };
    } catch (e) {
        return { status: 'unresolved', reason: 'stake-weight lookup failed: ' + ((e && e.message) ? e.message : e) };
    }
}

module.exports = {

    // Audit-row fallback for a sender the registry does not know. Qualifying stake at
    // the round's block boundary stands in for the missing registry row; a key the
    // resolved snapshot lacks keeps the original refusal and its remedy, while a feed
    // fault is counted and named as one. Neither writes a placeholder row.
    //
    // Async and self-catching because handleMessage is a synchronous handler: this is
    // fire-and-forget exactly like the registered-sender persist beside it, and an
    // indexer fault must cost an audit row rather than the round.
    async persistFromStakeWeight(round, envelope, prices, senderPubkey) {
        let feed = this.hub && this.hub.stakeWeightFeed;
        let placed = await stakeMembership(feed, this.currentBtcBlockHeight, senderPubkey);
        if (placed.status === 'member') {
            await this.persistStakeQualified(round, envelope.sender, prices, senderPubkey);
            return;
        }
        if (placed.status === 'unresolved') {
            this.onStakeWeightLookupFailure(round, envelope.sender, placed.reason);
            return;
        }
        logger.warn('Oracle: skipping DB persist for unregistered sender ' + envelope.sender +
            ' (call syncvalidators to register the peer)');
    },

    // Persist a stake-qualified peer's row outside the lookup, so a persist fault is
    // counted as a persist failure and never read as a missing registry row.
    async persistStakeQualified(round, sender, prices, senderPubkey) {
        try {
            await this.persistSubmissions(round, sender, prices, senderPubkey);
        } catch (e) {
            logger.error(nodeUtil.format('Oracle: Error persisting submission:', e));
            this.failedSubmissionPersists += prices.length;
            this.lastSubmissionPersistFailureRound = round;
            this.lastSubmissionPersistFailureCount = prices.length;
        }
    },

    // Count a stake-feed fault and name it, instead of sending the operator to
    // syncvalidators for a peer that registering would not help.
    onStakeWeightLookupFailure(round, sender, reason) {
        this.stakeWeightLookupFailures++;
        this.lastStakeWeightLookupFailureRound = round;
        logger.warn('Oracle: skipping DB persist for sender ' + sender + ' on round ' + round +
            ': ' + reason + ' (stake feed or indexer fault; registering the peer will not help)');
    },

    // Persist price submissions to the database
    async persistSubmissions(round, sender, prices, validatorPubkey) {
        // Resolve pubkey for self
        if (!validatorPubkey && this.identity) {
            validatorPubkey = this.identity.getPubkeyHex();
        }
        if (!validatorPubkey) {
            validatorPubkey = '0000000000000000000000000000000000000000000000000000000000000000';
        }

        let inserts = [];
        for (let p of prices) {
            // createOracleSubmission is an INSERT IGNORE: a concurrent write from
            // another hub collapses silently rather than rejecting this one.
            inserts.push(this.db.createOracleSubmission(round, p.coinPair, validatorPubkey, p.price, p.sources));
        }

        // Settle every insert before the round proceeds so a persistence failure is
        // observable instead of fire-and-forget. Deliberately Promise.allSettled, NOT
        // Promise.all, and NOT re-thrown: a dropped audit row must never stall a
        // money-bearing consensus round (that would trade a benign audit gap for a
        // liveness bug). Failures are counted and surfaced via getDiagnostics().
        let results = await Promise.allSettled(inserts);
        let failed = 0;
        for (let r of results) {
            if (r.status === 'rejected') {
                failed++;
                logger.error(nodeUtil.format('Oracle: Error persisting submission:', r.reason));
            }
        }
        if (failed > 0) {
            this.failedSubmissionPersists += failed;
            this.lastSubmissionPersistFailureRound = round;
            this.lastSubmissionPersistFailureCount = failed;
        }
    },

    // Prune old submission data (keep current and previous round only)
    pruneSubmissions() {
        for (let [round] of this.submissions) {
            if (round < this.currentRound - 1) {
                this.submissions.delete(round);
            }
        }
    },

    // Bound the durable oracle_submissions audit table to the retention window.
    // The in-memory pruneSubmissions only trims the Map; without this the table
    // grows monotonically. Keyed to round_number (indexed) so the DELETE is cheap
    // and deterministic; keeps the most recent submissionsRetentionRounds rounds.
    // oracle_submissions is diagnostic-only (finalized values live in
    // price_snapshots), so dropping aged rows is safe and never consensus-visible.
    async pruneSubmissionsDb() {
        if (!this.submissionsRetentionRounds || this.submissionsRetentionRounds <= 0) return;
        let cutoff = this.currentRound - this.submissionsRetentionRounds;
        if (cutoff <= 0) return;
        let result = await this.db.deleteOracleSubmission(cutoff);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        if (deleted > 0) {
            logger.info('Oracle submissions retention: pruned ' + deleted +
                ' rows older than round ' + cutoff + ' (keep ' +
                this.submissionsRetentionRounds + ' rounds)');
        }
        // Latch clears only after a DELETE actually completed, never on the two
        // early returns above: those mean the sweep did not run, which is not
        // evidence that a dark DB is reachable again.
        if (this._submissionsPruneDark) {
            this._submissionsPruneDark = false;
            logger.warn('Oracle submissions retention: prune recovered at round ' +
                this.currentRound + ' (' + this.submissionsPruneFailures +
                ' failure(s) since start)');
        }
    },

    // The only trace a failed retention sweep leaves. Counters are monotonic (like
    // failedSubmissionPersists) so a fault that has since recovered is still visible
    // to getSubmissionsInfo; the warn fires once per dark spell, on the transition in.
    //
    // The error MESSAGE is logged and deliberately not put on the counters:
    // getoraclesubmissions is in the hub's public read tier (only getallconfigs is a
    // gated read), and a raw driver error can carry a DB user, host or schema detail.
    // getSubmissionsInfo already draws this line for droppedPairsReadError, which
    // exposes a boolean and logs the exception.
    onSubmissionsPruneFailure(err, round) {
        this.submissionsPruneFailures++;
        this.lastSubmissionsPruneFailureRound = round != null ? round : this.currentRound;
        if (this._submissionsPruneDark) return;
        this._submissionsPruneDark = true;
        logger.warn('Oracle submissions retention: prune FAILED at round ' +
            this.lastSubmissionsPruneFailureRound +
            '; the oracle_submissions audit table will grow until it recovers: ' +
            ((err && err.message) ? err.message : err));
    }

};
