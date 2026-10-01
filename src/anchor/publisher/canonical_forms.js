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
 * XChain Hub - ANCHOR canonical forms
 *
 * The deterministic publisher ordering and the fixed-key-order record shapes
 * the leader, the follower verifier and recovery must all produce byte for byte.
 * StateAnchorPublisher carries them as its statics, and the part modules call
 * them here, so no part has to require the class file back.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { MATCH_KEYS, CALL_KEYS } = require('./constants.js');
const checkpointForms = require('../checkpoint_engine/canonical_forms.js');
const eq = require('../../consensus/equivocation_header.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { resolveQuorumNetwork } = require('../quorum_network.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { activeAt } = require('../../consensus/gate_registry.js');
const { canonicalBatchCrc } = require('./fold/wrapper_canonical.js');
const { listIdsOf } = require('./archive/list_rows_select.js');

const ANCHOR_FOLD_GATE = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';

function isAnchorFoldActive(blockIndex, network){
    return activeAt(ANCHOR_FOLD_GATE, String(network || ''), null, blockIndex, null);
}

function isArchiveAnchorRow(row){
    return !!row && row.match_batch_seq !== null && row.match_batch_seq !== undefined;
}

function isCheckpointAnchorRow(row){
    return !!row && row.checkpoint_chain !== null && row.checkpoint_chain !== undefined &&
           String(row.checkpoint_chain) !== '';
}

function foldArchiveCanonical(checkpoint, batchSeq, count, crc, totalChunks){
    let raw = checkpointForms.rawCanonicalCheckpoint(checkpoint) +
              checkpointForms.checkpointRootSuffix(checkpoint) + '|' +
              [String(batchSeq), String(count), canonicalBatchCrc(crc), String(totalChunks)].join('|');
    if(eq.isEquivHeaderActive(checkpoint.snapshot_block, checkpoint.network))
        return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
            checkpoint.chain + '|' + checkpoint.network + '|' + checkpoint.block_index + '|' +
            checkpoint.checkpoint_seq + '|' + batchSeq, 0, raw);
    return raw;
}

