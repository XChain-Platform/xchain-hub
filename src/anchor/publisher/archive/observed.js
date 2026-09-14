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
 * ANCHOR publisher - observed archive rounds
 *
 * What this hub saw of an archive round (leader, checkpoint identity, membership)
 * kept per batch_seq, because the FINALIZED canonical does not carry it.
 *
 ********************************************************************/

'use strict';

const canonicalForms = require('../canonical_forms.js');

module.exports = {

    // Record that `pubkey` validated as the elected archive leader for `batchSeq`
    // (called from handleSignReq after the election/rank check passes). Stored as
    // a SET because the failover ladder can legitimately unlock more than one rank
    // for the same batch_seq, and this hub may observe successive proposers.
    recordObservedArchiveLeader(batchSeq, pubkey, cpIdentity){
        if(!Number.isFinite(batchSeq) || !pubkey) return;
        let set = this._observedArchiveLeaders.get(batchSeq);
        if(!set){ set = new Set(); this._observedArchiveLeaders.set(batchSeq, set); }
        set.add(String(pubkey).toLowerCase());
        // Stash the batch's checkpoint identity (first observation wins). Identity
        // ONLY (chain/network/block_index/checkpoint_seq) - handleFinalized
        // re-SELECTs our OWN checkpoint row from it before verifying, so a Byzantine
        // wire cp can never inject foreign hashes; a wrong identity just fails to
        // resolve locally and the reward mirror abstains.
        if(cpIdentity && !this._observedArchiveCheckpoints.has(batchSeq))
            this._observedArchiveCheckpoints.set(batchSeq, {
                chain: String(cpIdentity.chain), network: String(cpIdentity.network),
                block_index: Number(cpIdentity.block_index), checkpoint_seq: Number(cpIdentity.checkpoint_seq)
            });
        // Bounded memory: batch_seq is monotonic, so evict the smallest keys from
        // both maps in lockstep.
        while(this._observedArchiveLeaders.size > this._observedArchiveLeadersCap){
            let oldest = null;
            for(let k of this._observedArchiveLeaders.keys()) if(oldest === null || k < oldest) oldest = k;
            if(oldest === null) break;
            this._observedArchiveLeaders.delete(oldest);
            this._observedArchiveCheckpoints.delete(oldest);
            this._observedArchiveContents.delete(oldest);
        }
    },

    isObservedArchiveLeader(batchSeq, pubkey){
        let set = this._observedArchiveLeaders.get(batchSeq);
        return !!set && set.has(String(pubkey || '').toLowerCase());
    },

    // Record the member ids of an archive body this hub verified against its own rows
    // (called from handleSignReq once verifyArchiveAgainstLocal passes, so the parse
    // is already paid for). Keyed by PROPOSER, because the failover ladder legitimately
    // unlocks several ranks for one batch_seq and each proposes its own body. UNIONED
    // across proposals from the same proposer: a round that times out stamps nothing, so
    // _getNextBatchSeq hands the retry the same seq with the rows that accumulated
    // since, and the FINALIZED that follows names the later set.
    recordObservedArchiveContent(batchSeq, pubkey, archive){
        if(!Number.isFinite(batchSeq) || !pubkey || !archive) return;
        let byProposer = this._observedArchiveContents.get(batchSeq);
        if(!byProposer){ byProposer = new Map(); this._observedArchiveContents.set(batchSeq, byProposer); }
        let key = String(pubkey).toLowerCase();
        let entry = byProposer.get(key);
        if(!entry){ entry = { matches: new Set(), calls: new Set(), rewards: new Set() }; byProposer.set(key, entry); }
        for(let m of (archive.matches || []))
            if(m && m.match_id != null) entry.matches.add(String(m.match_id));
        for(let c of (archive.calls || []))
            if(c && c.call_id != null) entry.calls.add(String(c.call_id) + '|' + String(c.phase));
        for(let r of (archive.rewards || []))
            if(r && r.reward_type != null) entry.rewards.add(canonicalForms.archiveRewardKey(r));
        // Bounded on its own terms as well as through the leader map's lockstep evict,
        // so a body recorded for a seq whose leader entry is already gone cannot pin
        // memory.
        while(this._observedArchiveContents.size > this._observedArchiveLeadersCap){
            let oldest = null;
            for(let k of this._observedArchiveContents.keys()) if(oldest === null || k < oldest) oldest = k;
            if(oldest === null) break;
            this._observedArchiveContents.delete(oldest);
        }
    },

    // Name the first row a FINALIZED announces that the archive body we co-signed for
    // this (batch_seq, proposer) does not carry, or null when every announced row is a
    // member. ABSTAINS (null) when we hold no body for that pair: a hub outside the
    // snapshot_block signing set never decompresses one, and decompressing on its behalf
    // would hand every p2p peer a per-message gzip and CPU amplifier for the sake of
    // local bookkeeping.
    finalizedOutsideObservedArchive(batchSeq, sender, matches, calls, rewards){
        let byProposer = this._observedArchiveContents.get(Number(batchSeq));
        let entry = byProposer && byProposer.get(String(sender || '').toLowerCase());
        if(!entry) return null;
        for(let m of (matches || []))
            if(m && m.match_id != null && !entry.matches.has(String(m.match_id)))
                return 'match ' + String(m.match_id).substring(0, 16) + '...';
        for(let c of (calls || []))
            if(c && c.call_id != null && !entry.calls.has(String(c.call_id) + '|' + String(c.phase)))
                return 'call ' + String(c.call_id).substring(0, 16) + '... (' + c.phase + ')';
        for(let r of (rewards || []))
            if(r && r.reward_type != null && !entry.rewards.has(canonicalForms.archiveRewardKey(r)))
                return 'reward ' + String(r.reward_type) + '/#' + String(r.round_number);
        return null;
    },

    // The checkpoint identity we stashed for this batch_seq's archive round (from
    // the SIGN_REQ), or null if we never observed it.
    observedArchiveCheckpoint(batchSeq){
        return this._observedArchiveCheckpoints.get(batchSeq) || null;
    },

    // Verify the checkpoint an archive batch is bound to really landed on DOGE, for
    // the FINALIZED reward gate. Resolves the stashed identity to OUR OWN
    // state_checkpoints row (never the wire), then defers to verifyAnchorOnChain.
    // Returns 'no-checkpoint-id' (never saw the SIGN_REQ) / 'absent-local' (we do
    // not hold the referenced checkpoint) as ABSTAIN reasons, else the
    // verifyAnchorOnChain verdict. `announcedTxid` is the FINALIZED's txid, which is
    // bound into the signed finalizedCanonical and is the txid of the v1 ARCHIVE HEAD
    // (_publishArchive broadcasts the v1 payload first, then the v2 continuation
    // chunks). Binding it, plus the archive-head version set {1}, closes the archive
    // half of XANC-ELECTED-FORGE-1: proving the CHECKPOINT is anchored is not enough,
    // because an elected leader could reference a real-but-different anchored checkpoint
    // and still mirror itself the anchor_archive reward (below the flag-day;
    // at/above it the mirror is retired outright).
    // `expect` overrides the version expectation for callers that run at ALL heights
    // (the back-fill gate passes rejectVersions [0,2], i.e. the archive-head
    // SET {1}); omitted, it keeps the reward gate's exact-v1 expectation below.
    async verifyArchiveCheckpointOnChain(batchSeq, announcedTxid, expect){
        let id = this.observedArchiveCheckpoint(batchSeq);
        if(!id) return 'no-checkpoint-id';
        let rows = await this.db.getStateCheckpointByChain(id.chain, id.network, Number(id.block_index), Number(id.checkpoint_seq));
        if(!rows || rows.length === 0) return 'absent-local';
        if(!announcedTxid) return 'no-txid';
        // Default version 1 stays exact for the REWARD gate: that caller only runs BELOW
        // the archive-reward flag-day (at/above it the FINALIZED reward mirror is retired
        // outright), and every pre-flag-day archive head is a v1. The back-fill
        // gate runs at every height and passes its own archive-head SET instead.
        return this.verifyAnchorOnChain(rows[0],
            Object.assign({ txid: String(announcedTxid) }, expect || { version: 1 }));
    }

};
