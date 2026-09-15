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

module.exports = {

    // Audit-row fallback for a sender the registry does not know. Qualifying stake at
    // the round's block boundary stands in for the missing registry row; anything the
    // feed cannot place there keeps the original refusal, so an unknown key still
    // writes no placeholder row and still names its remedy.
    //
    // Async and self-catching because handleMessage is a synchronous handler: this is
    // fire-and-forget exactly like the registered-sender persist beside it, and an
    // indexer fault must cost an audit row rather than the round.
    async persistFromStakeWeight(round, envelope, prices, senderPubkey) {
        let feed = this.hub && this.hub.stakeWeightFeed;
        try {
            if (senderPubkey && feed && typeof feed.isQualified === 'function' &&
                await feed.isQualified('price', this.currentBtcBlockHeight, senderPubkey)) {
                await this.persistSubmissions(round, envelope.sender, prices, senderPubkey);
                return;
            }
        } catch (e) {
            logger.warn('Oracle: stake-weight lookup failed for sender ' + envelope.sender +
                ' on round ' + round + ': ' + ((e && e.message) ? e.message : e));
        }
        logger.warn('Oracle: skipping DB persist for unregistered sender ' + envelope.sender +
            ' (call syncvalidators to register the peer)');
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
