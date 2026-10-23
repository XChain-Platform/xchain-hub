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
const { serialPass } = require('./drain_serial.js');
const {
    ATTESTED_VERSIONS, REWARD_FAMILY_VERSIONS, isRewardCandidateRow, judgeAnchors
} = require('../anchor_proof_binding.js');
const { activeAt } = require('../../consensus/gate_registry.js');
const { hasLegacyByteRow, isPinnedEntry, legacyPinGateProven } = require('./legacy_reward_pin.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The archive fold term ends legacy anchor_archive rewards where both gates are active.
const ANCHOR_ARCHIVE_FOLD_TERM_GATE = 'anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION';
const ANCHOR_FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

// Is the archive fold term in force for this network, chain domain and height?
function archiveTermActive(network, coin, height){
    let termActive = activeAt(ANCHOR_ARCHIVE_FOLD_TERM_GATE, network, coin, height, null);
    let foldActive = activeAt(ANCHOR_FOLD_GATE, network, coin, height, null);
    return termActive && foldActive;
}

// The indexer proof client's archiveRowTerminated: a candidate archive row landed on DOGE past the term.
function archiveRowTerminated(a, e){
    if(String(e.rewardType) !== 'anchor_archive') return false;
    if(!REWARD_FAMILY_VERSIONS.archive.includes(Number(a.version))) return false;
    let network = String(e.network || '');
    let publisher = String(e.publisher || '').toLowerCase();
    if(!isRewardCandidateRow(a, network, publisher)) return false;
    return archiveTermActive(network, 'DOGE', a.block_index_doge);
}

// Judge anchors as the indexer does before it mints: the BTC derive refuses an anchor_archive
// reward whose snapshot block is past the term, and the DOGE proof client screens terminated
// archive rows, so a screened-only set that would stay unknown is rejected instead.
function judgeDrainAnchors(anchors, e){
    if(String(e.rewardType) === 'anchor_archive' &&
       archiveTermActive(String(e.network || ''), 'BTC', e.snapshotBlock)) return 'rejected';
    let screened = false;
    let proofRows = anchors.filter((a) => {
        if(!archiveRowTerminated(a, e)) return true;
        screened = true;
        return false;
    });
    let verdict = judgeAnchors(proofRows, e);
    // Screened archive rows still count as attested evidence
    if(screened && verdict === 'unknown' &&
       !proofRows.some(a => ATTESTED_VERSIONS.includes(Number(a.version)))) return 'rejected';
    return verdict;
}

// Hard stop on the getanchorconfirmations page walk. It must equal MAX_ANCHOR_PAGES in the
// indexer's anchor_proof_client/page_walk.js, and reward_drain_paging.test.js pins the two.
const MAX_ANCHOR_PAGES = 25;

// Read a page cursor the way the indexer's walk does: only a number or a digit string.
// Number() alone would turn null, '' or false into 0 and restart a cursor-less walk.
function parseAnchorCursor(raw){
    return (typeof raw === 'number' || (typeof raw === 'string' && /^[0-9]+$/.test(raw))) ? Number(raw) : NaN;
}

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
    // Durable across a restart: each entry, XANCPUB sigs included, is journaled to
    // consensus_state until the drain settles it, and start() restores the queue from
    // there (reward_journal/journal.js), so a restart inside the window forfeits nothing.
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
            this.dropDeferredRewardAttest(oldest);
            logger.warn('StateAnchorPublisher: deferred reward-attestation queue full (' + this.announceQueueMax +
                         '); dropped the oldest entry ' + oldest);
        }
        let entry = Object.assign({}, e, { at: Date.now() });
        this._deferredRewardAttest.set(key, entry);
        this.persistDeferredRewardAttest(key, entry);
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
    //
    // Passes never overlap, for the reason given at drainDeferredBundleDone; this drain
    // drops an entry only after its write, so an overlap here would also re-send XANCREWARD.
    drainDeferredRewardAttest(){
        return serialPass(this, '_rewardAttestDrain', () => this.runRewardAttestDrain());
    },

    // Does the mined txid bind to this entry's (network, snapshot_block, publisher)? The
    // checkpoint byte-match above proves the txid carries OUR checkpoint, not that it is
    // the anchor the reward tuple names: a relayed tuple can pair a real txid with another
    // publisher or round. The rule is the indexer's judgeAnchors, read from the byte twin
    // of anchor_proof_client/binding.js and never re-derived here. An anchor_bundle entry
    // whose round_reference differs from its snapshot_block is counted, since the bundle
    // round IS its snapshot block and judgeAnchors can never bind such a tuple.
    // judgeDrainAnchors adds the indexer's archive fold-term screen around that rule.
    // An anchor_archive entry past the BTC-side term is rejected before any DOGE call, as the indexer never mints it.
    // With no DOGE indexer wired, or with a response that omits the anchor rows, there is
    // no binding evidence. Feed that empty set through judgeAnchors so it remains unknown
    // rather than inheriting verifyAnchorOnChain's checkpoint-only verdict.
    // Returns 'verified' | 'rejected' | 'unknown'. `minConfirmations` defaults to the
    // drain's burial depth; the adoption ownership check passes 0.
    // `screenLegacy` true applies the indexer's LEGACY_ANCHOR_REWARD_PIN drop; only the write drain asks.
    async drainBindingVerdict(e, minConfirmations, screenLegacy){
        if(e.rewardType === 'anchor_bundle' && Number(e.roundReference) !== Number(e.snapshotBlock)){
            this._rewardBundleRoundMismatch = (this._rewardBundleRoundMismatch || 0) + 1;
            logger.warn('StateAnchorPublisher: anchor_bundle reward entry with round_reference ' + e.roundReference +
                         ' <> snapshot_block ' + e.snapshotBlock + ' (' + this._rewardBundleRoundMismatch + ' seen)');
        }
        let expect = {
            rewardType: e.rewardType, network: e.network, publisher: e.publisher,
            roundReference: Number(e.roundReference), snapshotBlock: Number(e.snapshotBlock),
            minConfirmations: (minConfirmations != null) ? Number(minConfirmations) : this.dogeConfirmations
        };
        if(String(expect.rewardType) === 'anchor_archive' && archiveTermActive(String(expect.network || ''), 'BTC', expect.snapshotBlock)) return 'rejected';
        let txid = String(e.txid).toLowerCase();
        let anchors = [];
        let after = null;
        for(let page = 0; page < MAX_ANCHOR_PAGES; page++){
            let params = { txid: txid };
            if(after !== null) params.after_action_index = after;
            let r;
            try {
                r = await this.indexerCall('DOGE', 'getanchorconfirmations', params);
            } catch(err){
                if(err && /^no indexer url for /.test(err.message)) return await this.judgeDrainEntry([], expect, screenLegacy);
                throw err;
            }
            if(r && r.exists && r.anchors === undefined) return await this.judgeDrainEntry([], expect, screenLegacy);
            if(!r || !Array.isArray(r.anchors)) return 'unknown';
            // Defer when the FIRST page shows no anchor: the DOGE indexer may simply be behind.
            // A later page may be empty, and the rows already walked are judged, as the indexer does.
            if(page === 0 && (!r.exists || r.anchors.length === 0)) return 'unknown';
            anchors = anchors.concat(r.anchors);
            if(r.truncated !== true) return await this.judgeDrainEntry(anchors, expect, screenLegacy);
            // Defer when a truncated page gives no usable cursor, or one that does not advance.
            let next = parseAnchorCursor(r.next_after_action_index);
            if(!Number.isInteger(next) || next < 0 || (after !== null && next <= after)){
                logger.warn('StateAnchorPublisher: ' + txid + ' reported truncated with an unusable page cursor (' +
                            r.next_after_action_index + '); binding left undecided');
                return 'unknown';
            }
            after = next;
        }
        // Refuse to judge a set still truncated after the page bound (a faulty or hostile peer).
        logger.error('StateAnchorPublisher: ' + txid + ' still truncated after ' + MAX_ANCHOR_PAGES +
                     ' pages; binding left undecided');
        return 'unknown';
    },

    // judgeDrainAnchors, dropping the pre-restart bytes 6 and 7 as the indexer does once the
    // LEGACY_ANCHOR_REWARD_PIN gate is proven on. Unproven, the bytes still bind and nothing is forfeit.
    async judgeDrainEntry(anchors, expect, screenLegacy){
        if(screenLegacy === true && hasLegacyByteRow(anchors) && await this.legacyPinGateOn(expect.network))
            return judgeDrainAnchors(anchors, Object.assign({}, expect, { legacyDropped: true }));
        return judgeDrainAnchors(anchors, expect);
    },

    // Is LEGACY_ANCHOR_REWARD_PIN proven on for this network (legacy_reward_pin.js)? False, after a
    // warning, when this hub's BTC indexer cannot prove it.
    async legacyPinGateOn(network){
        if(!this._legacyPinProvenFrom) this._legacyPinProvenFrom = new Map();
        try {
            return await legacyPinGateProven((coin, method, params) => this.indexerCall(coin, method, params),
                String(network || ''), this._legacyPinProvenFrom, Math.floor(Date.now() / 1000));
        } catch(err){
            logger.warn('StateAnchorPublisher: LEGACY_ANCHOR_REWARD_PIN not proven from the BTC indexer (' +
                        (err && err.message) + '); legacy anchor bytes still bind');
            return false;
        }
    },

    // One pass of the drain above, over a copy of the queue taken when the pass starts.
    async runRewardAttestDrain(){
        await this.restoreDeferredRewardAttest();
        if(this._deferredRewardAttest.size === 0) return;
        for(let [key, e] of [...this._deferredRewardAttest]){
            if(Date.now() - e.at > this.announceRetryTtlMs){
                await this.dropDeferredRewardAttest(key);
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
                if(v === 'verified') await this.drainVerifiedRewardAttest(key, e);
                else if(v === 'rejected:mismatch' || v === 'rejected:version'){
                    await this.dropDeferredRewardAttest(key);
                    logger.warn('StateAnchorPublisher: reward attestation ' + key + ' REJECTED on re-verification (' +
                                 v + '); dropped, no reward');
                }
            } catch(err){
                logger.warn('StateAnchorPublisher: reward attestation ' + key +
                             ' re-verification error: ' + (err && err.message));
            }
        }
    },

    // The drain step for an entry whose anchor verified on chain: bind it, screen the legacy pin,
    // then write its row. Throws reach the drain's re-verification catch.
    async drainVerifiedRewardAttest(key, e){
        let bound = await this.drainBindingVerdict(e, undefined, true);
        if(bound === 'rejected'){
            await this.dropDeferredRewardAttest(key);
            logger.warn('StateAnchorPublisher: reward attestation ' + key + ' txid does not bind to ' +
                         '(network, snapshot_block, publisher); dropped, no reward');
            return;
        }
        if(bound !== 'verified') return;   // undecided: retained until the TTL
        // A tuple the indexer pins is never minted again once the gate is on, so write nothing for it.
        if(isPinnedEntry(e) && await this.legacyPinGateOn(e.network)){
            await this.dropDeferredRewardAttest(key);
            logger.warn('StateAnchorPublisher: reward attestation ' + key + ' is a LEGACY_ANCHOR_REWARD_PIN ' +
                         'tuple; dropped, no reward');
            return;
        }
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
        // re-verification catch in the drain, which is about verifyAnchorOnChain.
        try {
            await this.recordRewardAttestation(e.chain, e.network, e.rewardType, Number(e.roundReference),
                                                Number(e.snapshotBlock), e.publisher, e.attestSigs,
                                                String(e.txid).toLowerCase(), e);
        } catch(werr){
            logger.warn('StateAnchorPublisher: reward attestation ' + key + ' anchor confirmed on DOGE ' +
                         'but its row FAILED to persist (' + (werr && werr.message) + '); entry retained ' +
                         'for a later drain (no reward is lost to a transient write error)');
            return;
        }
        await this.dropDeferredRewardAttest(key);
        logger.info('StateAnchorPublisher: reward attestation ' + key + ' anchor confirmed on DOGE; row written');
    },

    // Record the reward for an adopted bundle only when the indexer binds it to THIS hub
    // (our own lost-ACK send), since no other hub ever writes that attestation row. Never
    // throws: the caller announces BUNDLE_DONE right after, and peers must hear it.
    async recordAdoptedBundleReward(group, me, attested, attestSigs, network, snapshotBlock, txid, anchorVersion){
        try {
            if(!attested || !me){
                logger.info('StateAnchorPublisher: adopted existing bundle for ' + network + ' @ ' +
                            snapshotBlock + '; reward push skipped');
                return;
            }
            let owner = await this.adoptedBundleOwnership(txid, network, snapshotBlock, me);
            if(owner === 'ours'){
                logger.info('StateAnchorPublisher: adopted our OWN bundle for ' + network + ' @ ' + snapshotBlock +
                            ' (lost ACK, txid ' + txid + '); recording its reward attestation');
                this.recordOwnBundleReward(group, me, attested, attestSigs, network, snapshotBlock, txid, anchorVersion);
            } else if(owner === 'peer'){
                logger.info('StateAnchorPublisher: adopted a peer bundle for ' + network + ' @ ' +
                            snapshotBlock + '; reward push skipped');
            } else {
                this._adoptedOwnershipUndetermined = (this._adoptedOwnershipUndetermined || 0) + 1;
                logger.warn('StateAnchorPublisher: adopted bundle ' + txid + ' for ' + network + ' @ ' + snapshotBlock +
                            ' has no readable publisher binding; reward skipped (' +
                            this._adoptedOwnershipUndetermined + ' undetermined adoptions)');
            }
        } catch(e){
            logger.warn('StateAnchorPublisher: adopted-bundle reward check failed for ' + network + ' @ ' +
                        snapshotBlock + ': ' + (e && e.message));
        }
    },

    // Whose bundle is the adopted txid? The indexer's publisher binding, read through the
    // drain's own judgeAnchors rule at any depth: 'ours' | 'peer' | 'undetermined'.
    async adoptedBundleOwnership(txid, network, snapshotBlock, me){
        let verdict;
        try {
            verdict = await this.drainBindingVerdict({
                rewardType: 'anchor_bundle', network: network, publisher: String(me).toLowerCase(),
                roundReference: snapshotBlock, snapshotBlock: snapshotBlock, txid: txid
            }, 0);
        } catch(_e){
            return 'undetermined';
        }
        if(verdict === 'verified') return 'ours';
        if(verdict === 'rejected') return 'peer';
        return 'undetermined';
    }

};
