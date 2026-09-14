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
 * XChain Hub - Attestation Publisher: the live path
 *
 * What every responsible node does with a 'request:finalized' event: WAL the ATTEST
 * v1 wire, and on the leader, broadcast it under the spend reservation and the
 * durable intent. Installed on AttestationPublisher.prototype by
 * src/attestation/publisher.js.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { isResponseMirrorActive } = require('../../attest_response_mirror_activation.js');
const { ATTEST_WIRE_MAX_BYTES } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The reasons this publisher writes nothing at all for a finalized round, checked
    // before any of the four side effects (queue append, broadcast, spend reservation,
    // durable intent) can branch off. True means the round is not this era's to serve.
    finalizedEventSkipped(event){
        if (!event || !event.requestId) return true;
        // Kill switch: when disabled, do not WAL or broadcast. Skip rather
        // than queue-for-later so a disabled publisher does not build a backlog that
        // floods BTC broadcasts the moment it is re-enabled.
        if (!this.enabled){
            logger.info('AttestationPublisher: disabled (ATTEST_ENABLED=false); skipping finalized response for ' +
                        String(event.requestId).substring(0,16) + '...');
            return true;
        }
        // ATTEST response mirror activation (the ATTEST response mirror design,
        // decision D58). Above the activation height a finalized
        // request's response rides the hub mirror (AttestationResponseMirror /
        // ATTEST_RESULT gossip) instead of an on-chain ATTEST v1, so this publisher
        // must stay out of it entirely: no queue append, no broadcast, no spend
        // reservation, no durable publish intent. The 'request:finalized' listener
        // is process-global, attached once in start(), so a per-request "detach" (the
        // spec's own phrasing) is not implementable; a per-request early return here,
        // before any of those four side effects branch off, is the one place that
        // covers all of them. Gated on the REQUEST's own BTC block_index (never the
        // response's, never the current chain tip), matching every other request-plane
        // gate in this file. `null` in the activation map reads as unratified/off, so
        // on every network but regtest this branch is dead code until the operator
        // arms a height (mainnet and testnet are both null as of this writing). The
        // failover sweep (_processQueue) replays from the on-disk queue file
        // independently of this event, so a legacy-era entry queued before a future
        // flag day still drains untouched; skipping the enqueue here needs no sweep
        // change.
        if (isResponseMirrorActive(Number(event.request && event.request.block_index), this.hub.network)){
            return true;
        }
        return false;
    },

    // Called when AttestationConsensus emits 'request:finalized'. Every node in
    // the responsible set receives this (only responsible nodes run consensus to
    // commit). Each persists the finalized payload to the durable queue; the
    // leader broadcasts immediately, followers wait for the failover sweep.
    async onRequestFinalized(event){
        if (this.finalizedEventSkipped(event)) return;
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if (!event.signatures || event.signatures.length === 0){
            logger.warn('AttestationPublisher: no sigs in finalized event for ' + event.requestId.substring(0,16) + '...; skipping broadcast');
            return;
        }

        let rid     = String(event.requestId).toLowerCase();
        let payload = this.finalizedWire(event, rid);
        if (payload === null) return;

        // Non-ok responses (provider_error / no_quorum, Phase 4) are advisory
        // audit rows: the request STAYS pending on the indexer, so the sweep's
        // "still pending → not yet landed" replay guard cannot tell a landed
        // non-ok row from a lost one. To keep double-publication impossible,
        // only the LEADER handles a non-ok response (no follower WAL step-in),
        // and its queue entry carries the status so the sweep bounds retries.
        // Losing one advisory row to a leader crash is acceptable; the
        // deadline-expiry path remains the terminal backstop.
        let responseStatus = String(event.status || 'ok');

        let ranking      = this.finalizedRankInputs(event);
        let requestBlock = ranking.requestBlock;
        let redundancy   = ranking.redundancy;
        let widen        = ranking.widen;
        let responsible  = (requestBlock != null)
            ? await this._computeResponsible(rid, requestBlock, redundancy, ranking.eventProvider, widen) : null;
        let leaderPubkey = event.leaderPubkey ? String(event.leaderPubkey).toLowerCase()
                         : (responsible && responsible.length ? responsible[0] : null);

        let isLeader = (leaderPubkey && myPubkey && leaderPubkey === myPubkey);
        if (responseStatus !== 'ok' && !isLeader){
            // Advisory row; see the non-ok note above. No WAL, no step-in.
            return;
        }

        if (!this.enqueueFinalized(event, rid, payload, responseStatus, requestBlock, responsible, widen, leaderPubkey)) return;

        if (!isLeader){
            // Followers persist and wait. If the leader stays silent, the
            // failover sweep promotes the next responsible validator in turn.
            logger.info('AttestationPublisher: [FOLLOWER] persisted finalized response for ' + rid.substring(0,16) +
                        '...; will step in after ' + this.failoverWindowBlocks + ' silent block(s) if leader does not broadcast');
            return;
        }

        await this.broadcastFinalized(event, rid, payload, responseStatus);
    },

    // The ATTEST v1 wire for a finalized round, or null when it cannot be published.
    //
    // Guard: the assembled wire string must fit the encoder's data-payload
    // ceiling, or createTx rejects it with a RangeError. Catching that downstream
    // is too late; the entry would already be on the durable WAL and the failover
    // sweep would retry the same oversized payload forever. Drop it loudly here so
    // the operator can shrink the provider's response body.
    finalizedWire(event, rid){
        let payload = this.buildAttestationResponseWire({
            requestId:   event.requestId,
            providerId:  event.providerId,
            responseBody: event.responseBody,
            status:      event.status || 'ok',
            meta:        event.meta,
            signatures:  event.signatures
        });
        let payloadBytes = Buffer.byteLength(payload, 'utf8');
        if (payloadBytes > ATTEST_WIRE_MAX_BYTES) {
            logger.error('AttestationPublisher: ATTEST v1 wire for ' + rid.substring(0, 16) +
                '... is ' + payloadBytes + ' bytes, exceeds encoder limit of ' + ATTEST_WIRE_MAX_BYTES +
                '; dropping broadcast. Reduce the attestation response body size for this provider.');
            return null;
        }
        return payload;
    },

    // What the responsible-set ordering is recomputed over, read off the event alone.
    //
    // Recompute the responsible-set ordering so any node (not just the
    // leader) knows its rank for failover step-in. Persisted on the queue
    // entry so the ordering survives a restart without re-querying snapshots.
    finalizedRankInputs(event){
        let requestBlock = (event.request && event.request.block_index != null) ? Number(event.request.block_index) : null;
        // Normalize redundancy with the SAME rule the other two copies of the
        // responsible-set derivation use (AttestationRound._computeResponsibleSet,
        // the indexer's attest/index.js): Math.max(1, Number(redundancy) || 1). The prior
        // event.signatures.length fallback produced a responsible list of a
        // different LENGTH than consensus and the indexer derived whenever the
        // request carried no redundancy, so _myRank and the failover step-in
        // schedule ranked against a divergent ordering. Failover timing
        // only - the indexer's pending-set guard still prevents a double landing -
        // but wrong timing means multiple followers can step in early or the true
        // rank-1 late.
        let redundancy   = Math.max(1, Number(event.request && event.request.redundancy) || 1);
        // Provider id for the block-anchored stake floor. The event carries it
        // directly; the request row is the fallback for an event shaped by an older
        // publisher. Absent on both, _computeResponsible fails closed on the weighted
        // path rather than rank against a set the other two copies do not agree with.
        let eventProvider = (event.providerId != null) ? event.providerId
                          : ((event.request && event.request.provider_id != null) ? event.request.provider_id : null);
        // Widening slots the round was granted, carried on the event rather than
        // re-derived: ranking over a narrower set than the one that signed would leave a
        // widened member with no rank and no step-in schedule. Absent (older event or
        // queue entry) reads as 0, the pre-widening ordering.
        let widen        = Math.max(0, Number(event.widen) || 0);
        return { requestBlock: requestBlock, redundancy: redundancy, eventProvider: eventProvider, widen: widen };
    },

    // Durable write-ahead log BEFORE the send attempt.
    // Gate the broadcast on a successful, fsync'd WAL write. The queue
    // is the durable record of an intent to spend a real BTC fee; if it cannot be
    // written (full disk, permissions, bad mount) we must NOT spend, or the fee is
    // spent with only stdout as its trace and crash recovery is disarmed for the
    // entry. A failed enqueue is fatal for this entry: skip the broadcast.
    enqueueFinalized(event, rid, payload, responseStatus, requestBlock, responsible, widen, leaderPubkey){
        let queued = this._enqueue({
            ts:           Date.now(),
            requestId:    event.requestId,
            wire:         payload,
            status:       responseStatus,
            requestBlock: requestBlock,
            responsible:  responsible || undefined,
            widen:        widen || undefined,
            leaderPubkey: leaderPubkey || undefined
        });
        if (!queued){
            logger.error('AttestationPublisher: durable enqueue FAILED for ' + rid.substring(0,16) +
                          '...; skipping broadcast (no BTC spend without a durable record). ' +
                          'Other responsible nodes that enqueued cover this response; the deadline-expiry ' +
                          'path is the terminal backstop. Fix the queue file writability now.');
            return false;
        }
        return true;
    },

    // The leader's own send, once the response is on this node's durable queue.
    async broadcastFinalized(event, rid, payload, responseStatus){
        let broadcaster = this.getBroadcaster();
        if (!broadcaster){
            logger.warn('AttestationPublisher: no broadcast hook configured for ' + rid.substring(0,16) + '...; entry queued for later replay');
            return;
        }
        // At-most-once guard: a re-finalized event for a request already broadcast
        // this process lifetime (whose prior dequeue rewrite failed, leaving it on the
        // durable queue) must not spend a second BTC fee. The stale queue entry is
        // dropped by the sweep's matching guard.
        if (this.isPublishedInProcess(rid, responseStatus)){
            logger.warn('AttestationPublisher: ' + rid.substring(0,16) + '... (' + responseStatus + ') already broadcast this ' +
                         'process lifetime; skipping duplicate live broadcast');
            return;
        }
        // The durable half of the same guard, which survives the restart
        // the in-process set does not. Read-only here; the matching intent write comes
        // after the spend reservation below. Either non-send answer leaves the entry on
        // the WAL for the sweep, whose matching gate drops it: the same disposition the
        // in-process check above already gives a duplicate.
        if (await this.durableSendGate(rid, responseStatus) !== 'send') return;
        // Per-window BTC spend ceiling. A tripped ceiling is not a
        // failure: leave the entry on the WAL so the sweep publishes it in a later
        // window; do not spend now.
        // RESERVE rather than allow(): every 'request:finalized' handler
        // runs detached (start() only .catch()es it), so several can be parked on the
        // await below at once. With a pure allow() they all read the same pre-send
        // budget and every one of them broadcasts, overshooting the window ceiling by
        // the concurrency with irreversible sends. The reservation consumes the budget
        // in this synchronous turn and is handed back only if the send never went out.
        let spendToken = this.spendGuard.reserve();
        if (!spendToken){
            logger.warn(this.spendGuard.noteBlocked() + ' (' + rid.substring(0,16) + '...); entry retained on queue');
            return;
        }
        // The send is now committed to, so the intent is durable from here
        // and not one line earlier: everything above this point can still decline to
        // send, and an intent row for a never-sent request reads as a crash-mid-send.
        if (!await this.armPublishIntent(rid, responseStatus)){
            this.spendGuard.release(spendToken);
            return;
        }
        try {
            let result = await broadcaster(payload, event);
            logger.info('AttestationPublisher: broadcast ' + rid.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
            this._broadcastSucceeded++;
            this.spendGuard.commit(spendToken);   // the reservation IS the recorded spend
            this._ambiguousSends.delete(rid);
            this.recordSpend(rid, result && result.txid, 'live');   // durable spend audit
            this._publishedRequests.mark(this.publicationKey(rid, responseStatus));
            await this.markPublished(rid, result && result.txid, responseStatus);   // restart-surviving marker
            this.removeFromQueue(new Set([rid]));
        } catch (e) {
            await this.onLiveBroadcastFailure(rid, responseStatus, spendToken, e);
        }
    },

    // A live broadcast that threw, settled in the order it settled inline.
    async onLiveBroadcastFailure(rid, responseStatus, spendToken, e){
        this._broadcastFailed++;
        // Classify BEFORE settling the reservation: "the send failed" and "the send
        // did not go out" are not the same answer, and only the second one frees
        // budget. An ambiguous send may have reached the BTC node. Mark it so
        // the sweep defers re-broadcast (see _processQueue) instead of blindly
        // spending a second fee. Definitive pre-send errors leave no mark and retry
        // normally.
        if (this.isAmbiguousSendError(e) || (e && e.attestAmbiguousSend)){
            // COMMIT, not release: a fee may have been paid, so the window must be
            // charged for it. Releasing here hands the ceiling back an allowance a
            // real spend already consumed, and the next request spends past it.
            // Same rule AttestationRelay states at its own ambiguous branch.
            this.spendGuard.commit(spendToken);
            this._ambiguousSends.set(rid, Date.now());
            logger.error(nodeUtil.format('AttestationPublisher: AMBIGUOUS broadcast failure for %s... (tx may have reached the BTC node); sweep will defer re-broadcast for ~%ds before retrying:',
                          rid.substring(0,16), Math.ceil(this.ambiguousCooldownMs / 1000), e));
        } else {
            // Definitively no send, so it consumes no budget and the intent is
            // withdrawn: leaving it would quarantine an ordinary RPC rejection at
            // the next restart.
            this.spendGuard.release(spendToken);
            await this.clearPublishIntent(rid, responseStatus);
            logger.error(nodeUtil.format('AttestationPublisher: broadcast failed for %s... (will retry via sweep):', rid.substring(0,16), e));
        }
    }

};