const foldPublisherMethods = {
    async buildFoldArchiveSection(group, network){
        if(!this.db || typeof this.db.findCrossChainMatchesByBatchSeq !== 'function' ||
           typeof this.db.findCrossChainCallsByBatchSeq !== 'function') return null;
        let rows = await this.gatherArchiveRows();
        if(!rows) return null;
        let ordered = this.orderedBundleSections(group);
        let wrapperSectionIndex = ordered.findIndex(s => String(s.chain) === 'BTC');
        if(wrapperSectionIndex < 0) wrapperSectionIndex = 0;
        if(!ordered[wrapperSectionIndex]) return null;
        let wrapper = ordered[wrapperSectionIndex];
        let cp = this.cpFromRow(wrapper);
        let batchSeq = await this.getNextBatchSeq();
        let rewardRows = await this.resolveArchiveRewardSources(rows.rewards);
        if(this.archiveEmptyAfterResolution(rows, rewardRows)) return null;
        let archive = await this.buildSizedArchive(network, batchSeq, rows, cp.snapshot_block, rewardRows);
        if(rows.cappedOrTrimmed) this._leaderRetryDue = true;
        let wire = this.archiveWire(archive.json);
        let canonical = foldArchiveCanonical(wrapper, batchSeq, archive.count, wire.crc, wire.chunks.length);
        let signingSet = await this.archiveSigningSet(cp);
        if(!signingSet || this.archiveSigningSetUnresolved(signingSet, cp, batchSeq)) return null;
        let me = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let signatures = [];
        if(me && signingSet.some(v => String(v.pubkey).toLowerCase() === me))
            signatures.push({ pubkey: me, sig: this.identity.sign(canonical) });
        return {
            cp, batchSeq, count: archive.count, crc: wire.crc, b64: wire.b64, chunks: wire.chunks,
            wrapperSectionIndex, signatures, canonical, validators: signingSet,
            weighted: swq.isStakeWeightedQuorumActive(Number(cp.snapshot_block),
                                                       resolveQuorumNetwork(cp, this.network)),
            matchIds: rows.matches.map(m => ({ match_id: m.match_id, status: m.status })),
            callIds: rows.calls.map(c => ({ call_id: c.call_id, phase: c.phase, status: c.status })),
            rewardIds: rewardRows.map(({row}) => ({
                reward_type: String(row.reward_type), round_number: Number(row.round_number),
                validator_pubkey: String(row.validator_pubkey).toLowerCase(),
                round_qualifier: Number(row.round_qualifier || 0)
            })),
            bridgeIds: rows.bridges.map(r => ({ transfer_id: String(r.transfer_id), status: String(r.status) })),
            policyIds: rows.policies.map(r => ({ snapshot_id: String(r.snapshot_id) })),
            listIds: listIdsOf(rows.lists),
            checkpointIds: rows.checkpoints.map(r => ({
                chain: String(r.chain), network: String(r.network), checkpoint_seq: Number(r.checkpoint_seq)
            })),
            priceIds: rows.prices.map(r => ({
                round_number: Number(r.round_number), coin_pair: String(r.coin_pair),
                status: String(r.status), batch_block_time: Number(r.batch_block_time),
                proof_sha: crypto.createHash('sha256').update(String(r.consensus_proof)).digest('hex')
            })),
            tombstoneIds: rows.tombstones.map(r => ({
                round_number: Number(r.round_number), coin_pair: String(r.coin_pair)
            }))
        };
    },

    foldArchiveRequest(round){
        return {
            checkpoint: round.cp, wrapper_section_index: round.wrapperSectionIndex,
            batch_seq: round.batchSeq, match_count: round.count,
            batch_crc32: round.crc, total_chunks: round.chunks.length,
            archive_b64: round.b64,
            sig_pubkey: this.identity.getPubkeyHex().toLowerCase(),
            sig: this.identity.sign(round.canonical)
        };
    },

    async coSignFoldArchiveRequest(envelope){
        let d = envelope && envelope.data;
        let a = d && d.archive;
        if(!this.identity || !a || !a.checkpoint || !Array.isArray(d.sections)) return null;
        let sender = String(d.sig_pubkey || '').toLowerCase();
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        if(!sender || sender === myPubkey || String(d.publisher || '').toLowerCase() !== sender) return null;
        let foldBlock = Number(d.snapshot_block);
        if(this.hub && typeof this.hub.resolveDogeLatestBlock === 'function'){
            try { foldBlock = Number(await this.hub.resolveDogeLatestBlock()); }
            catch(_e){ return null; }
        }
        if(!isAnchorFoldActive(foldBlock, String(d.network))) return null;
        let index = Number(a.wrapper_section_index);
        let sec = Number.isInteger(index) ? d.sections[index] : null;
        let cp = a.checkpoint;
        if(!sec || String(sec.chain) !== String(cp.chain) ||
           Number(sec.block_index) !== Number(cp.block_index) ||
           Number(sec.checkpoint_seq) !== Number(cp.checkpoint_seq)) return null;
        let local = await this.db.getStateCheckpointByChain(
            String(cp.chain), String(d.network), Number(cp.block_index), Number(cp.checkpoint_seq));
        let mine = this.ownArchiveWrapper(local, cp);
        if(!mine || Number(await this.getNextBatchSeq()) !== Number(a.batch_seq)) return null;
        let canonical = foldArchiveCanonical(local[0], Number(a.batch_seq), Number(a.match_count),
                                             String(a.batch_crc32), Number(a.total_chunks));
        if(!ValidatorIdentity.verify(canonical, String(a.sig || ''), sender)) return null;
        let signingSet = await this.archiveSigningSet(mine);
        if(!signingSet.some(v => String(v.pubkey).toLowerCase() === myPubkey)) return null;
        let archive = this.decodeArchiveProposal(a);
        if(!archive || !(await this.verifyArchiveAgainstLocal(archive, Number(mine.snapshot_block)))) return null;
        return {
            batchSeq: Number(a.batch_seq), sender, cp, archive,
            reply: {
                network: String(d.network), snapshot_block: Number(d.snapshot_block),
                sig_pubkey: myPubkey, sig: '', archive_sig: this.identity.sign(canonical)
            }
        };
    },

    armFoldArchiveRound(round){
        let waitMs = Math.max(1, Math.min(Number(this.archiveFoldSubdeadlineMs) || 1000,
                                         Number(this.roundTimeoutMs) || 30000));
        round.signatures = new Map((round.signatures || []).map(s => [String(s.pubkey).toLowerCase(), String(s.sig)]));
        round.done = false;
        round.result = new Promise(resolve => { round.resolve = resolve; });
        this._foldArchiveRound = round;
        round.timer = setTimeout(() => this.finishFoldArchiveRound(round, null), waitMs);
        if(round.timer.unref) round.timer.unref();
        this.checkFoldArchiveQuorum(round);
    },

    finishFoldArchiveRound(round, result){
        if(!round || round.done) return;
        round.done = true;
        if(round.timer) clearTimeout(round.timer);
        round.timer = null;
        if(this._foldArchiveRound === round) this._foldArchiveRound = null;
        round.resolve(result);
    },

    checkFoldArchiveQuorum(round){
        if(!round || round.done) return;
        let signatures = Array.from(round.signatures, ([pubkey, sig]) => ({ pubkey, sig }));
        if(!this.quorumVerified(round.canonical, signatures, round.validators, round.weighted)) return;
        round.signatures = signatures;
        this.finishFoldArchiveRound(round, round);
    },

    acceptFoldArchiveSignature(d){
        let round = this._foldArchiveRound;
        if(!round || round.done || !d || !d.archive_sig) return;
        if(String(d.network) !== String(round.cp.network) ||
           Number(d.snapshot_block) !== Number(round.cp.snapshot_block)) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!round.validators.some(v => String(v.pubkey).toLowerCase() === pubkey)) return;
        if(!ValidatorIdentity.verify(round.canonical, String(d.archive_sig), pubkey)) return;
        round.signatures.set(pubkey, String(d.archive_sig));
        this.checkFoldArchiveQuorum(round);
    },

    async collectFoldArchive(group, network){
        let waitMs = Math.max(1, Math.min(Number(this.archiveFoldSubdeadlineMs) || 1000,
                                         Number(this.roundTimeoutMs) || 30000));
        let timer;
        let timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve(null), waitMs);
            if(timer.unref) timer.unref();
        });
        try { return await Promise.race([this.buildFoldArchiveSection(group, network), timeout]); }
        finally { if(timer) clearTimeout(timer); }
    },

    suppressLegacyArchiveLeg(){
        if(this._archiveRound || this._archivePublishing) return;
        this._archivePublishing = { folded: true };
    },

    async findExistingFoldedBundle(sections, archiveSection){
        let ix = this.indexers && this.indexers.DOGE;
        if(!ix || !ix.url) throw new Error('no DOGE indexer wired');
        let txid = null;
        let accept = (row, predicate) => {
            if(!row || row.error) throw new Error('anchor lookup failed: ' + (row && row.error));
            if(!row.exists || /^invalid/i.test(String(row.status || ''))) return null;
            if(!predicate(row)) throw new Error('anchor lookup omitted required row attributes');
            return row.txid ? String(row.txid).toLowerCase() : null;
        };
        for(let section of (sections || [])){
            let requested = {
                chain: String(section.chain), network: String(section.network),
                block_index: Number(section.block_index), checkpoint_seq: Number(section.checkpoint_seq)
            };
            let row = await this.indexerCall('DOGE', 'getanchoraction', requested);
            let found = accept(row, r => isCheckpointAnchorRow(r) &&
                String(r.checkpoint_chain) === requested.chain &&
                String(r.checkpoint_network) === requested.network &&
                Number(r.block_index) === requested.block_index &&
                Number(r.checkpoint_seq) === requested.checkpoint_seq);
            if(found === null) return null;
            if(txid === null) txid = found;
            else if(txid !== found) return null;
        }
        if(archiveSection){
            let requested = { match_batch_seq: Number(archiveSection.batchSeq),
                              author: String(this.dogeAddress || '') };
            let row = await this.indexerCall('DOGE', 'getarchiveanchor', requested);
            let found = accept(row, r => isArchiveAnchorRow(r) &&
                Number(r.match_batch_seq) === requested.match_batch_seq &&
                String(r.author) === requested.author);
            if(found === null) return null;
            if(txid === null) txid = found;
            else if(txid !== found) return null;
        }
        return txid ? { exists: true, txid } : null;
    },

    async completeFoldArchive(archiveSection, signer, txid){
        if(!archiveSection) return;
        await this.markArchiveSent(String(archiveSection.cp.network), archiveSection.batchSeq, txid);
        let broadcaster = signer && signer.broadcastFn
            ? signer.broadcastFn : ((p) => this.defaultBroadcast(p, signer, { allowUnconfirmed: true }));
        let lostChunks = await this.broadcastArchiveChunks(archiveSection, archiveSection.batchSeq,
                                                           broadcaster, archiveSection.cp);
        let ids = this.archiveBackfillIds(archiveSection, lostChunks, true, false);
        let backfillArgs = [archiveSection.batchSeq, ids.matchIds, txid, ids.callIds, ids.rewardIds,
                            ids.bridgeIds, ids.policyIds, ids.checkpointIds,
                            ids.priceIds, ids.tombstoneIds];
        if(ids.listIds && ids.listIds.length) backfillArgs.push(ids.listIds);
        await this.backfillBatch(...backfillArgs);
        await this.settleArchiveIntent(String(archiveSection.cp.network), archiveSection.batchSeq);
        this.announceArchiveFinalized(archiveSection, txid, ids);
    }
};

