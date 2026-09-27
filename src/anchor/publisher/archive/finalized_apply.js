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
 * ANCHOR publisher - applying FINALIZED
 *
 * Stamping an announced archive into our own rows, and the deferral queue that
 * holds an announcement until its head is buried.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const ar = require('../../../consensus/gates/anchor_reward_gate.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // Apply a FINALIZED whose archive head is confirmed on DOGE at depth: stamp the
    // announced statuses + txid, then mirror the leader's reward. Shared by the
    // immediate-receipt path and the deferred drain, so an announcement that arrives at
    // 0 confirmations lands EXACTLY the same rows as one that arrives already buried.
    async applyFinalized(d, sender, calls, rewards, quorumRows){
        const q = quorumRows || this.finalizedQuorumRows(d);
        await this.backfillBatch(Number(d.batch_seq), d.matches, d.txid ? String(d.txid) : null,
                                  calls, rewards, q.bridges, q.policies, q.checkpoints, q.prices, q.tombstones);
        // Mirror the leader's archive-publish reward (sender is signature-
        // verified) so all hubs hold the same reward rows (same rail as the
        // BUNDLE_DONE mirror). Only a COMPLETE publish earns it (the leader skips
        // its own reward on lost chunks and marks rows __partial__).
        let partial = (d.matches || []).some(m => m && m.status === '__partial__') ||
                      calls.some(c => c && c.status === '__partial__');
        if(d.txid && !partial && Number.isFinite(Number(d.snapshot_block))){
            // d.snapshot_block is an unsigned wire field used as the mirrored
            // reward's block-scoped source-resolution key. Bound it by the same
            // re-derivation verifyArchiveAgainstLocal applies to archived reward
            // rows: the credited pubkey must hold oracle_publish AT that block
            // (a fabricated block index fails the membership resolution).
            let setAtSnap = await this.getActiveOraclePublishPubkeys(Number(d.snapshot_block));
            if(!setAtSnap.includes(sender)){
                logger.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') sender not in the ' +
                             'oracle_publish set at announced snapshot_block ' + d.snapshot_block +
                             '; NOT mirroring the archive reward');
            } else {
                // XANC-REWARD-THEFT-1 (archive half, LIVE): anchor_archive is NOT
                // retired by the anchor-reward flag-day (RewardTracker only derives
                // anchor_<CHAIN>), so a forged mirror mints COLLECT-spendable XCHAIN
                // TODAY. Gate the mirror on the batch's checkpoint being really
                // anchored on DOGE at depth: an elected-yet-Byzantine leader that
                // announces a FINALIZED for an archive it never published earns
                // nothing. ABSTAIN (no mirror) on an unverifiable / absent / shallow
                // anchor - the elected leader records its own reward directly, so a
                // co-signer's mirror is redundant (INSERT IGNORE-deduped) and the
                // rows re-archive under a fresh seq if the checkpoint later confirms.
                // d.txid is bound into the signed finalizedCanonical and names the v1
                // archive head, so it is passed through to bind the specific archive
                // transaction, not merely "some anchor for this checkpoint".
                // At/above the archive-reward flag-day the reward is DERIVED
                // on-chain from the v1 publisher attestation; the FINALIZED does not say whether
                // the leader's publish carried it (a count-0 tail earns nothing), so
                // mirroring here could credit a reward no live indexer derives (fork on
                // recovery). Below the flag-day the mirror remains the only peer rail.
                // Gate and record on the CHECKPOINT's network, never
                // this.network. The XANCFIN wire carries no network, so resolve it from
                // the locally stashed identity; re-deriving from the hub's own network
                // double-credited on an unscoped hub (network===''), forking the
                // COLLECT-spendable rail live-vs-recovered. When no local identity is
                // stashed, verifyArchiveCheckpointOnChain returns 'no-checkpoint-id'
                // and nothing is recorded, so the fallback only feeds the flag-day gate.
                let cpId  = this.observedArchiveCheckpoint(Number(d.batch_seq));
                let cpNet = cpId ? String(cpId.network) : this.network;
                let archiveVerified = ar.isArchiveRewardActive(Number(d.snapshot_block), cpNet)
                    ? 'flag-day-derived (mirror retired)'
                    : await this.verifyArchiveCheckpointOnChain(Number(d.batch_seq), String(d.txid));
                if(archiveVerified === 'verified')
                    this.recordReward('anchor_archive', Number(d.batch_seq), sender, Number(d.snapshot_block), cpNet);
                else
                    logger.warn('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive checkpoint ' +
                                 'not on-chain verified (' + archiveVerified + '); NOT mirroring the archive reward');
            }
        }
    },

    // Queue an authenticated FINALIZED whose archive head is not yet buried. Keyed on
    // the announcement's full identity INCLUDING the txid, so two competing txids for
    // one batch are tracked separately and whichever actually confirms wins. Queuing
    // grants no authority: the entry is re-verified in full before it can stamp.
    deferFinalized(d, sender, calls, rewards, quorumRows, reason){
        if(reason === undefined){
            reason = quorumRows;
            quorumRows = this.finalizedQuorumRows(d);
        }
        let key = [Number(d.batch_seq), String(d.txid), String(sender)].join('|');
        if(this._deferredFinalized.has(key)) return;
        // Bounded: drop the OLDEST entry rather than the new one (Map preserves
        // insertion order), so a flood cannot pin the queue on stale announcements.
        if(this._deferredFinalized.size >= this.announceQueueMax){
            let oldest = this._deferredFinalized.keys().next().value;
            this._deferredFinalized.delete(oldest);
            logger.warn('StateAnchorPublisher: deferred FINALIZED queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        this._deferredFinalized.set(key, {
            d: d, sender: sender, calls: calls, rewards: rewards,
            quorumRows: quorumRows, at: Date.now()
        });
        logger.info('StateAnchorPublisher: FINALIZED (batch ' + d.batch_seq + ') archive head not yet buried (' +
                    reason + '); seq staged under the __partial__ sentinel, queued for re-verification (' +
                    this._deferredFinalized.size + ' pending)');
    },

    // Re-verify queued FINALIZED announcements and stamp the ones whose archive head has
    // since been buried. Runs on the announceRetryMs timer and at the head of every
    // flush, alongside the BUNDLE_DONE drain. Authenticity (membership, signature over the
    // txid-bearing canonical, observed-leader) was settled at receipt and cannot change;
    // what is re-checked is the head's on-chain depth, plus the announced CONTENT, which
    // can move (a row may have advanced status while the entry sat in the queue).
    async drainDeferredFinalized(){
        if(this._deferredFinalized.size === 0) return;
        for(let [key, entry] of [...this._deferredFinalized]){
            let d = entry.d;
            if(Date.now() - entry.at > this.announceRetryTtlMs){
                this._deferredFinalized.delete(key);
                logger.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' expired after ' +
                             this.announceRetryTtlMs + 'ms without confirming; dropping (the staged rows are ' +
                             'still archive-eligible and re-archive under a fresh seq)');
                continue;
            }
            try {
                let v = await this.verifyArchiveCheckpointOnChain(Number(d.batch_seq), String(d.txid),
                                                                   { rejectVersions: [0, 2] });
                if(v === 'verified'){
                    this._deferredFinalized.delete(key);
                    if(!(await this.verifyFinalizedAgainstLocal(
                        d.matches, entry.calls, entry.rewards, entry.quorumRows))){
                        logger.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' confirmed on DOGE but its ' +
                                     'announced content no longer matches our DB; dropping the back-fill');
                        continue;
                    }
                    await this.applyFinalized(d, entry.sender, entry.calls, entry.rewards, entry.quorumRows);
                    logger.info('StateAnchorPublisher: deferred FINALIZED ' + key + ' confirmed on DOGE; stamped');
                } else if(String(v).startsWith('rejected')){
                    this._deferredFinalized.delete(key);
                    logger.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' REJECTED on re-verification (' +
                                 v + '); dropped');
                }
            } catch(e){
                logger.warn('StateAnchorPublisher: deferred FINALIZED ' + key + ' re-verification error: ' + (e && e.message));
            }
        }
    },

    // FINALIZED content re-verification (receiver side; the XANCFIN canonical
    // does not commit to the announced id/status lists). For every announced
    // row this hub holds locally, the announced status must be the '__partial__'
    // sentinel (keeps the row archive-eligible; benign) or byte-equal our row's
    // current status. A row we do NOT hold passes: its UPDATE is a no-op and a
    // late joiner has no copy of earlier history. Announced rewards must at
    // least be anchor-rail rows (same bar verifyArchiveAgainstLocal sets);
    // their UPDATE only ever stamps batch_seq on rows we already derived.
    async verifyFinalizedAgainstLocal(matches, calls, rewards, quorumRows){
        for(let m of (matches || [])){
            if(!m || m.match_id == null) return false;
            if(m.status === '__partial__') continue;
            let rows = await this.db.getCrossChainMatchByMatchId(m.match_id);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(m.status)){
                logger.warn('StateAnchorPublisher: FINALIZED match ' + String(m.match_id).substring(0, 16) +
                             "... announces status '" + m.status + "' but our row holds '" + rows[0].status + "'");
                return false;
            }
        }
        for(let c of (calls || [])){
            if(!c || c.call_id == null) return false;
            if(c.status === '__partial__') continue;
            let rows = await this.db.getCrossChainCallByCallIdAndPhase(c.call_id, c.phase);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(c.status)){
                logger.warn('StateAnchorPublisher: FINALIZED call ' + String(c.call_id).substring(0, 16) +
                             "... (" + c.phase + ") announces status '" + c.status + "' but our row holds '" + rows[0].status + "'");
                return false;
            }
        }
        for(let r of (rewards || [])){
            if(!r || !/^anchor_[A-Za-z_]+$/.test(String(r.reward_type || ''))){
                logger.warn('StateAnchorPublisher: FINALIZED reward list carries a non-anchor reward_type; rejecting');
                return false;
            }
        }
        const q = quorumRows || { bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [] };
        for(const b of q.bridges){
            if(!b || b.transfer_id == null || b.status == null) return false;
            if(b.status === '__partial__') continue;
            const rows = await this.db.getBridgeTransferByTransferId(b.transfer_id);
            if(rows && rows.length > 0 && String(rows[0].status) !== String(b.status)) return false;
        }
        for(const p of q.policies) if(!p || p.snapshot_id == null) return false;
        for(const c of q.checkpoints)
            if(!c || c.chain == null || c.network == null || c.checkpoint_seq == null) return false;
        for(const p of q.prices){
            if(!p || p.round_number == null || p.coin_pair == null || p.status == null ||
               p.batch_block_time == null || p.proof_sha == null) return false;
            if(p.status === '__partial__') continue;
            const rows = await this.db.findPriceSnapshotsForRound(Number(p.round_number));
            const held = (rows || []).find(r => String(r.coin_pair) === String(p.coin_pair));
            const proofSha = held && crypto.createHash('sha256').update(String(held.consensus_proof)).digest('hex');
            if(held && (String(held.status) !== String(p.status) ||
                        Number(held.batch_block_time) !== Number(p.batch_block_time) ||
                        proofSha !== String(p.proof_sha))) return false;
        }
        for(const t of q.tombstones)
            if(!t || t.round_number == null || t.coin_pair == null) return false;
        return true;
    },

    finalizedCanonical(batchSeq, txid, count){
        return 'XANCFIN|' + String(batchSeq) + '|' + String(txid || '') + '|' + String(count);
    }

};
