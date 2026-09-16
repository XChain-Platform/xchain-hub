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
 * ANCHOR publisher - archived row shapes
 *
 * The canonical forms of an archived match, call and checkpoint, the quorum check
 * over their signatures, the batch sequence and the crc32 the archive commits to.
 *
 ********************************************************************/

'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { bftQuorumOrSingle } = require('../../../lib/bft_quorum.js');
const ValidatorIdentity = require('../../../validators/identity.js');
const swq = require('../../../stake_weighted_quorum.js');
const eq = require('../../../equivocation_header.js');
const ccr = require('../../../cross_chain_royalty_activation.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // XMATCH canonical: byte-identical to CrossChainDexEngine.canonicalMatch /
    // the indexer's cross_settle.canonical (kept local so archive verification
    // never depends on the DEX engine being constructed).
    matchCanonical(m){
        let raw = [
            'XMATCH', m.match_id, String(m.snapshot_block),
            m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
            m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
            String(m.effective_time), m.network || '',
            m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
            m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')
        ].join('|');
        // Cross-chain royalty legs ride the signed match at/above the CROSS_CHAIN_ROYALTY
        // flag-day; below it the canonical is byte-identical to the legacy format.
        if(ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network))
            raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
        // EQUIV (WI-2 bump 2): VIEW = the archived row's finalizing_view. TAG=XDEX,
        // ROUND_ID=match_id. Byte-matches the hub engine + indexer cross_settle.
        if(eq.isEquivHeaderActive(m.snapshot_block, m.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, (m.finalizing_view != null ? m.finalizing_view : 0), raw);
        return raw;
    },

    // XCALL phase canonicals: byte-identical to CrossChainCallEngine.canonicalMatch
    // / the indexer's verifiers (kept local for the same reason as matchCanonical).
    callCanonical(c){
        let sha = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
        let phase = (c.phase === 'result') ? 'result' : 'dispatch';
        let raw;
        if(c.phase === 'result'){
            raw = [
                'XCALL', 'RESULT', c.call_id, String(c.snapshot_block), c.network || '',
                c.target_chain, String(c.result_status || ''),
                sha(c.return_payload_b64), String(c.effective_time)
            ].join('|');
        } else {
            raw = [
                'XCALL', 'DISPATCH', c.call_id, String(c.snapshot_block), c.network || '',
                c.source_chain, String(c.source_action_index), String(c.source_contract_index),
                c.target_chain, String(c.target_contract_index),
                c.method, sha(c.params_json),
                String(c.gas_limit), String(c.cross_hops), String(c.effective_time)
            ].join('|');
        }
        // EQUIV (WI-2 bump 2): TAG=XCALL, ROUND_ID = sha256('XCALLROUND|'+phase+'|'+call_id),
        // VIEW = the archived row's finalizing_view. Byte-matches the hub engine + indexer twins.
        if(eq.isEquivHeaderActive(c.snapshot_block, c.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|' + phase + '|' + c.call_id), (c.finalizing_view != null ? c.finalizing_view : 0), raw);
        return raw;
    },

    // Signature quorum over a resolved validator set, byte-for-byte the same verdict
    // the indexer recovery (_quorumVerified) + anchor.js apply: stake-weighted
    // (source-deduped, 3*Sigma signer-source weight > 2*S) at/above STAKE_WEIGHTED_QUORUM,
    // else legacy 2f+1 count. `validatorSet` is the full [{pubkey, source, weight|amount}]
    // set (entries are objects, never bare pubkeys). It gates the wrapper's own
    // on-chain validity and every archived match/call against its cross_chain set.
    quorumVerified(canonical, sigs, validatorSet, weighted){
        // Fail CLOSED on a TRUNCATED weighted set (SWQ-TRUNC parity, mirrors
        // meetsStakeThreshold + the DEX/Call consensus refuse): an over-cap snapshot
        // under-counts summed stake S, so a stake-evicted minority could otherwise clear
        // the strict 2/3 bar and authenticate a fabricated archived match/call (or the
        // wrapper). The COUNT path proceeds (deterministic cap; see CapabilitySnapshot.getQuorum).
        if(weighted && validatorSet && validatorSet.truncated === true) return false;
        let qualified = new Set((validatorSet || []).map(v => String(v.pubkey).toLowerCase()));
        if(qualified.size === 0) return false;
        let validSigners = [], seen = new Set();
        for(let s of sigs){
            let pk = String(s.pubkey).toLowerCase();
            if(seen.has(pk) || !qualified.has(pk)) continue;
            // Mark seen only AFTER a successful verify: marking on first
            // encounter is an order-dependent quorum under-count (a garbage
            // sig ahead of the same pubkey's valid sig would drop the signer),
            // and diverges from the indexer recovery twin this must match.
            if(ValidatorIdentity.verify(canonical, String(s.sig), pk)){
                seen.add(pk);
                validSigners.push(pk);
            }
        }
        if(weighted){
            // source carries the staking source; weight (or amount, from
            // resolveCapabilitySet) carries its stake; normalize for swq.
            let weightedSet = (validatorSet || []).map(v => ({
                pubkey: String(v.pubkey).toLowerCase(),
                source: String(v.source != null ? v.source : ''),
                weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0'))
            }));
            return swq.meetsStakeThreshold(weightedSet, validSigners);
        }
        let quorum = bftQuorumOrSingle(qualified.size, 1);   // majority-floored BFT quorum
        return validSigners.length >= quorum;
    },

    async backfillBatch(batchSeq, matchIds, txid, callIds, rewardIds){
        // Every stamp is guarded by the archive-eligibility predicate the
        // pending selectors use (batch_seq IS NULL OR archived_status <> status):
        // a row that is already fully archived can never be re-stamped onto a
        // different batch by a replayed/forged FINALIZED, while legitimate
        // __partial__ re-archives (archived_status <> status) still stamp their
        // fresh seq. Reward rows are immutable, so batch_seq IS NULL is their
        // only pending test (mirrors the reward selector).
        for(let m of matchIds){
            await this.db.updateCrossChainMatchByMatchIdAndBatchSeq(batchSeq, m.status, txid, m.match_id);
        }
        // Re-emit the stamped rows on the hub-DB mirror feed: anchor_txid is the one
        // back-filled column the mirror twins carry, and without a re-broadcast a
        // long-running streamed mirror keeps NULL forever while a later REST bootstrap
        // serves the stamp (divergent mirrors). Retracted rows stay out of the feed
        // (the stream already deleted them on mirrors); old sync clients INSERT IGNORE
        // the re-delivery, so this is backward-compatible.
        if(txid && matchIds.length && this.hub && this.hub.hubDbBroadcaster){
            try {
                let ids = matchIds.map(m => m.match_id);
                let rows = await this.db.findLiveCrossChainMatchesByMatchIds(ids);
                for(let row of rows)
                    this.hub.hubDbBroadcaster.broadcastRow({ table: 'cross_chain_matches', row: row });
            } catch(e){
                logger.warn(nodeUtil.format('StateAnchorPublisher: anchor-stamp re-broadcast failed (mirrors converge on next bootstrap):', e.message));
            }
        }
        for(let c of (callIds || [])){
            await this.db.updateCrossChainCall(batchSeq, c.status, txid, c.call_id, c.phase);
        }
        for(let r of (rewardIds || [])){
            // Rows are immutable; batch_seq is the only archive bookkeeping. Qualify the
            // stamp so a rebase-reissued archive seq cannot mark its twin archived and
            // strand it (the archive selector only picks up batch_seq IS NULL). A
            // FINALIZED from a peer predating the qualifier carries none, so fall back to
            // the unqualified stamp rather than matching nothing during a rolling deploy.
            let qualified = (r.round_qualifier !== undefined && r.round_qualifier !== null);
            let rewardType  = String(r.reward_type);
            let roundNumber = Number(r.round_number);
            let pubkey      = String(r.validator_pubkey).toLowerCase();
            if(qualified)
                await this.db.updateValidatorRewardArchiveBatchSeqByQualifier(batchSeq, rewardType, roundNumber, pubkey, Number(r.round_qualifier));
            else
                await this.db.updateValidatorRewardArchiveBatchSeq(batchSeq, rewardType, roundNumber, pubkey);
        }
    },

    async getNextBatchSeq(){
        // Spans every batch_seq-bearing table so a fresh seq is unique across
        // matches, calls AND rewards (consensus-uniform: all hubs compute the
        // same next seq from quorum-agreed rows).
        let r = await this.db.getNextAnchorBatchSeq();
        let local = (r && r.length > 0) ? Number(r[0].next_seq) : 0;
        // The rows above are consensus-uniform only once every back-fill has
        // landed. _observedConsumedBatchSeq carries the seqs the federation demonstrably
        // spent while this hub was missing one, so the stale hub converges on the
        // leader's numbering instead of re-proposing a taken seq until the withheld
        // XANC_FINALIZED (which re-stamps the real rows) finally arrives.
        let floor = this._observedConsumedBatchSeq + 1;
        if(!(floor > local)) return local;
        if(floor - local > this._archiveSeqFloorMaxJump){
            logger.warn('StateAnchorPublisher: observed consumed batch seq ' + this._observedConsumedBatchSeq +
                         ' is more than ' + this._archiveSeqFloorMaxJump + ' above our own next seq ' + local +
                         '; ignoring it as implausible and keeping the row-derived seq');
            return local;
        }
        logger.warn('StateAnchorPublisher: own rows give next batch seq ' + local + ' but the federation has ' +
                     'already consumed ' + this._observedConsumedBatchSeq + '; drawing ' + floor +
                     ' (this hub is behind on an archive back-fill)');
        return floor;
    },

    // Maps a state_checkpoints row to the 9 identity fields only; deliberately OMITS
    // state_root / state_root_version / block_merkle_root / block_merkle_version.
    // The co-sign guards that consume this compare via rawCanonicalCheckpoint, so the
    // omission is safe; adding the root fields to only one operand of a guard would flip
    // it fail-closed post-flag-day. Never carry roots here one-sided.
    cpFromRow(row){
        return {
            chain: String(row.chain), network: String(row.network), block_index: Number(row.block_index),
            block_hash: String(row.block_hash), ledger_hash: String(row.ledger_hash),
            actions_hash: String(row.actions_hash), contract_hash: String(row.contract_hash),
            checkpoint_seq: Number(row.checkpoint_seq), snapshot_block: Number(row.snapshot_block)
        };
    },

    parseSigs(raw){
        try {
            let sigs = JSON.parse(String(raw || '[]'));
            return Array.isArray(sigs) ? sigs.filter(s => s && s.pubkey && s.sig) : [];
        } catch(e){ return []; }
    },

    // crc32 over the UNCOMPRESSED archive JSON (zlib version independent).
    crc32Hex(str){
        let n = zlib.crc32 ? zlib.crc32(Buffer.from(str, 'utf8')) : this.crc32Fallback(Buffer.from(str, 'utf8'));
        return (n >>> 0).toString(16).padStart(8, '0');
    },

    crc32Fallback(buf){
        let c, crc = 0xFFFFFFFF;
        for(let i = 0; i < buf.length; i++){
            c = (crc ^ buf[i]) & 0xFF;
            for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

};
