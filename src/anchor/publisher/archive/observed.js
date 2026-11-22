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
const { observedListIds, firstListOutside } = require('./list/list_observed.js');

function sameNumber(a, b){
    const numericType = value => typeof value === 'number' || typeof value === 'string';
    if(!numericType(a) || !numericType(b)) return false;
    if((typeof a === 'string' && !a.trim()) || (typeof b === 'string' && !b.trim())) return false;
    const left = Number(a);
    const right = Number(b);
    return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right;
}

function foldArchiveHeadVerdict(pub, row, observed, announced){
    if(!row || !row.exists) return 'absent';
    if(/^invalid/i.test(String(row.status || ''))) return 'rejected:status';
    if(Number(row.version) !== 3) return 'rejected:version';
    if(!row.txid || String(row.txid).toLowerCase() !== String(announced.txid).toLowerCase())
        return 'rejected:txid';
    if(!sameNumber(row.match_batch_seq, announced.batch_seq)) return 'rejected:batch-seq';
    if(!sameNumber(row.match_count, observed.match_count)) return 'rejected:match-count';
    if(String(row.batch_crc32 || '').toLowerCase() !== observed.batch_crc32)
        return 'rejected:batch-crc32';
    if(!sameNumber(row.total_chunks, observed.total_chunks)) return 'rejected:total-chunks';
    if(String(row.checkpoint_chain) !== observed.cp.chain ||
       String(row.checkpoint_network) !== observed.cp.network ||
       !sameNumber(row.block_index, observed.cp.block_index) ||
       !sameNumber(row.checkpoint_seq, observed.cp.checkpoint_seq)) return 'rejected:checkpoint';
    if(!(Number(row.confirmations) >= pub.dogeConfirmations)) return 'shallow';
    return 'verified';
}

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
            if(this._observedFoldArchiveKeys) this._observedFoldArchiveKeys.delete(oldest);
        }
    },

    isObservedArchiveLeader(batchSeq, pubkey){
        let set = this._observedArchiveLeaders.get(batchSeq);
        return !!set && set.has(String(pubkey || '').toLowerCase());
    },

    hasObservedArchiveContent(batchSeq, pubkey){
        const byProposer = this._observedArchiveContents.get(Number(batchSeq));
        return !!byProposer && byProposer.has(String(pubkey || '').toLowerCase());
    },

    recordObservedFoldArchiveKey(batchSeq, pubkey, signed){
        if(!Number.isFinite(batchSeq) || !pubkey || !signed || !signed.cp) return;
        if(!/^[0-9a-f]{8}$/.test(String(signed.batchCrc32 || ''))) return;
        if(!this._observedFoldArchiveKeys) this._observedFoldArchiveKeys = new Map();
        let byProposer = this._observedFoldArchiveKeys.get(batchSeq);
        if(!byProposer){
            byProposer = new Map();
            this._observedFoldArchiveKeys.set(batchSeq, byProposer);
        }
        byProposer.set(String(pubkey).toLowerCase(), {
            cp: {
                chain: String(signed.cp.chain), network: String(signed.cp.network),
                block_index: Number(signed.cp.block_index),
                checkpoint_seq: Number(signed.cp.checkpoint_seq)
            },
            batch_crc32: String(signed.batchCrc32).toLowerCase(),
            match_count: Number(signed.matchCount), total_chunks: Number(signed.totalChunks)
        });
    },

    observedFoldArchiveKey(batchSeq, pubkey){
        if(!this._observedFoldArchiveKeys) return null;
        const byProposer = this._observedFoldArchiveKeys.get(Number(batchSeq));
        return byProposer && byProposer.get(String(pubkey || '').toLowerCase()) || null;
    },

    // Record the member ids of an archive body this hub verified against its own rows
    // (called from handleSignReq once verifyArchiveAgainstLocal passes, so the parse
    // is already paid for). Keyed by PROPOSER, because the failover ladder legitimately
    // unlocks several ranks for one batch_seq and each proposes its own body. UNIONED
    // across proposals from the same proposer: a round that times out stamps nothing, so
    // getNextBatchSeq hands the retry the same seq with the rows that accumulated
    // since, and the FINALIZED that follows names the later set.
    recordObservedArchiveContent(batchSeq, pubkey, archive){
        if(!Number.isFinite(batchSeq) || !pubkey || !archive) return;
        let byProposer = this._observedArchiveContents.get(batchSeq);
        if(!byProposer){ byProposer = new Map(); this._observedArchiveContents.set(batchSeq, byProposer); }
        let key = String(pubkey).toLowerCase();
        let entry = byProposer.get(key);
        if(!entry){
            entry = {
                matches: new Set(), calls: new Set(), rewards: new Set(),
                bridges: new Set(), policies: new Set(), checkpoints: new Set(),
                prices: new Set(), tombstones: new Set(), lists: new Set()
            };
            byProposer.set(key, entry);
        }
        for(let m of (archive.matches || []))
            if(m && m.match_id != null) entry.matches.add(String(m.match_id));
        for(let c of (archive.calls || []))
            if(c && c.call_id != null) entry.calls.add(String(c.call_id) + '|' + String(c.phase));
        for(let r of (archive.rewards || []))
            if(r && r.reward_type != null) entry.rewards.add(canonicalForms.archiveBodyRewardKey(r));
        for(const b of (archive.bridge_transfers || []))
            if(b && b.transfer_id != null) entry.bridges.add(String(b.transfer_id));
        for(const p of (archive.policy_snapshots || []))
            if(p && p.snapshot_id != null) entry.policies.add(String(p.snapshot_id));
        for(const c of (archive.state_checkpoints || []))
            if(c && c.chain != null && c.network != null && c.checkpoint_seq != null)
                entry.checkpoints.add([c.chain, c.network, c.checkpoint_seq].map(String).join('|'));
        for(const p of (archive.price_snapshots || []))
            if(p && p.round_number != null && p.coin_pair != null)
                entry.prices.add([p.round_number, p.coin_pair].map(String).join('|'));
        for(const t of (archive.price_tombstones || []))
            if(t && t.round_number != null && t.coin_pair != null)
                entry.tombstones.add([t.round_number, t.coin_pair].map(String).join('|'));
        for(const id of observedListIds(archive)) entry.lists.add(id);
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
    finalizedOutsideObservedArchive(batchSeq, sender, matches, calls, rewards,
                                    bridges, policies, checkpoints, prices, tombstones, lists){
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
            if(r && r.reward_type != null && !entry.rewards.has(canonicalForms.finalizedRewardKey(r)))
                return 'reward ' + String(r.reward_type) + '/#' + String(r.round_number);
        for(const b of (bridges || []))
            if(b && b.transfer_id != null && !entry.bridges.has(String(b.transfer_id)))
                return 'bridge ' + String(b.transfer_id).substring(0, 16) + '...';
        for(const p of (policies || []))
            if(p && p.snapshot_id != null && !entry.policies.has(String(p.snapshot_id)))
                return 'policy ' + String(p.snapshot_id).substring(0, 16) + '...';
        for(const c of (checkpoints || []))
            if(c && !entry.checkpoints.has([c.chain, c.network, c.checkpoint_seq].map(String).join('|')))
                return 'checkpoint ' + String(c.chain) + '/' + String(c.checkpoint_seq);
        for(const p of (prices || []))
            if(p && !entry.prices.has([p.round_number, p.coin_pair].map(String).join('|')))
                return 'price ' + String(p.round_number) + '/' + String(p.coin_pair);
        for(const t of (tombstones || []))
            if(t && !entry.tombstones.has([t.round_number, t.coin_pair].map(String).join('|')))
                return 'tombstone ' + String(t.round_number) + '/' + String(t.coin_pair);
        const missingList = firstListOutside(entry.lists, lists);
        if(missingList) return missingList;
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
    // (publishArchive broadcasts the v1 payload first, then the v2 continuation
    // chunks). Binding it, plus the archive-head version set {1}, closes the archive
    // half of XANC-ELECTED-FORGE-1: proving the CHECKPOINT is anchored is not enough,
    // because an elected leader could reference a real-but-different anchored checkpoint
    // and still mirror itself the anchor_archive reward (below the flag-day;
    // at/above it the mirror is retired outright).
    // `expect` overrides the version expectation for callers that run at all heights.
    // The back-fill gate probes exact v1 before exact v3; omitted, this keeps the
    // reward gate's exact-v1 expectation below.
    async verifyArchiveCheckpointOnChain(batchSeq, announcedTxid, expect){
        let id = this.observedArchiveCheckpoint(batchSeq);
        if(!id) return 'no-checkpoint-id';
        return this.verifyArchiveIdentityOnChain(id, announcedTxid, expect);
    },

    async verifyArchiveIdentityOnChain(id, announcedTxid, expect){
        let rows = await this.db.getStateCheckpointByChain(id.chain, id.network, Number(id.block_index), Number(id.checkpoint_seq));
        if(!rows || rows.length === 0) return 'absent-local';
        if(!announcedTxid) return 'no-txid';
        // Default version 1 stays exact for the REWARD gate: that caller only runs BELOW
        // the archive-reward flag-day (at/above it the FINALIZED reward mirror is retired
        // outright), and every pre-flag-day archive head is a v1. The back-fill
        // gate runs at every height and passes each supported head version explicitly.
        return this.verifyAnchorOnChain(rows[0],
            Object.assign({ txid: String(announcedTxid) }, expect || { version: 1 }));
    },

    // Probe the announced transaction as a legacy v1 head first. A stale fold key can
    // remain after a co-signed archive exceeded the v3 head budget and was omitted, so
    // the cache alone cannot select the on-chain version. Only an actual v3 wrapper
    // needs the author-free content-key archive row from the body this hub co-signed.
    async verifyFinalizedArchiveOnChain(d, sender){
        const batchSeq = Number(d.batch_seq);
        const legacy = await this.verifyArchiveCheckpointOnChain(
            batchSeq, String(d.txid), { version: 1 });
        if(legacy === 'verified') return legacy;
        if(legacy !== 'absent' && legacy !== 'absent:other-anchor') return legacy;
        const fold = this.observedFoldArchiveKey(batchSeq, sender);
        const id = fold ? fold.cp : this.observedArchiveCheckpoint(batchSeq);
        if(!id) return legacy;
        const wrapper = await this.verifyArchiveIdentityOnChain(id, String(d.txid), { version: 3 });
        if(wrapper !== 'verified') return wrapper;
        if(!fold) return 'rejected:unbound-fold';
        const ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) return 'no-indexer';
        let row;
        try {
            row = await this.indexerCall('DOGE', 'getarchiveanchor', {
                chain: fold.cp.chain, network: fold.cp.network,
                block_index: fold.cp.block_index, checkpoint_seq: fold.cp.checkpoint_seq,
                batch_crc32: fold.batch_crc32, match_count: fold.match_count
            });
        } catch(_e){
            return 'unreachable';
        }
        return foldArchiveHeadVerdict(this, row, fold, d);
    }

};
