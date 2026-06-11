/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - CapabilitySnapshot
 *
 * Locks the validator set for a capability at a block-boundary so every
 * hub in the federation computes the same PBFT quorum for a given round,
 * even when on-chain stake state drifts mid-round.
 *
 * Source of truth is the BTC indexer: every hub independently queries
 * the same blockIndex and arrives at the same validator set (because
 * stake state at block N is on-chain-deterministic).
 *
 * Self-test / enabled flags are NOT part of the snapshot — those are
 * local-per-hub. A validator whose self-test fails simply doesn't
 * participate in the round and gets slashed for non-participation; N
 * still includes it. This is what makes the snapshot cross-hub
 * deterministic.
 *
 * Spec: claude/reports/specs/2026-05-24_capability-staking-model.md §6
 *
 ********************************************************************/

const axios = require('axios');

class CapabilitySnapshot {

    constructor(hub) {
        this.hub = hub;
        // (capability:blockIndex) → { validators: [{pubkey, amount}], count, blockIndex, capability, expiresAt }
        this.cache = new Map();
        // How long to keep a snapshot. 60s default — enough to span a PBFT round.
        this.cacheTtlMs = 60 * 1000;
    }

    // Fetch (or read from cache) the deterministic validator set for the given
    // capability at the given block boundary. Returns:
    //   { validators: [{pubkey, amount}, ...], count, blockIndex, capability }
    // Returns null when the indexer can't be reached or returns an error.
    async getSnapshot(capability, blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;
        let key = capability + ':' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return null;

        // The hub is the authoritative source of the MIN_STAKE threshold for its
        // own federation queries: passing it here makes the validator set depend
        // only on on-chain stake state + this hub's governance view, not on the
        // indexer's local config (which can drift between independently-operated
        // indexers and silently break cross-hub snapshot determinism). When the
        // registry isn't ready yet (snapshot exists pre-startCapabilities), we
        // omit the field and the indexer falls back to its local config.
        let minStake = (this.hub.capabilityRegistry && typeof this.hub.capabilityRegistry.getMinStake === 'function')
            ? this.hub.capabilityRegistry.getMinStake(capability)
            : null;
        let params = { capability: capability, block_index: blockIndex };
        if (minStake !== null && minStake !== undefined) params.min_stake = String(minStake);

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getcapabilityvalidators',
                params:  params
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let snapshot = {
                capability:  result.capability,
                blockIndex:  result.block_index,
                count:       result.count,
                validators:  result.validators || [],
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this._prune(now);
            return snapshot;
        } catch (err) {
            // Indexer unreachable / down — caller falls back to local validator set.
            return null;
        }
    }

    // Whole-federation snapshot — every pubkey with ANY active stake at the
    // block, regardless of capability. Used by Consensus (config-change PBFT)
    // where quorum is over all stakers, not a capability subset. Cache key is
    // disjoint from capability snapshots (capability='*').
    async getActiveValidatorSnapshot(blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;
        let key = '*:' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return null;

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getactivevalidators',
                params:  { block_index: blockIndex }
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let snapshot = {
                capability:  '*',
                blockIndex:  result.block_index,
                count:       result.count,
                validators:  result.validators || [],
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this._prune(now);
            return snapshot;
        } catch (err) {
            return null;
        }
    }

    // Standard PBFT quorum over the FULL snapshot, floored at a simple
    // majority: max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2)). The bare
    // 2f+1 form degenerates to quorum=1 at N=3 (f=0), which would let a single
    // validator finalize alone.
    // Returns 0 when N <= 1 (single-node mode — caller bypasses consensus).
    //
    // NOTE: this is the federation-wide quorum (e.g. config-change Consensus
    // PBFT, where every staker participates). It is NOT used for attestation
    // PBFT — those rounds only exchange messages within the REDUNDANCY-sized
    // responsible set, so AttestationConsensus.propose() computes its own
    // quorum over responsible.length instead of over the full count N here.
    getQuorum(snapshot) {
        if (!snapshot) return 0;
        let N = snapshot.count;
        if (N <= 1) return 0;
        return Math.max(2 * Math.floor((N - 1) / 3) + 1, Math.ceil((N + 1) / 2));
    }

    // Whether a pubkey appears in the snapshot's validator set.
    // PBFT participants use this to decide whether to count incoming votes.
    isInSnapshot(snapshot, pubkey) {
        if (!snapshot || !pubkey) return false;
        let target = String(pubkey).toLowerCase();
        for (let v of snapshot.validators) {
            if (String(v.pubkey).toLowerCase() === target) return true;
        }
        return false;
    }

    _prune(now) {
        for (let [k, v] of this.cache) {
            if (v.expiresAt <= now) this.cache.delete(k);
        }
    }
}

module.exports = CapabilitySnapshot;