module.exports = {

    isAnchorFoldActive,
    isArchiveAnchorRow,
    isCheckpointAnchorRow,
    foldArchiveCanonical,
    foldPublisherMethods,

    // Deterministic publisher ordering (AttestationRound's responsible-set
    // idiom): sort the eligible set by SHA256(key ‖ pubkey) ascending. Every
    // hub computes the identical order from the block-boundary snapshot.
    hashOrder(key, pubkeys){
        return (pubkeys || []).map(pk => {
            let p = String(pk).toLowerCase();
            return { pubkey: p, hash: crypto.createHash('sha256').update(key, 'utf8').update(p, 'utf8').digest('hex') };
        }).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map(e => e.pubkey);
    },

    // Fixed-key-order match record (shared with the follower verifier + recovery).
    serializeMatch(m){
        let out = {};
        for(let k of MATCH_KEYS){
            let v = m[k];
            if(k === 'id' || k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'a_ownership' || k === 'b_ownership')
                out[k] = Number(v) ? 1 : 0;
            else if(k === 'a_tick' || k === 'b_tick')
                out[k] = (v == null) ? null : String(v);
            else if(k === 'a_payout_legs' || k === 'b_payout_legs'){
                // Omit-when-null: legs only exist at/above the CROSS_CHAIN_ROYALTY flag-day
                // (create-side deny below it), so legs-less archives stay byte-identical to
                // those built by pre-royalty hubs and recovery tolerates both shapes.
                if(v != null) out[k] = String(v);
            }
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    },

    // Fixed-key-order XCALL relay record (shared with the follower verifier +
    // recovery). result_status / return_payload_b64 are null on dispatch rows.
    serializeCall(c){
        let out = {};
        for(let k of CALL_KEYS){
            let v = c[k];
            if(k === 'id' || k === 'snapshot_block' || k === 'source_action_index' || k === 'source_contract_index' ||
               k === 'target_contract_index' || k === 'gas_limit' || k === 'cross_hops' || k === 'effective_time')
                out[k] = Number(v);
            else if(k === 'finalizing_view')
                out[k] = Number(v) || 0;   // EQUIV VIEW; archived so recovery rebuilds the exact signed bytes
            else if(k === 'result_status' || k === 'return_payload_b64')
                out[k] = (v == null) ? null : String(v);
            else
                out[k] = String(v == null ? '' : v);
        }
        return out;
    },

    // Fixed-key-order anchor-publish reward record (shared with the follower
    // verifier + recovery). `source` is the earn-time staking address pinned by
    // the archive builder. Recovery restores rewards into the BTC indexer DB
    // BEFORE the reindex, so it cannot resolve sources itself, and a later
    // re-stake of the pubkey from a different address must not move the credit.
    serializeReward(r, source){
        return {
            validator_pubkey: String(r.validator_pubkey).toLowerCase(),
            source:           String(source),
            round_number:     Number(r.round_number),
            reward_type:      String(r.reward_type),
            amount:           String(r.amount),
            block_index:      Number(r.block_index)
        };
    },

    // Reward identity shared by the archive body and the FINALIZED reward list. The
    // archived record carries no round_qualifier, so the key stops at the three fields
    // both shapes hold.
    archiveRewardKey(r){
        return String(r.reward_type) + '|' + String(Number(r.round_number)) + '|' +
               String(r.validator_pubkey).toLowerCase();
    }
};
