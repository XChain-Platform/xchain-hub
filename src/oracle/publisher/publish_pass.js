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
 * XChain Hub - Oracle Publisher: one publish pass over the durable queue
 *
 * The pass-level decisions: the self-overlap guard, the fail-closed balance and
 * confirmed-UTXO gates, and the queue rebuild that must never lose a round that
 * arrived while the pass was awaiting a broadcast.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Self-overlap guard for the publish pass, the same house convention the sibling
    // publishers carry (AttestationPublisher._sweeping, AttestationSpotChecker
    // .schedulerTick). onRoundFinalized awaits a pass per PBFT event and nothing
    // serializes those events, so two rounds finalizing inside one pass duration would
    // otherwise run two passes over the same durable queue. That is a DOUBLE DOGE
    // SPEND, not a duplicate log line: every at-most-once check in the body closes only
    // AFTER the multi-second encoder+sign+broadcast round trip (_publishedRounds.mark
    // and markPublished are post-send), and the pre-send intent write is deliberately
    // idempotent (ON DUPLICATE KEY UPDATE), so a second pass clears every guard while
    // the first pass's broadcast is still in flight and re-broadcasts the same round.
    // A wrapper rather than an inline flag, so none of the body's early returns can
    // skip the release. Skipping is safe: the skipped round stays on the durable queue
    // (the rewrite below preserves mid-pass arrivals) and publishes on the next round
    // this hub leads.
    async _processQueue() {
        if (this._sweeping) {
            logger.warn('OraclePublisher: publish pass still in flight; skipping this pass ' +
                '(entries stay on the durable queue and publish on the next pass)');
            return;
        }
        this._sweeping = true;
        try {
            return await this.processQueueInner();
        } finally {
            this._sweeping = false;
        }
    },

    // Process pending rounds in the queue: build payload, check balance, broadcast
    async processQueueInner() {
        // item 2677 kill switch: suppress the replay/sweep too, not just the live
        // path, so a disabled publisher spends nothing. Entries stay on the durable
        // queue untouched and resume only when re-enabled and re-swept.
        if (!this.enabled) {
            logger.info('OraclePublisher: disabled (ORACLE_PUBLISH_ENABLED=false); skipping queue processing');
            return;
        }

        let entries = this.readQueue();
        if (entries.length === 0) return;

        // item 2676 - hard balance floor gate (was: balance read then only WARNed,
        // publishing continued regardless). A null/unreadable balance is fail-closed:
        // skip the whole publish pass rather than spend blind. Below the floor, skip
        // too; entries stay queued and retry once the wallet is topped up. This bounds
        // total drain to the floor no matter which failure mode is driving the spend.
        let balance = await this.checkBalance();
        if (!this.balanceAllowsPass(balance, entries)) return;

        // Confirmed-UTXO reserve. A balance above the floor says nothing about whether
        // that balance can be SPENT INTO A MINEABLE WIRE: after a publish that never
        // confirms, the whole balance is change sitting unconfirmed behind the stuck
        // package. Building on top of it buys a second wire with the same fate, or the
        // encoder's "no spendable inputs available" once the ancestor limits bite.
        // Defer the pass instead: entries stay on the durable queue, nothing is
        // dead-lettered, and no attempt counter is burned, because this is not a
        // broadcast failure. Fail soft, see confirmedUtxoAvailable.
        if (!(await this.confirmedUtxoAvailable())) {
            this.noConfirmedUtxoDeferrals++;
            this.lastNoConfirmedUtxoAt = Date.now();
            let seen = this.lastUtxoReserve || { unconfirmed: 0 };
            logger.warn('OraclePublisher: NO_CONFIRMED_UTXO - every one of the ' + seen.unconfirmed +
                ' spendable output(s) at ' + this.dogeAddress + ' is unconfirmed (change trapped behind ' +
                'an unconfirmed chain); deferring this publish pass, ' + entries.length +
                ' round(s) remain queued and retry once a publish confirms');
            return;
        }

        // A new pass: no wire of ours is in flight from it yet, so no unconfirmed
        // output is eligible until this pass sends one. Cleared here rather than at
        // the end so an early return can never leave a stale txid behind.
        this._passSelfChange.clear();
        this._passChainDepth = 0;

        // The pass the entries are published into: what to keep queued, the balance a
        // failure reports against, and whether anything published (which is what the
        // retention sweep below gates on).
        let pass = { balance: balance, remaining: [], publishedThisPass: false };
        for (let entry of entries) await this.publishQueueEntry(entry, pass);

        this.rebuildQueueAfterPass(entries, pass.remaining);
        this.sweepRetentionAfterPass(pass.publishedThisPass);
    },

    // The fail-closed balance gate, as its own verdict so the pass reads as the
    // sequence of gates it is. False skips the pass with everything still queued.
    balanceAllowsPass(balance, entries) {
        // Only enforce when a balance source is actually wired (a getBalanceFn hook,
        // or an encoder + address to sum UTXOs). With no source, balance is always
        // null and there is nothing to enforce, so preserve prior behavior rather
        // than disable publishing outright.
        let hasBalanceSource = !!(this.getBalanceFn || (this.encoder && this.dogeAddress));
        if (!hasBalanceSource) return true;
        if (balance === null) {
            logger.warn('OraclePublisher: DOGE balance unreadable; skipping publish this pass (fail-closed), ' +
                entries.length + ' round(s) remain queued');
            return false;
        }
        if (balance < this.lowBalanceThreshold) {
            logger.warn('OraclePublisher: DOGE balance ' + balance.toFixed(4) + ' below floor ' +
                this.lowBalanceThreshold + '; skipping publish (fail-closed), ' + entries.length + ' round(s) remain queued');
            return false;
        }
        return true;
    },

    // Rebuild the durable queue from a FRESH read rather than truncating it to the
    // snapshot this pass began with. _enqueue APPENDS to the same file, and
    // onRoundFinalized enqueues before it calls the pass, so a round finalized while
    // this pass was awaiting a broadcast is on disk but absent from `entries`; a
    // blind rewrite to `remaining` erases it, and the overlap guard above makes that
    // arrival MORE likely rather than less (the skipped pass leaves the round on the
    // queue and nothing else drains it). Keep this pass's copy of an unresolved
    // entry, since its attempts counter is the current one, drop only the rounds this
    // pass actually resolved (published, dead-lettered, or dropped as already-sent),
    // and carry everything else through untouched.
    // Built as `remaining` PLUS the mid-pass arrivals, never as a filter over the
    // fresh read alone: readQueue swallows a read failure as an empty list, and a
    // rebuild derived only from it would then truncate the queue and lose every
    // round this pass meant to retry. This shape is never worse than the old blind
    // rewrite, only strictly more inclusive.
    rebuildQueueAfterPass(entries, remaining) {
        let seen     = new Set(remaining.map(e => e.round));
        let resolved = new Set(entries.map(e => e.round).filter(r => !seen.has(r)));
        let rebuilt  = remaining.slice();
        for (let e of this.readQueue()) {
            if (resolved.has(e.round) || seen.has(e.round)) continue;
            seen.add(e.round);
            rebuilt.push(e);
        }

        // Dequeue-side rewrite must fail loud, mirroring the enqueue path's "refuse
        // to ack if queue is unwritable" stance. On success the durable queue holds only
        // unresolved rounds (never a published one), so no published round can still be
        // on disk and the dedup guard can be reset to bound its growth. On failure the
        // published rounds remain on the queue file: keep the guard armed (it prevents
        // the re-broadcast) and surface the failure so an operator repairs the queue
        // before a restart drops the in-memory guard.
        let rewritten = this.rewriteQueue(rebuilt);
        if (rewritten) {
            this._publishedRounds.clear();
        } else {
            logger.error('OraclePublisher: CRITICAL - queue rewrite failed after publishing; ' +
                'published rounds remain on the durable queue at ' + this.queuePath + '. The in-process ' +
                'dedup guard prevents re-broadcast for this process lifetime, but a restart before the ' +
                'queue file is repaired would re-broadcast already-published rounds (duplicate DOGE spend). ' +
                'Fix the queue file writability now.');
        }
    },

    // Bound the durable marker table. Runs after the rewrite so the queue-floor
    // clamp reads the post-pass queue, and only when a round actually published
    // this pass (nothing new to age out otherwise). Fire-and-forget with the
    // rejection swallowed: retention is housekeeping and must never fail, stall,
    // or retry a broadcast pass that has already spent DOGE.
    sweepRetentionAfterPass(publishedThisPass) {
        if (this.db && publishedThisPass && this.lastPublishedRound !== null) {
            this._retentionSweep = this.prunePublishedRounds(this.lastPublishedRound)
                .catch((e) => {
                    logger.warn(nodeUtil.format('OraclePublisher: published-rounds retention sweep failed ' +
                        '(marker table keeps growing until it succeeds): ', e));
                    return 0;
                });
        }
    }
};
