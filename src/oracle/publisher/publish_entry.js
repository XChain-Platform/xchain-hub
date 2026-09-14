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
 * XChain Hub - Oracle Publisher: one queue entry, from guard to broadcast
 *
 * Every step here exists to make a DOUBLE DOGE SPEND unreachable: the two halves
 * of the at-most-once guard, the quarantine, the durable marker read that fails
 * CLOSED, the spend reservation taken in one synchronous turn, and the intent row
 * written BEFORE the send. The entry travels with the pass it belongs to
 * (`pass.remaining`, `pass.balance`, `pass.publishedThisPass`), which is what the
 * queue rebuild and the retention sweep read once the pass ends.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // One queue entry. Returns having either published it, dropped it, or left it on
    // `pass.remaining` for a later pass; nothing here throws on an ordinary failure.
    async publishQueueEntry(entry, pass) {
        // Entries that have exhausted their broadcast attempts are moved to the
        // append-only dead-letter file rather than silently erased on the next
        // queue rewrite. The finalized round stays recoverable for manual replay,
        // and the give-up is counted (abandonedCount) instead of only logged.
        if (entry.attempts >= this.maxAttempts) {
            logger.error('OraclePublisher: round ' + entry.round + ' exceeded max attempts (' +
                this.maxAttempts + '), moving to dead-letter file ' + this.deadLetterPath);
            this.deadLetter(entry, 'exceeded max attempts (' + this.maxAttempts + ')');
            return;
        }

        // Every at-most-once check below runs over the entry's CONTAINED rounds, not
        // its identity field. For a v0 entry that list is [entry.round] and nothing
        // changes; for a batch it is every round on the wire, which is what stops
        // a re-publish under a DIFFERENT split from finding no marker and paying DOGE
        // a second time for rounds already on chain (D10).
        let entryRounds = this._entryRounds(entry);

        if (this.entryResolvedInProcess(entry, entryRounds)) return;
        if (this.db && !(await this.durableMarkersAllowSend(entry, entryRounds, pass))) return;

        // A batch entry carries its finished wire: the signature set it was built
        // against is the one a quorum signed, so the bytes must not be rebuilt here.
        let payload = entry.batch
            ? entry.wire
            : this.buildPriceV0Wire(entry.round, entry.btcBlockTime, entry.prices, entry.sigs, entry.btcBlockHeight);

        // Choose broadcast strategy: custom hook overrides, otherwise use the default encoder pipeline
        let broadcaster = this.broadcastFn || ((p) => this.defaultBroadcast(p));
        let canBroadcast = this.broadcastFn || (this.encoder && this.walletSignFn);

        // Decline an unwired pipeline BEFORE any budget is claimed and before any
        // intent is recorded: nothing can leave the process on this branch, so it
        // must consume no reservation and leave no crash marker behind.
        if (!canBroadcast) {
            logger.warn('OraclePublisher: no broadcast pipeline configured (set DOGE_ENCODER_URL + setWalletSignHook, or setBroadcastHook), round ' + entry.round + ' will remain queued');
            entry.attempts++;
            pass.remaining.push(entry);
            return;
        }

        await this.reserveAndBroadcast(entry, entryRounds, payload, broadcaster, pass);
    },

    // The two in-memory suppressors, both of which mean this entry must be dropped
    // WITHOUT a re-broadcast. True when the entry was resolved here.
    entryResolvedInProcess(entry, entryRounds) {
        // At-most-once guard. If this round was already broadcast this process
        // lifetime, it is only still on the queue because a prior tick's rewrite
        // failed to truncate it. Re-broadcasting would spend DOGE twice, so drop
        // the stale entry (do not push to remaining) instead of sending again.
        if (entryRounds.some(r => this._publishedRounds.has(r))) {
            logger.warn('OraclePublisher: round ' + entry.round + ' already broadcast this process lifetime; dropping stale queue entry without re-broadcast (a prior queue rewrite must have failed)');
            return true;
        }

        // Quarantined round (an intent-only durable marker from a pre-crash broadcast
        // whose on-chain state is unknown). NEVER re-broadcast: drop the stale queue
        // entry and leave it for operator replay. Surfaced at startup in hydratePublishedMarkers.
        if (entryRounds.some(r => this._quarantinedRounds.has(r))) {
            logger.warn('OraclePublisher: round ' + entry.round + ' is quarantined (publish intent recorded before a crash, on-chain state unknown); dropping queue entry without re-broadcast, awaiting operator replay');
            return true;
        }
        return false;
    },

    // Durable at-most-once. Consult the persistent marker before spending DOGE so
    // a restart (empty in-process Set, round still on the durable queue) can never
    // re-broadcast an already-published round. FAIL CLOSED on any DB error: if we
    // cannot prove the round is unpublished we defer rather than risk a duplicate
    // spend (kept on the queue, retried next tick; attempts NOT incremented, this
    // is not a broadcast failure). False when this entry must not be sent.
    async durableMarkersAllowSend(entry, entryRounds, pass) {
        let sent = null;
        let failed = false;
        for (let r of entryRounds) {
            let marker;
            try {
                marker = await this.getPublishedMarker(r);
            } catch (e) {
                logger.error(nodeUtil.format('OraclePublisher: cannot read durable publish marker for round ' + r +
                    '; deferring broadcast (fail closed to avoid a duplicate DOGE spend): ', e));
                failed = true;
                break;
            }
            if (marker && marker.sent_at !== null && marker.sent_at !== undefined) { sent = marker; break; }
        }
        if (failed) { pass.remaining.push(entry); return false; }
        if (sent) {
            // Already broadcast in a prior process; only still on the queue because
            // a rewrite failed before restart. Drop without re-sending. ANY contained
            // round being marked condemns the whole wire: the rounds it carries are
            // already on chain, and a batch is atomic.
            logger.warn('OraclePublisher: round ' + sent.round + ' has a durable sent marker (txid ' +
                (sent.txid || '<none>') + '); dropping stale queue entry without re-broadcast');
            for (let r of entryRounds) this._publishedRounds.mark(r);
            return false;
        }
        return true;
    },

    // Claim the window's budget, record the intent, and send.
    //
    // item 2676 - per-window spend ceiling. A tripped ceiling is not a
    // failure: keep the round queued (no attempts++) and skip the broadcast
    // so it publishes in a later window.
    //
    // RESERVE rather than allow(): the broadcast below is AWAITED, and
    // src/lib/spend_guard.js forbids the pure allow()/record() pair around an
    // awaited send, because concurrent callers all read the same pre-send budget
    // and every one of them spends past the cap. The _sweeping guard on the pass
    // makes two passes rare rather than impossible (a future second call site, or a
    // sweep timer, reopens it), so the gate is closed by construction here
    // instead of by the caller's discipline. reserve() consumes the budget in
    // this synchronous turn and is handed back by release() only when the send
    // never went out; the reservation IS the recorded spend, so record() must
    // never be called on this path.
    async reserveAndBroadcast(entry, entryRounds, payload, broadcaster, pass) {
        let spendToken = this.spendGuard.reserve();
        if (!spendToken) {
            logger.warn(this.spendGuard.noteBlocked() + ' (round ' + entry.round + ')');
            pass.remaining.push(entry);
            return;
        }

        // Record broadcast intent BEFORE the send and AFTER the reservation. A crash
        // between here and the sent marker leaves an intent-only row that startup
        // quarantines (never auto-rebroadcast), so a round the ceiling DECLINED must
        // never leave one behind: that stranded a round nothing had broadcast.
        // Fail closed if the intent cannot be durably recorded.
        if (this.db && !(await this.recordEntryIntent(entryRounds))) {
            this.spendGuard.release(spendToken);
            pass.remaining.push(entry);
            return;
        }

        try {
            let result = await broadcaster(payload);
            await this.notePublishedEntry(entry, entryRounds, result, spendToken, pass);
            // Successfully published. Drop from queue (do not add to remaining).
        } catch (err) {
            this.handlePublishFailure(entry, err, spendToken, pass);
        }
    },

    // One durable intent row per contained round. False when a row could not be
    // written, which defers the send.
    async recordEntryIntent(entryRounds) {
        for (let r of entryRounds) {
            try {
                await this.recordPublishIntent(r);
            } catch (e) {
                logger.error(nodeUtil.format('OraclePublisher: cannot record durable publish intent for round ' + r +
                    '; deferring broadcast (fail closed): ', e));
                return false;
            }
        }
        return true;
    },

    // The wire left the process. Everything here is bookkeeping the next pass, a
    // restart and the operator's status call read.
    async notePublishedEntry(entry, entryRounds, result, spendToken, pass) {
        // Record the rounds as published BEFORE the queue rewrite. This is the
        // at-most-once anchor: even if the rewrite below fails and leaves this
        // round on the durable queue, the next tick's guard will skip it.
        for (let r of entryRounds) this._publishedRounds.mark(r);
        // This wire's change becomes spendable by the next wire in this pass.
        // Depth counts sends, not chain links, so it over-counts a pass that
        // spent separate confirmed outputs and stops chaining early.
        this._passChainDepth++;
        if (result && result.txid) this._passSelfChange.add(String(result.txid));
        this.spendGuard.commit(spendToken);   // the reservation IS the fee charged to the window
        // Persist the durable sent marker so the guard survives a restart (the
        // in-process tracker above does not). Best-effort: on failure the intent
        // row remains and a restart quarantines the round rather than re-broadcasting.
        // ONE ROW PER CONTAINED ROUND: the table's semantics are one row per round
        // and every guard reads it that way, so a batch that marked only its first
        // round would leave the rest re-publishable under a different split (D10).
        for (let r of entryRounds) {
            await this.markPublished(r, (result && result.txid) || null);
        }
        if (entry.batch) {
            logger.info('OraclePublisher: published PRICE batch [' + entry.batch.firstRound + ',' +
                entry.batch.lastRound + '] carrying ' + entryRounds.length + ' round(s)' +
                (entry.batch.compressed ? ' (compressed)' : '') + ' (txid: ' + (result && result.txid) + ')');
            // A window counts once no matter how many wires it split into, so the
            // counter reads as "windows on chain"; the split count is separate.
            if (entry.batch.wireIndex === 0 || entry.batch.wireIndex === undefined) {
                this.batchWindowsPublished++;
            }
            this.lastPublishedWindow = entry.batch.windowIndex;
        } else {
            logger.info('OraclePublisher: published round ' + entry.round + ' (txid: ' + (result && result.txid) + ')');
        }
        this.publishedCount++;
        pass.publishedThisPass  = true;
        // LAST_ROUND, not the entry's identity field: the dashboard's
        // publisher-stall rule reads this as "the newest round on chain", and
        // reporting FIRST_ROUND would make a healthy rail look an hour behind.
        this.lastPublishedRound = entry.batch ? entry.batch.lastRound : entry.round;
        this.lastPublishedTxid  = (result && result.txid) || null;
        // Hand the wire to the watchdog. lastPublishedTxid alone answers "did we
        // send", never "did it land", and the two diverge for as long as a stuck
        // package sits in the mempool.
        this.notePendingConfirmation(this.lastPublishedRound, this.lastPublishedTxid);
    },

    // item 2675 - NEVER blind-retry an ambiguous send. A timeout / reset /
    // 5xx after the request left the wire may mean the DOGE node accepted
    // the tx; re-broadcasting would spend DOGE twice and double-anchor the
    // round. OraclePublisher has no on-chain existence check to adopt the
    // possibly-landed tx, so the fail-safe action is to stop auto-retrying:
    // move the round to the durable, recoverable dead-letter file (counted,
    // never silently dropped) for manual inspection/replay. Only definitive
    // pre-send errors keep the existing attempts-and-requeue retry.
    // `oraclePreSend` is the default pipeline's own report that the failure
    // came from a stage that CANNOT have sent anything (get_utxos, create_tx,
    // the sign hook). Without this exclusion the classifier below - which
    // answers "ambiguous" for any error it does not recognise - dead-lettered
    // a get_utxos timeout, permanently removing a never-broadcast round from
    // automatic retry. A custom broadcastFn sets no tag, so an unknown
    // broadcaster keeps the conservative default it has today.
    handlePublishFailure(entry, err, spendToken, pass) {
        if (!(err && err.oraclePreSend)
            && (this.isAmbiguousSendError(err) || (err && err.oracleAmbiguousSend))) {
            // COMMIT, not release: this branch has already decided the tx may be
            // on-chain and dead-letters the round rather than retrying, so the fee
            // may well have been paid. Keeping the reservation charges the window
            // for it, which fails closed; releasing would hand back budget for a
            // spend nothing will ever re-attempt.
            this.spendGuard.commit(spendToken);
            logger.error(nodeUtil.format('OraclePublisher: AMBIGUOUS send failure for round ' + entry.round +
                ' (tx may have reached the DOGE node); NOT re-broadcasting to avoid a double spend. ' +
                'Moving to dead-letter file ' + this.deadLetterPath + ' for manual verify/replay: ', err));
            this.deadLetter(entry, 'ambiguous send failure (possible double-spend risk); verify on-chain before replay');
            // The same tx that must not be auto-retried here must not
            // be re-published by this hub's own takeover of the window either.
            if (entry.batch) this.noteAmbiguousWindow(parseInt(entry.batch.windowIndex));
            return;   // do not push to remaining; no auto re-broadcast
        }
        // Definitive pre-send failure: nothing left the process and the round is
        // requeued for a later attempt, so the budget goes back (the invariant
        // the old post-send record() gave for free).
        this.spendGuard.release(spendToken);
        entry.attempts++;
        logger.error(nodeUtil.format('OraclePublisher: publish failed for round ' + entry.round + ' (attempt ' + entry.attempts + '/' + this.maxAttempts + '): ', err));
        if (pass.balance !== null && pass.balance < 0.01) {
            logger.error('OraclePublisher: insufficient DOGE balance for round ' + entry.round);
        }
        pass.remaining.push(entry);
    }
};
