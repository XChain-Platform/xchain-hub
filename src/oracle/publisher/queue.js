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
 * XChain Hub - Oracle Publisher: the durable publish queue and the at-most-once markers
 *
 * The JSONL queue and its dead-letter sibling, and the oracle_published_rounds
 * marker table that survives a restart. Every file write goes through the shell's
 * fsync'd primitives, which is where the stubbable fs lives.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Enqueue a round for publishing (durable, fsync'd)
    async _enqueue(round) {
        let entry = Object.assign({}, round, { attempts: 0, enqueuedAt: Date.now() });
        let line  = JSON.stringify(entry) + '\n';
        try {
            this.appendDurableLine(this.queuePath, line);
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to enqueue round %s:', round.round, e));
            // Fail loud: refuse to ack if queue is unwritable
            throw e;
        }
    },

    // Append a give-up entry to the durable dead-letter file (never truncated).
    // Best-effort: a write failure is logged but does not keep the entry looping
    // forever on the main queue. Records the original entry plus when and why it
    // was abandoned so an operator can replay the round manually.
    deadLetter(entry, reason) {
        this.abandonedCount++;
        let record = Object.assign({}, entry, { deadLetteredAt: Date.now(), reason: reason });
        let line   = JSON.stringify(record) + '\n';
        try {
            this.appendDurableLine(this.deadLetterPath, line);
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to write dead-letter record for round %s:', entry.round, e));
        }
    },

    // Every round a queue entry carries. A v0 entry carries exactly one, so the v0
    // paths keep their previous behavior byte for byte; a batch entry carries all
    // the rounds on its wire, which is the granularity every at-most-once guard and
    // every durable marker row is keyed at.
    entryRounds(entry) {
        if (entry && entry.batch && Array.isArray(entry.batch.rounds) && entry.batch.rounds.length > 0) {
            return entry.batch.rounds.map(r => parseInt(r)).filter(r => Number.isFinite(r));
        }
        return [entry.round];
    },

    // Read all queue entries (used by _processQueue and on restart)
    readQueue() {
        let raw = this.readDurableFile(this.queuePath);
        if (raw === null) return [];
        return raw.split('\n').filter(line => line.trim().length > 0).map(line => {
            try { return JSON.parse(line); } catch (e) { return null; }
        }).filter(e => e !== null);
    },

    // Rewrite the queue with the given entries (used after successful publishes).
    // Returns true on a durable rewrite, false if the truncating write failed. The
    // dequeue side must NOT swallow a failure: on false the just-published rounds are
    // still on the durable queue, so the caller keeps its in-process dedup guard armed
    // (preventing re-broadcast) and surfaces the failure loudly for operator repair.
    rewriteQueue(entries) {
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            this.rewriteDurableFile(this.queuePath, lines);
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: failed to rewrite queue:', e));
            return false;
        }
    },

    // ----- The retraction seam (D28), called by PriceAggregator -----

    // Forget that a set of rounds was ever published, in BOTH halves of the
    // at-most-once guard. Clearing only the durable rows leaves the in-process set
    // still suppressing the re-publish, and a reorg then costs an hour of price
    // history rather than a round.
    //
    // The quarantine set is deliberately untouched: a quarantined round's on-chain
    // state is unknown, which a retraction does not resolve, and only an operator may
    // release one.
    async clearPublishedMarkers(rounds) {
        let list = (Array.isArray(rounds) ? rounds : [rounds])
            .map(r => parseInt(r)).filter(r => Number.isFinite(r));
        if (list.length === 0) return 0;

        for (let r of list) {
            this._publishedRounds.delete(r);
            // The window memo is the third suppressor: an assembled window is never
            // re-assembled, so a retracted window would never be rebuilt without this.
            this._assembledWindows.delete(this.windowIndexOf(r));
        }
        // The fourth: the buffer itself, which noteBatchLanded shed when the batch
        // landed. Without the material back, an un-suppressed window has nothing to
        // propose.
        try { await this.restoreBufferedRounds(list); }
        catch (e) { logger.warn(nodeUtil.format('OraclePublisher: restoring retracted rounds to the buffer failed:', e && e.message)); }

        if (!this.db) return list.length;
        let result = await this.db.deleteOraclePublishedRoundsByRounds(list);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        logger.info('OraclePublisher: cleared publish markers for ' + list.length +
            ' retracted batch round(s) (' + deleted + ' durable row(s) removed); the recovery ' +
            're-publish is no longer suppressed');
        return deleted;
    },

    // ----- Durable at-most-once marker (oracle_published_rounds) -----

    // Read the durable marker for a round, or null when none exists / no DB is wired.
    // Shape: { round, txid, sent_at }. A row with a non-null sent_at is the
    // authoritative "already broadcast" signal (txid may legitimately be null if the
    // broadcaster returned none, so sent_at, not txid, gates re-broadcast).
    // Throws on a DB error so the caller can FAIL CLOSED (never broadcast when we
    // cannot prove the round is unpublished).
    async getPublishedMarker(round) {
        if (!this.db) return null;
        let rows = await this.db.findOraclePublishedRoundsByRound(round);
        return (rows && rows.length > 0) ? rows[0] : null;
    },

    // Durably record broadcast INTENT for a round before the send. Idempotent: an
    // existing row (intent or sent) is left untouched. Throws on a DB error so the
    // caller fails closed. No-op when no DB is wired.
    async recordPublishIntent(round) {
        if (!this.db) return;
        await this.db.setOraclePublishedRound(round);
    },

    // Durably record that a round's broadcast COMPLETED (sets sent_at + txid). Called
    // after a successful send. A failure here is logged, not thrown: the DOGE is
    // already spent, and the intent row means a restart quarantines the round rather
    // than re-broadcasting it. No-op when no DB is wired.
    async markPublished(round, txid) {
        if (!this.db) return;
        try {
            await this.db.updateOraclePublishedRound(txid, round);
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: broadcast for round ' + round + ' succeeded but its durable ' +
                'sent marker could not be persisted; a restart will QUARANTINE (not re-broadcast) this round. ' +
                'Operator: confirm the txid on-chain. Error: ', e));
        }
    },

    // Startup reconciliation of the durable marker table. Loads every confirmed
    // (sent_at set) round into the in-process guard so a queued-but-already-published
    // round is never re-broadcast after a restart, and QUARANTINES every intent-only
    // (sent_at NULL) round: a crash between intent and confirmation leaves the on-chain
    // state unknown, so those are never auto-rebroadcast: only surfaced for an operator
    // to verify and replay by hand (no price-by-round indexer query exists to reconcile
    // them automatically). Best-effort: a DB error is logged and startup continues; the
    // in-process guard still covers this process lifetime.
    //
    // The same scan restores the last-published markers getStats() reports, so a hub
    // that has published for months does not read as one that never published once its
    // process memory is gone. txid rides along in the select list because the marker
    // row is the only record of which wire carried that round.
    async hydratePublishedMarkers() {
        if (!this.db) return;
        let rows = await this.db.findAllOraclePublishedRounds();
        let quarantined = [];
        // Highest CONFIRMED row seen, which is the publication a restarted hub reports.
        let newest = null;
        for (let r of (rows || [])) {
            let round = Number(r.round);
            if (r.sent_at !== null && r.sent_at !== undefined) {
                this._publishedRounds.mark(round);
                // A confirmed marker is proof this hub published once, and retention
                // never empties the table below the most recent window, so the proof
                // survives a restart. Intent-only rows are deliberately excluded: their
                // on-chain state is unknown, so they are not evidence of a publication.
                if (Number.isFinite(round) && (newest === null || round > newest.round)) {
                    newest = { round: round, txid: (r.txid === undefined ? null : r.txid) };
                }
            } else {
                this._quarantinedRounds.add(round);
                quarantined.push(round);
            }
        }
        // Idempotent, and never walks the markers backwards: an already-published round
        // in this process outranks anything the table can offer, and an empty table
        // leaves a fresh hub reporting null.
        if (newest !== null) {
            if (this._durableEverPublishedRound === null || newest.round > this._durableEverPublishedRound) {
                this._durableEverPublishedRound = newest.round;
            }
            if (this.lastPublishedRound === null || newest.round > Number(this.lastPublishedRound)) {
                this.lastPublishedRound = newest.round;
                this.lastPublishedTxid  = newest.txid;
            }
        }
        if (quarantined.length > 0) {
            logger.error('OraclePublisher: ' + quarantined.length + ' round(s) have a publish-intent marker ' +
                'with no confirmation (rounds ' + quarantined.join(', ') + '); their on-chain state is unknown ' +
                'after a crash. They will NOT be re-broadcast automatically (fail closed). Operator: verify each ' +
                'round on-chain and replay manually if absent.');
        }
    },

    // Bound the durable oracle_published_rounds marker table to the retention window.
    // Without this the table appends one row per published round forever.
    //
    // Two invariants dominate this DELETE, both load-bearing on a money-bearing path:
    //
    //   1. `sent_at IS NOT NULL` is mandatory. A sent_at NULL row is an intent-only
    //      QUARANTINE marker: broadcast intent was recorded but the confirmation never
    //      landed, so the round's on-chain state is unknown and only an operator can
    //      reconcile it (hydratePublishedMarkers surfaces them at startup and refuses
    //      to auto-rebroadcast). Pruning one would erase the sole record that a round
    //      needs hand-verification, and the round would then look never-attempted.
    //   2. No round still on the durable queue may be pruned. The marker is what stops
    //      a restart from re-broadcasting a queued-but-already-published round (a
    //      duplicate DOGE spend). A queue entry older than the retention window means
    //      the queue is not draining, so the cutoff is clamped below the oldest queued
    //      round rather than trusting the window.
    //
    // Returns the number of rows deleted. Throws on a DB error; the caller decides
    // (the publish path treats a retention failure as non-fatal).
    async prunePublishedRounds(anchorRound) {
        if (!this.db) return 0;
        if (!this.publishedRoundsRetentionRounds || this.publishedRoundsRetentionRounds <= 0) return 0;
        let anchor = Number(anchorRound);
        if (!Number.isFinite(anchor)) return 0;

        let cutoff = anchor - this.publishedRoundsRetentionRounds;
        if (cutoff <= 0) return 0;

        // Invariant 2: never prune a marker whose round can still be read off the
        // durable queue file. Best-effort read; an unreadable queue returns [] and the
        // window applies unchanged (the file being unreadable is already loud elsewhere).
        // A batch entry's `round` is its FIRST round, which is also the LOWEST round
        // it carries, so the clamp below still lands under every round the entry
        // protects and needs no batch-specific arm.
        for (let entry of this.readQueue()) {
            let r = Number(entry && entry.round);
            if (Number.isFinite(r) && r < cutoff) cutoff = r;
        }
        if (cutoff <= 0) return 0;

        let result = await this.db.deleteOraclePublishedRound(cutoff);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        if (deleted > 0) {
            this.publishedRoundsPruned += deleted;
            logger.info('OraclePublisher: published-rounds retention pruned ' + deleted +
                ' confirmed marker row(s) older than round ' + cutoff + ' (keep ' +
                this.publishedRoundsRetentionRounds + ' rounds; quarantined intent-only ' +
                'rows are never pruned)');
        }
        return deleted;
    },

};
