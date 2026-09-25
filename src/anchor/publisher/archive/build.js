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
 * ANCHOR publisher - archive assembly
 *
 * The archive election key, the failover ladder, the capability set an archive
 * carries, and the canonical bytes and chunking of the archive itself.
 *
 ********************************************************************/

'use strict';

const canonicalForms = require('../canonical_forms.js');
const StateCheckpointEngine = require('../../checkpoint_engine.js');
const swq = require('../../../consensus/stake_weighted_quorum.js');
const eq = require('../../../consensus/equivocation_header.js');
const { getLogger } = require('../../../observability');
const logger = getLogger();

module.exports = {

    // WRAPPER-anchored election key: deterministic, identical on every hub, and STABLE
    // while the batch is stalled, so the failover ladder has a fixed anchor to climb
    // against. Every field is the wrapper checkpoint's own identity, all of it
    // quorum-agreed: chain/network are the wrapper's, and checkpoint_seq is derived from
    // snapshot_block by the checkpoint engine, so two hubs holding the same wrapper
    // cannot disagree about the key no matter what else diverges.
    //
    // The batch_seq is deliberately NOT in the key. It came from
    // getNextBatchSeq, which is MAX(batch_seq)+1 over THIS hub's own
    // cross_chain_matches / cross_chain_calls / validator_rewards, with no consensus
    // step: it is only fleet-uniform while backfillBatch plus the XANC_FINALIZED gossip
    // have landed everywhere. Once two hubs' tables differ by one missed back-fill they
    // keyed the SAME wrapper differently, so each ranked itself 0 under its own key and
    // both published (two archives at batches 26 and 27 for one wrapper, observed live),
    // or, after a degraded round, each read itself rank 1 under its own key and NEITHER
    // published (hub0 at batch 38, hub1 at batch 39: a stuck federation).
    //
    // Trade-off taken on purpose: successive batches under one wrapper now elect the same
    // leader. Rotation still happens as checkpoint_seq advances, and within a wrapper the
    // ladder (`rankUnlocked` against electionBlock - snapshot_block) is what moves the
    // publish off a dead leader, which is exactly the job a STABLE anchor is needed for.
    // `batchSeq` is accepted and ignored so existing call sites/stubs stay valid.
    archiveElectionKey(cp, batchSeq){                      // eslint-disable-line no-unused-vars
        return 'XANCV2|' + cp.chain + '|' + cp.network + '|' + String(cp.checkpoint_seq);
    },

    // Canonical a follower signs when it REFUSES to co-sign a proposal whose batch_seq it
    // already holds as consumed. Distinct prefix from XANCFIN/the archive canonical, so a
    // refusal can never be replayed as a co-signature or an announcement.
    seqRefusalCanonical(batchSeq, consumedSeq){
        return 'XANCSEQ|' + String(batchSeq) + '|' + String(consumedSeq);
    },

    // Learn that the federation already consumed `seq`. Callers must have AUTHENTICATED
    // the evidence first (an oracle_publish member's signature, or an on-chain read):
    // the floor decides which seq the next round draws, so unauthenticated input here
    // would let any peer push this hub's numbering forward at will.
    noteConsumedBatchSeq(seq, why){
        // Reject null/undefined/'' outright rather than leaning on Number(): all three
        // coerce to 0, which is a REAL seq, so a wire field that simply was not set
        // would otherwise pin the floor at batch 0.
        if(seq === null || seq === undefined || seq === '') return;
        let s = Number(seq);
        if(!Number.isFinite(s) || s <= this._observedConsumedBatchSeq) return;
        this._observedConsumedBatchSeq = s;
        logger.warn('StateAnchorPublisher: batch seq ' + s + ' is already consumed by the federation (' +
                     why + '); the next archive round will draw above it rather than rebuilding under a ' +
                     'stale local seq');
    },

    // Failover-ladder check shared by leader election and follower verification:
    // rank 0 may publish immediately; each further rank unlocks after another
    // ANCHOR_ELECTION_TOLERANCE_BLOCKS past the anchor point. Concurrent
    // unlocked publishers build byte-identical archives (both verify against
    // the same quorum-agreed rows), so a race is duplicate-tx waste, not a
    // divergence hazard.
    rankUnlocked(order, pubkey, sinceBlocks){
        let rank = order.indexOf(String(pubkey || '').toLowerCase());
        if(rank < 0) return false;
        if(rank === 0) return true;
        let unlocked = Number.isFinite(sinceBlocks) ? Math.floor(Math.max(0, sinceBlocks) / this.electionToleranceBlocks) : 0;
        return rank <= unlocked;
    },

    // Resolve the qualifying set for (capability, block). Primary source is
    // CapabilitySnapshot.getSnapshot (deterministic from on-chain BTC stakes,
    // identical on EVERY hub), so the archive builder (leader) and the archive
    // verifier (followers) agree regardless of which hub led past rounds (the
    // local capability_snapshots table only holds rows a hub persisted while
    // leading, so it can't be the shared source). Falls back to the local
    // table for seeded/regtest stacks with no live BTC resolution.
    async resolveCapabilitySet(capability, block, network){
        // Derive the weighted-vs-count set for the RECORD's network (callers
        // pass resolveQuorumNetwork(record, this.network) / the archive network),
        // matching the round/verify gate that judges the resulting set. On a scoped
        // hub this equals this.network (a no-op); on an unscoped or cross-network hub
        // the gate would otherwise say weighted while the set resolved as count,
        // failing the stake tally closed. Falls back to this.network when none passed.
        let net = (network != null) ? network : this.network;
        // Source-keyed at/above STAKE_WEIGHTED_QUORUM so the archived snapshot rows
        // carry the staking source recovery needs to dedupe weight; legacy set
        // below it (source=''). amount carries the source's weight when weighted.
        let weighted = swq.isStakeWeightedQuorumActive(Number(block), net);
        // Gate on snapshot PRESENCE, not non-emptiness, matching the three sibling
        // resolvers (CrossChainDexEngine/CrossChainCallEngine/StateCheckpointEngine)
        // and the coerceValidators contract: an actual array (even length 0) is a
        // legitimate snapshot; only a malformed shape yields null. Gating on
        // length > 0 conflated "legitimately empty at this block" with "indexer
        // unavailable" and routed the former into the per-hub-local table, so two
        // hubs could resolve different sets/N/quorum for the same (capability, block).
        // A throw from the snapshot call propagates (like the siblings) rather than
        // being swallowed into the divergent local-table fallback.
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators)){
                    let set = snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.weight != null ? v.weight : '0'), source: String(v.source != null ? v.source : '') }));
                    // Carry the truncation flag so the weighted quorum verdict fails closed
                    // on an over-cap snapshot (SWQ-TRUNC parity: a truncated set under-counts
                    // S, so a stake-evicted minority could otherwise clear the 2/3 bar).
                    if(snap.truncated === true) set.truncated = true;
                    return set;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, Number(block));
                if(snap && Array.isArray(snap.validators))
                    return snap.validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), amount: String(v.amount != null ? v.amount : '0'), source: '' }));
            }
        }
        // Local-table fallback is gated to seeded/regtest stacks with no live BTC
        // resolution, matching the sibling resolvers
        // (StateCheckpointEngine/CrossChainCallEngine/CrossChainDexEngine, which seed
        // only when regtest). The local capability_snapshots table holds only rows a
        // hub persisted while leading, so it is NOT the shared source: on mainnet/
        // testnet a null snapshot means THIS hub's indexer is down/misconfigured
        // (CapabilitySnapshot returns null on any fetch/auth/echo failure), and
        // resolving from local rows while healthy peers resolve the on-chain snapshot
        // forks the set bytes for the same (capability, block). Fail closed off
        // regtest so a degraded round stalls (archive verification catches it) rather
        // than building a divergent archive.
        if(this.network !== 'regtest'){
            throw new Error('StateAnchorPublisher: cannot resolve capability set for (' +
                String(capability) + ', ' + Number(block) + '): deterministic snapshot unavailable ' +
                'and the local capability_snapshots table is not a valid shared source off regtest ' +
                '(indexer down/misconfigured); failing closed rather than building a divergent archive');
        }
        let rows = await this.db.findCapabilitySnapshotsBySnapshotBlock(Number(block), String(capability));
        return (rows || []).map(r => ({ pubkey: String(r.signing_pubkey).toLowerCase(), amount: String(r.amount), source: String(r.source != null ? r.source : '') }));
    },

    // Archive JSON with fixed key order (crc32-bearing bytes; see MATCH_KEYS).
    // capability_snapshots makes recovery self-contained: cross_chain rows for
    // every match's snapshot_block (to re-verify match signatures) PLUS the
    // oracle_publish rows at the wrapper checkpoint's snapshot_block (to
    // re-verify the v1 anchor's own signatures). Recovery additionally
    // cross-checks archived pubkeys against on-chain BTC stakes; archived
    // sets are a convenience, the chain remains the root of trust.
    async buildArchive(network, batchSeq, matches, wrapperSnapshotBlock, calls, rewards, quorumRows){
        calls   = calls   || [];
        rewards = rewards || [];
        let bridges  = this.sortedArchiveRows((quorumRows || {}).bridges, 'transfer_id');
        let policies = this.sortedArchiveRows((quorumRows || {}).policies, 'snapshot_id');
        const checkpoints = this.sortedStateCheckpoints((quorumRows || {}).checkpoints);
        const prices = this.sortedPriceSnapshots((quorumRows || {}).prices);
        const tombstones = this.sortedPriceTombstones((quorumRows || {}).tombstones);
        let wants = matches.map(m => ({ block: Number(m.snapshot_block), capability: 'cross_chain' }))
            .concat(calls.map(c => ({ block: Number(c.snapshot_block), capability: 'cross_chain' })))
            .concat(bridges.concat(policies).map(r => ({ block: Number(r.snapshot_block), capability: 'cross_chain' })))
            .concat(checkpoints.map(r => ({ block: Number(r.snapshot_block), capability: 'oracle_publish' })))
            .concat(prices.filter(r => this.isSignatureProofedPrice(r))
                .map(r => ({ block: Number(r.reference_block), capability: 'price' })))
            // oracle_publish set at each reward's earn block; verifiers (and
            // recovery) check the rewarded pubkey was an eligible publisher.
            .concat(rewards.map(({row}) => ({ block: Number(row.block_index), capability: 'oracle_publish' })));
        if(wrapperSnapshotBlock != null)
            wants.push({ block: Number(wrapperSnapshotBlock), capability: 'oracle_publish' });
        let seen = new Set(), snaps = [];
        for(let w of wants.sort((a, b) => a.block - b.block || (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))){
            let key = w.block + '|' + w.capability;
            if(seen.has(key)) continue;
            seen.add(key);
            let set = await this.resolveCapabilitySet(w.capability, w.block, network);
            // Total order: pubkey then source. Equal pubkeys are legitimately
            // possible in weighted snapshots (one row per (source, pubkey), a key
            // may be delegated by multiple sources); a two-branch comparator that
            // returns 1 for both orderings of an equal pair is inconsistent and
            // leaves relative order engine-defined, which can diverge the crc32
            // archive bytes that follower co-signers verify byte-for-byte.
            for(let v of set.slice().sort((a, b) => a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)))
                snaps.push({ snapshot_block: w.block, capability: w.capability,
                             signing_pubkey: v.pubkey, amount: v.amount,
                             source: String(v.source != null ? v.source : '') });
        }
        // `calls` and `rewards` are additive to the v1 archive shape: recovery
        // treats a missing key as an empty list, so older on-chain archives stay
        // parseable.
        let obj = {
            v: 1,
            network: network,
            batch_seq: batchSeq,
            matches: matches.map(m => canonicalForms.serializeMatch(m)),
            calls: calls.map(c => canonicalForms.serializeCall(c)),
            rewards: rewards.map(({row, source}) => canonicalForms.serializeReward(row, source))
        };
        // Emitted only when non-empty, so an archive without them stays byte-identical to
        // one built before these tables were carried.
        if(bridges.length) obj.bridge_transfers = bridges.map(r => this.serializeBridgeTransfer(r));
        if(policies.length) obj.policy_snapshots = policies.map(r => this.serializePolicySnapshot(r));
        if(checkpoints.length) obj.state_checkpoints = checkpoints.map(r => this.serializeStateCheckpoint(r));
        if(prices.length) obj.price_snapshots = prices.map(r => this.serializePriceSnapshot(r));
        if(tombstones.length) obj.price_tombstones = tombstones.map(r => this.serializePriceTombstone(r));
        obj.capability_snapshots = snaps;
        return { json: JSON.stringify(obj), count: matches.length };
    },

    // v1 archive canonical = the RAW v0 checkpoint content + the batch extension, then
    // (at/above the EQUIV flag-day) wrapped ONCE in the uniform header. The v1 ROUND_ID
    // appends `batch_seq` to the v0 round id so the v0 (per-block) and v1 (archive)
    // canonicals (which legitimately share checkpoint_seq) get DISTINCT equivocation
    // keys; otherwise an honest validator that signs both is falsely slashable (R-4 fix).
    // Nests rawCanonicalCheckpoint (not canonicalCheckpoint) so the header lands outside.
    archiveCanonical(cp, batchSeq, count, crc, totalChunks){
        let raw = StateCheckpointEngine.rawCanonicalCheckpoint(cp) + '|' +
                  String(batchSeq) + '|' + String(count) + '|' + crc + '|' + String(totalChunks);
        if(eq.isEquivHeaderActive(cp.snapshot_block, cp.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                cp.chain + '|' + cp.network + '|' + cp.block_index + '|' + cp.checkpoint_seq + '|' + batchSeq, 0, raw);
        return raw;
    },

    splitChunks(b64){
        let chunks = [];
        for(let i = 0; i < b64.length; i += this.chunkMaxBytes) chunks.push(b64.slice(i, i + this.chunkMaxBytes));
        return chunks.length ? chunks : [''];
    }

};
