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
 * XChain Hub - Attestation Publisher: the replay and failover sweep
 *
 * Re-broadcasts queued responses still pending on the indexer: crash replay, leader
 * retry and rank-staggered follower step-in. Installed on
 * AttestationPublisher.prototype by src/attestation/publisher.js.
 *
 ********************************************************************/

'use strict';

const axios    = require('axios');
const nodeUtil = require('node:util');
const { PENDING_PAGE_LIMIT } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- Failover / replay sweep -----

    // Re-broadcast any queued finalized response whose request is still pending.
    // Run once at startup (crash replay) and on an interval (failover + leader retry).
    //
    // Sweep self-overlap guard (house convention: FullNodeChallengeRound.tick).
    // The sweep is a bare setInterval at 30s while one pass pages the indexer's whole
    // pending set (5s per page) and then awaits a real BTC broadcast per eligible entry,
    // so a slow indexer or a slow node lets the next interval fire on top of this one.
    // Both passes read the same queue FILE, and every gate that would stop the second
    // one is read before the first arms it: _publishedRequests.mark(rid) lands only
    // after broadcaster() resolves, pendingIds still lists the request because nothing
    // has been mined, and removeFromQueue runs at the very end. So two overlapping
    // sweeps re-broadcast the SAME finalized response, spending the BTC fee twice for a
    // duplicate on-chain ATTEST response, which is exactly the double-spend the
    // at-most-once set and the ambiguous-send cooldown exist to prevent. The guard is a
    // wrapper rather than inline so the finally cannot be skipped by any of the body's
    // early returns; a rejected fetchPendingRequestIds must not wedge the sweep, since
    // only this timer ever drains the WAL.
    async processQueue(){
        if (this._sweeping){
            logger.warn('AttestationPublisher: queue sweep still in flight; skipping this pass');
            return;
        }
        this._sweeping = true;
        try {
            return await this.processQueueInner();
        } finally {
            this._sweeping = false;
            // Marker-table retention, not part of the broadcast pass. It runs from the
            // finally so every early return above it is covered (a live-path publish
            // leaves an EMPTY queue, and the inner pass returns before its body on an
            // empty queue), and after the overlap guard releases so a slow DELETE can
            // never make the next tick think a sweep is still in flight.
            this.sweepPublishedRequestRetention();
        }
    },

    async processQueueInner(){
        // Kill switch: suppress the failover/replay sweep too, not just the
        // live path, or a paused publisher would still drain the queue and spend BTC.
        // Entries stay on the durable WAL untouched and resume only when re-enabled.
        if (!this.enabled){
            logger.info('AttestationPublisher: disabled (ATTEST_ENABLED=false); skipping queue sweep');
            return;
        }

        let entries = this.readQueue();
        if (entries.length === 0) return;

        // Authoritative double-broadcast guard: any request no longer in the
        // indexer's pending set has already landed on-chain (or expired past its
        // deadline) and must not be re-broadcast.
        let pendingIds = await this.fetchPendingRequestIds();
        if (pendingIds === null){
            // Indexer unreachable; we can't tell which entries already landed,
            // so we defer rather than risk a double-broadcast. Retried next sweep.
            logger.warn('AttestationPublisher: indexer unreachable; deferring queue replay (' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ' retained)');
            return;
        }

        let broadcaster = this.getBroadcaster();
        let now  = Date.now();
        let drop = new Set();     // request IDs to remove (landed/expired or re-broadcast)
        let replayed = 0;

        for (let entry of entries){
            let rid = String(entry.requestId).toLowerCase();
            // The entry's own response status is half the publication identity every
            // guard below keys on, so it is read before the first of them.
            let entryStatus = String(entry.status || 'ok');

            let rank = this.replayRank(entry, rid, entryStatus, pendingIds, now, drop);
            if (rank === null) continue;
            if (this.ambiguousHoldsReplay(rid, now)) continue;

            if (!broadcaster){
                logger.warn('AttestationPublisher: no broadcast pipeline configured; ' + rid.substring(0,16) + '... retained for later replay');
                continue;
            }

            let spendToken = await this.armReplaySend(rid, entryStatus, drop);
            if (!spendToken) continue;

            replayed += await this.replayEntry(entry, rid, entryStatus, rank, broadcaster, spendToken, drop);
        }

        if (drop.size > 0) this.removeFromQueue(drop);
        if (replayed > 0) logger.info('AttestationPublisher: replay/failover re-broadcast ' + replayed + ' finalized response(s)');
    },

    // The durable half of the decision to spend on a replay, in the order it ran
    // inline. Returns the spend reservation, or null when the entry stays queued.
    async armReplaySend(rid, entryStatus, drop){
        // The guard the pending-set check above cannot give us. A
        // response the PREVIOUS process broadcast is still pending here (accepted
        // but unmined), and both in-process guards died with that process, so
        // without a durable marker this sweep pays a second BTC fee for it.
        let gate = await this.durableSendGate(rid, entryStatus);
        if (gate === 'sent'){ drop.add(rid); return null; }
        if (gate === 'defer') return null;   // retained, retried on a later sweep

        // Per-window BTC spend ceiling. When exhausted, retain the
        // entry (no spend) for a later window rather than re-broadcasting now.
        // Reserve before the await for the same reason the live path
        // does: this loop awaits a real broadcast per entry, so a live
        // onRequestFinalized firing mid-await would otherwise pass the very same
        // allow() this pass already passed.
        let spendToken = this.spendGuard.reserve();
        if (!spendToken){
            logger.warn(this.spendGuard.noteBlocked() + ' (' + rid.substring(0,16) + '...); entry retained on queue');
            return null;
        }
        // Intent goes durable only here, past every no-send exit above
        // (the ceiling trip especially: it retains the entry for a later window, and
        // an intent row would make that later window quarantine it instead).
        if (!await this.armPublishIntent(rid, entryStatus)){
            this.spendGuard.release(spendToken);
            return null;   // retained, retried on a later sweep
        }
        return spendToken;
    },

    // This entry's step-in rank, or null when the sweep must leave it alone: it is
    // already published, already landed, an aged-out advisory row, not ours, or not yet
    // eligible. Drops what the queue no longer needs to hold, and nothing here awaits.
    replayRank(entry, rid, entryStatus, pendingIds, now, drop){
        // At-most-once guard: if this publication was already broadcast this process
        // lifetime, it is only still on the queue because a prior tick's rewrite
        // failed to truncate it. Re-broadcasting would spend a BTC fee twice, so
        // drop the stale entry without re-sending (mirrors OraclePublisher).
        if (this.isPublishedInProcess(rid, entryStatus)){
            logger.warn('AttestationPublisher: ' + rid.substring(0,16) + '... (' + entryStatus + ') already broadcast this process lifetime; dropping stale queue entry without re-broadcast (a prior queue rewrite must have failed)');
            drop.add(rid);
            return null;
        }

        if (!pendingIds.has(rid)){
            // Already resolved on-chain; clear it out. This also settles an
            // ambiguous send: the tx landed and left the pending set,
            // so drop it and forget the ambiguous mark rather than re-broadcasting.
            drop.add(rid);
            this._ambiguousSends.delete(rid);
            return null;
        }

        // Non-ok entries (Phase 4 advisory rows) leave the request pending
        // BY DESIGN, so "still pending" proves nothing about whether the
        // row landed. Retry only briefly (crash recovery / transient
        // encoder failure), then drop rather than risk duplicate audit
        // rows; the deadline-expiry path is the terminal backstop.
        let age0 = now - (Number(entry.ts) || 0);
        if (entryStatus !== 'ok' && age0 > this.failoverWindowBlocks * this.approxBlockMs){
            drop.add(rid);
            return null;
        }

        let rank = this.myRank(entry);
        if (rank === null) return null;  // not our responsibility; leave it

        // Eligibility: the leader entry is only retried after a short grace
        // (so the live broadcast wins the happy path and a crash-surviving
        // entry, whose ts is already old; replays at once). A follower at
        // rank r steps in only after r failover windows of leader silence.
        let age = now - (Number(entry.ts) || 0);
        let eligible = (rank === 0)
            ? (age >= this.leaderRetryMs)
            : (age >= rank * this.failoverWindowBlocks * this.approxBlockMs);
        if (!eligible) return null;

        return rank;
    },

    // Defer re-broadcast of a request whose prior send failed
    // AMBIGUOUSLY until it has had time to reach the indexer's mined view. It
    // is still pending here, but "pending" cannot distinguish a never-sent tx
    // from a landed-but-unmined one (the exact double-spend window). If the
    // cooldown has elapsed and it is STILL pending, it genuinely did not land,
    // so clear the mark and allow a safe re-broadcast.
    ambiguousHoldsReplay(rid, now){
        let ambTs = this._ambiguousSends.get(rid);
        if (ambTs !== undefined){
            if ((now - ambTs) < this.ambiguousCooldownMs){
                logger.warn('AttestationPublisher: ' + rid.substring(0,16) + '... had an ambiguous send ~' +
                             Math.round((now - ambTs) / 1000) + 's ago; deferring re-broadcast to avoid a double spend');
                return true;
            }
            this._ambiguousSends.delete(rid);   // cooldown passed + still pending => safe to resend
        }
        return false;
    },

    // One eligible entry re-broadcast, with the fee-bearing bookkeeping settled the
    // way the live path settles it. Returns 1 when the entry went out and was dropped
    // from the queue, 0 when it stays for a later sweep.
    async replayEntry(entry, rid, entryStatus, rank, broadcaster, spendToken, drop){
        let replayed = 0;
        try {
            let result = await broadcaster(entry.wire, { requestId: entry.requestId });
            // Arm the at-most-once guard the instant the fee is spent, so a failed
            // dequeue rewrite below cannot let the next sweep re-broadcast this entry.
            this._publishedRequests.mark(this.publicationKey(rid, entryStatus));
            this.spendGuard.commit(spendToken);   // the reservation IS the recorded spend
            this._ambiguousSends.delete(rid);
            await this.markPublished(rid, result && result.txid, entryStatus);   // restart-surviving marker
            this.recordSpend(rid, result && result.txid, rank === 0 ? 'sweep-leader' : 'sweep-stepin');
            replayed++;
            drop.add(rid);
            logger.info('AttestationPublisher: ' + (rank === 0 ? 're-broadcast leader' : 'stepped in (rank ' + rank + ')') +
                        ' for ' + rid.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
        } catch (e) {
            // Classify BEFORE settling the reservation, exactly as the live path
            // does: only a definitively-unsent broadcast frees budget.
            // Mark an ambiguous replay failure so the NEXT sweep defers
            // rather than immediately re-broadcasting a possibly-landed tx.
            if (this.isAmbiguousSendError(e) || (e && e.attestAmbiguousSend)){
                // COMMIT: the replay may have paid a fee, so the window is charged
                // for it rather than handed the allowance back.
                this.spendGuard.commit(spendToken);
                this._ambiguousSends.set(rid, Date.now());
                logger.error(nodeUtil.format('AttestationPublisher: AMBIGUOUS replay failure for ' + rid.substring(0,16) +
                              '... (tx may have reached the BTC node); deferring re-broadcast: ', e));
            } else {
                // Definitively no send, so it consumes no budget; withdraw the intent
                // so the retry this line promises is not cancelled by a quarantine
                // after a restart.
                this.spendGuard.release(spendToken);
                await this.clearPublishIntent(rid, entryStatus);
                logger.error(nodeUtil.format('AttestationPublisher: replay broadcast failed for ' + rid.substring(0,16) + '... (will retry): ', e));
            }
            // keep; not added to drop, and the sweep counts no replay for it
        }
        return replayed;
    },

    // Sweep the indexer's pending attestation_requests into a Set of request IDs.
    // Returns null on any failure (indexer unreachable / error) so callers can
    // distinguish "nothing pending" (empty Set) from "couldn't determine".
    async fetchPendingRequestIds(){
        let url = await this.resolveBtcIndexerUrl();
        if (!url) return null;

        let ids = new Set();
        let cursor = null;
        // Page through the full pending queue. Bounded by a generous page cap so a
        // pathological indexer response can't spin forever.
        for (let page = 0; page < 10000; page++){
            let params = { limit: PENDING_PAGE_LIMIT };
            if (cursor){
                params.after_block_index  = cursor.block_index;
                params.after_action_index = cursor.action_index;
            }
            let res;
            try {
                res = await axios.post(url, {
                    jsonrpc: '2.0', id: Date.now(),
                    method:  'getpendingattestation_requests',
                    params:  params
                }, { headers: this.hub.btcIndexerHeaders(), timeout: 5000 });
            } catch (e) {
                logger.warn(nodeUtil.format('AttestationPublisher: pending-request fetch failed:', (e && e.message ? e.message : e)));
                return null;
            }
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let requests = result.requests || [];
            for (let r of requests){
                let rid = String(r.request_id || '').toLowerCase();
                if (rid) ids.add(rid);
            }
            if (requests.length < PENDING_PAGE_LIMIT) break;
            let last = requests[requests.length - 1];
            cursor = { block_index: Number(last.block_index), action_index: Number(last.action_index) };
        }
        return ids;
    },

    async resolveBtcIndexerUrl(){
        if (typeof this.hub.resolveBtcIndexerUrl === 'function'){
            return await this.hub.resolveBtcIndexerUrl();
        }
        return null;
    }

};
