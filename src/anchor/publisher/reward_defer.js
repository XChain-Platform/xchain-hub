/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - deferred reward attestations
 *
 * A reward attestation is queued at broadcast time and written only once the
 * anchor is proven mined, so an evicted or reorged anchor never mints one.
 *
 ********************************************************************/

'use strict';

const ar = require('../../consensus/gates/anchor_reward_gate.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Hold a reward attestation until its anchor is actually MINED.
    // _broadcastWithRetry returns when DOGE ACCEPTS the transaction, not when it is
    // confirmed (see the deferral queues in state.js), so a producer site writing
    // the mirror row at that point would write it against a mempool txid. Because the row is
    // append-only and never retracted and the BTC indexer mints a COLLECT-spendable
    // validator_rewards from it, an evicted or reorged anchor would leave a permanent reward
    // for a transaction the chain never carried; nothing downstream can undo it.
    //
    // Queuing grants no authority: the entry writes nothing until
    // drainDeferredRewardAttest sees _verifyAnchorOnChain bind this exact txid at this
    // exact ANCHOR version, buried dogeConfirmations deep. `e` carries the checkpoint
    // identity (chain/network/blockIndex/checkpointSeq) that verification re-SELECTs, the
    // txid and anchorVersion it must bind, and the attestation tuple to write.
    //
    // RESIDUAL, deliberate: this queue is in memory, so a restart inside the confirmation
    // window forfeits THIS hub's own reward for that anchor. That is fail-closed and
    // fleet-uniform (no row exists, so every indexer derives the same nothing), where
    // writing at mempool acceptance would be fail-open (a permanent mint for an anchor
    // that never landed). Making it durable means persisting the XANCPUB sigs, which exist only in
    // the attestation round's memory today.
    deferRewardAttestation(e){
        if(!e || !ar.isAnchorRewardDeriveActive(Number(e.snapshotBlock), e.network)) return;   // gate INERT: no rows exist at all
        if(!e.txid || !e.publisher || !Array.isArray(e.attestSigs) || e.attestSigs.length === 0) return;
        let key = [e.rewardType, String(e.roundReference), String(e.snapshotBlock),
                   String(e.publisher), String(e.txid)].join('|');
        if(this._deferredRewardAttest.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves insertion
        // order), matching the two announcement queues. Dropping only ever forfeits this
        // hub's own reward; it can never write one.
        if(this._deferredRewardAttest.size >= this.announceQueueMax){
            let oldest = this._deferredRewardAttest.keys().next().value;
            this._deferredRewardAttest.delete(oldest);
            logger.warn('StateAnchorPublisher: deferred reward-attestation queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredRewardAttest.set(key, Object.assign({}, e, { at: Date.now() }));
        logger.info('StateAnchorPublisher: reward attestation ' + e.rewardType + '/' + e.roundReference +
                    ' held until anchor ' + e.txid + ' is ' + this.dogeConfirmations + ' deep on DOGE (' +
                    this._deferredRewardAttest.size + ' pending)');
    },

    // The anchor-attest rail's QUEUE-DRAIN RULE for the height watermark.
    //
    // heights.anchor_reward_attestations.BTC certifies that every round for that table which
    // opened at or below it has terminated, and on this rail a round is not terminated until
    // its reward attestation is WRITTEN. The write is deferred until the DOGE anchor is
    // buried, so a snapshot sitting in this queue is an open round whose row the mirror
    // cannot hold yet, and the watermark may not pass it. Returns the LOWEST snapshot block
    // still held, so the producer caps the entry at one below it, or null when the queue
    // holds nothing and the generic bounded advance applies.
    //
    // An entry past announceRetryTtlMs is ABANDONED and no longer counted here, which is
    // what bounds the trail at the TTL (6 h, 36 BTC blocks) instead of leaving it open
    // ended; drainDeferredRewardAttest deletes those entries on its own timer, and this
    // read must not wait for that timer to agree with it.
    //
    // ONE queue covers both halves of the rail: a receiver's re-proof of a peer's reward
    // attestation is handed to this same queue rather than to one of its own
    // (handleRewardAttestation step 4), so the two 36-block terms of the budget are the
    // same constant seen twice and this one read counts both.
    deferredRewardAttestFloor(nowMs){
        let now   = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
        let floor = null;
        for(let e of this._deferredRewardAttest.values()){
            if(!e) continue;
            if(now - Number(e.at) > this.announceRetryTtlMs) continue;   // abandoned by TTL
            // Checked on the RAW value before coercing. Number(null), Number(undefined and
            // Number('') are 0, -0 and 0: a bare Number() here would read an entry with NO
            // snapshot block as a queued snapshot at height ZERO, cap the watermark at -1 and
            // delete the whole anchor entry on the strength of a missing field.
            let raw = e.snapshotBlock;
            if(raw === null || raw === undefined || raw === '') continue;
            let s = Number(raw);
            if(!Number.isSafeInteger(s) || s < 0) continue;
            if(floor === null || s < floor) floor = s;
        }
        return floor;
    },

    // Write the queued reward attestations whose anchor has since been buried. Runs on
    // the announceRetryMs timer and at the head of every flush, beside the BUNDLE_DONE and
    // FINALIZED drains.
    //
    // Only 'verified' writes: verifyAnchorOnChain binds the exact txid AND the exact
    // ANCHOR version, so neither a never-mined transaction nor a different anchor for the
    // same checkpoint can stand in as proof. A decided CONTENT verdict ('rejected:mismatch'
    // / ':version') is terminal for this txid and drops the entry: both are checked only
    // AFTER the dogeConfirmations depth gate, against a decoded payload buried deep enough
    // that a reorg is not expected to change it.
    //
    // 'rejected:status' and 'rejected:txid' are deliberately NOT terminal here.
    // 'rejected:txid' fires while getanchoraction's checkpoint_anchored is UNFILTERED, so
    // it also fires while our own tx is merely unmined on a checkpoint that already carries
    // an earlier anchor, which is the v1 archive head's normal state. 'rejected:status'
    // (the indexer's decoded-invalid verdict, e.g. a CHECKPOINT_SEQ replay guard) is
    // checked BEFORE that same depth gate, so it can be reached by a still-shallow txid
    // whose ordering a pending reorg can still rewrite: today's "stale replay" against a
    // competing anchor can undecide itself once the chain resettles, so treating it as
    // terminal here can drop a reward for an anchor that goes on to verify. Retrying either
    // until the TTL costs a queue slot; dropping either would forfeit a legitimate reward.
    // Every non-verified outcome writes nothing either way, so the safety property does not
    // depend on this choice.
    async drainDeferredRewardAttest(){
        if(this._deferredRewardAttest.size === 0) return;
        for(let [key, e] of [...this._deferredRewardAttest]){
            if(Date.now() - e.at > this.announceRetryTtlMs){
                this._deferredRewardAttest.delete(key);
                logger.warn('StateAnchorPublisher: deferred reward attestation ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without its anchor confirming; dropped (no reward is ' +
                             'derived for an anchor that never landed)');
                continue;
            }
            try {
                // Re-SELECT our OWN checkpoint row (never a cached copy): verifyAnchorOnChain
                // byte-matches the decoded on-chain payload against it.
                let rows = await this.db.getStateCheckpointByChain(String(e.chain), String(e.network), Number(e.blockIndex), Number(e.checkpointSeq));
                if(!rows || rows.length === 0) continue;              // checkpoint gone (reorg): let the TTL clear it
                let v = await this.verifyAnchorOnChain(rows[0], { txid: String(e.txid), version: Number(e.anchorVersion) });
                if(v === 'verified'){
                    // The proven txid goes ONTO the row (doge_anchor_txid): it is what every
                    // downstream re-proof (a peer's XANCREWARD check, the BTC indexer's
                    // getanchorconfirmations check) binds the reward to. `e` also carries the
                    // publisher's federate flag, so the fan-out happens at the confirmed write.
                    //
                    // The entry is dropped only AFTER the write succeeds. Deleting first and
                    // then awaiting made a transient INSERT error a PERMANENT reward forfeit
                    // that logged success: the write swallowed the error, the queue no longer
                    // held the entry, and nothing retried. Retrying is safe and idempotent
                    // (INSERT IGNORE on uq_reward_tuple), the existing announceRetryTtlMs TTL
                    // bounds it, and a persistence failure is logged distinctly from the
                    // re-verification catch below, which is about verifyAnchorOnChain.
                    try {
                        await this.recordRewardAttestation(e.chain, e.network, e.rewardType, Number(e.roundReference),
                                                            Number(e.snapshotBlock), e.publisher, e.attestSigs,
                                                            String(e.txid).toLowerCase(), e);
                    } catch(werr){
                        logger.warn('StateAnchorPublisher: reward attestation ' + key + ' anchor confirmed on DOGE ' +
                                     'but its row FAILED to persist (' + (werr && werr.message) + '); entry retained ' +
                                     'for a later drain (no reward is lost to a transient write error)');
                        continue;
                    }
                    this._deferredRewardAttest.delete(key);
                    logger.info('StateAnchorPublisher: reward attestation ' + key + ' anchor confirmed on DOGE; row written');
                } else if(v === 'rejected:mismatch' || v === 'rejected:version'){
                    this._deferredRewardAttest.delete(key);
                    logger.warn('StateAnchorPublisher: reward attestation ' + key + ' REJECTED on re-verification (' +
                                 v + '); dropped, no reward');
                }
            } catch(err){
                logger.warn('StateAnchorPublisher: reward attestation ' + key +
                             ' re-verification error: ' + (err && err.message));
            }
        }
    }

};
