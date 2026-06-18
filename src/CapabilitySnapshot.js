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
 * Self-test / enabled flags are NOT part of the snapshot (those are
 * local-per-hub). A validator whose self-test fails simply doesn't
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
        // How long to keep a snapshot. 60s default, enough to span a PBFT round.
        this.cacheTtlMs = 60 * 1000;
        // Last time we logged an indexer auth (401/403) failure (throttles the
        // warning so a persistent key mismatch doesn't spam the poll loop).
        this._authWarnAt = 0;
        // Last time we alarmed on a truncated validator-set snapshot (#4479).
        // Same throttle idiom as _authWarnAt so a sustained over-limit validator
        // set raises one warning per cacheTtlMs instead of one per quorum call.
        this._truncWarnAt = 0;
    }

    // Classify a federation-read failure and return null (the fetch helpers'
    // "indexer unavailable" sentinel). A 401/403 is NOT "indexer down": it means
    // the hub's x-api-key (BTC_INDEXER_API_KEY) does not match the indexer's
    // INDEXER_API_KEY. Swallowed silently (as every catch did), that misconfig is
    // indistinguishable from a dead indexer or an empty validator set, so every
    // attestation round and config-change quorum collapses to a null snapshot
    // while nothing points the operator at auth. Surface it distinctly, throttled.
    _onFetchError(method, err) {
        let status = err && err.response && err.response.status;
        if (status === 401 || status === 403) {
            let now = Date.now();
            if (now - this._authWarnAt > this.cacheTtlMs) {
                this._authWarnAt = now;
                console.error('CapabilitySnapshot: ' + method + ' got HTTP ' + status +
                    ' from the BTC indexer: the hub\'s x-api-key (BTC_INDEXER_API_KEY) does not match the ' +
                    'indexer\'s INDEXER_API_KEY. Federation snapshots are NULL (attestation + config-change ' +
                    'quorum collapse) until the two keys match.');
            }
        }
        return null;
    }

    // Fetch (or read from cache) the deterministic validator set for the given
    // capability at the given block boundary. Returns:
    //   { validators: [{pubkey, amount}, ...], count, blockIndex, capability }
    // Returns null when the indexer can't be reached or returns an error.
    async getSnapshot(capability, blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;

        // The hub is the authoritative source of the MIN_STAKE threshold for its
        // own federation queries: passing it here makes the validator set depend
        // only on on-chain stake state + this hub's governance view, not on the
        // indexer's local config (which can drift between independently-operated
        // indexers and silently break cross-hub snapshot determinism). When the
        // registry isn't ready yet (snapshot exists pre-startCapabilities), we
        // omit the field and the indexer falls back to its local config.
        //
        // The threshold also rides in the cache key: it controls which validators
        // qualify for the round, so two reads resolving different thresholds for
        // the same (capability, blockIndex) MUST NOT share a cache entry. Without
        // this a governance MIN_STAKE change leaves a stale snapshot serving the
        // old validator set for up to the TTL, splitting quorum across hubs.
        let minStake = this._resolveMinStake(capability, blockIndex);
        let key = capability + ':' + blockIndex + ':' + (minStake === null ? '' : minStake);
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return null;

        let params = { capability: capability, block_index: blockIndex };
        if (minStake !== null) params.min_stake = minStake;

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
                truncated:   result.truncated === true,
                validators:  result.validators || [],
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this._prune(now);
            return snapshot;
        } catch (err) {
            // Indexer unreachable / down (or 401/403 auth mismatch): caller falls
            // back to local validator set; _onFetchError surfaces an auth misconfig.
            return this._onFetchError('getcapabilityvalidators', err);
        }
    }

    // Source-keyed weight snapshot for STAKE_WEIGHTED_QUORUM. Like getSnapshot but
    // each row carries { pubkey, source, weight } (the staking address + its
    // aggregate stake), so the quorum tally can dedupe by source. Cache key is
    // disjoint from the count snapshot ('w:' prefix). Returns null on indexer error.
    async getWeightSnapshot(capability, blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;

        // min_stake rides in the cache key for the same reason as getSnapshot:
        // it determines the qualifying set, so a governance threshold change must
        // force a fresh fetch rather than serve a snapshot keyed to the old one.
        let minStake = this._resolveMinStake(capability, blockIndex);
        let key = 'w:' + capability + ':' + blockIndex + ':' + (minStake === null ? '' : minStake);
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return null;

        let params = { capability: capability, block_index: blockIndex };
        if (minStake !== null) params.min_stake = minStake;

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getstakeweightsbycapability',
                params:  params
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let snapshot = {
                capability:  result.capability,
                blockIndex:  result.block_index,
                count:       result.count,
                truncated:   result.truncated === true,
                sourceCount: result.source_count,
                validators:  result.validators || [],     // [{pubkey, source, weight}]
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this._prune(now);
            return snapshot;
        } catch (err) {
            return this._onFetchError('getstakeweightsbycapability', err);
        }
    }

    // Whole-federation snapshot: every pubkey with ANY active stake at the
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
                truncated:   result.truncated === true,
                validators:  result.validators || [],
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this._prune(now);
            return snapshot;
        } catch (err) {
            return this._onFetchError('getactivevalidators', err);
        }
    }

    // Source-keyed whole-federation weight snapshot: every staker with ANY active
    // stake at the block (no capability filter), each row carrying { pubkey, source,
    // weight }. The STAKE_WEIGHTED_QUORUM counterpart of getActiveValidatorSnapshot,
    // used by Consensus (config-change PBFT) to weight quorum by stake. Cache key is
    // disjoint ('wa:' prefix). Returns null on indexer error.
    async getActiveWeightSnapshot(blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;
        let key = 'wa:' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return null;

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getactivestakeweights',
                params:  { block_index: blockIndex }
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let snapshot = {
                capability:  '*',
                blockIndex:  result.block_index,
                count:       result.count,
                truncated:   result.truncated === true,
                sourceCount: result.source_count,
                validators:  result.validators || [],     // [{pubkey, source, weight}]
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this._prune(now);
            return snapshot;
        } catch (err) {
            return this._onFetchError('getactivestakeweights', err);
        }
    }

    // Standard PBFT quorum over the FULL snapshot, floored at a simple
    // majority: max(2 * floor((N - 1) / 3) + 1, ceil((N + 1) / 2)). The bare
    // 2f+1 form degenerates to quorum=1 at N=3 (f=0), which would let a single
    // validator finalize alone.
    // Returns 0 when N <= 1 (single-node mode; caller bypasses consensus).
    //
    // NOTE: this is the federation-wide quorum (e.g. config-change Consensus
    // PBFT, where every staker participates). It is NOT used for attestation
    // PBFT. Those rounds only exchange messages within the REDUNDANCY-sized
    // responsible set, so AttestationConsensus.propose() computes its own
    // quorum over responsible.length instead of over the full count N here.
    getQuorum(snapshot) {
        if (!snapshot) return 0;
        // Alarm-and-proceed when the quorum is computed over a TRUNCATED snapshot
        // (#4479): the indexer hit VALIDATOR_QUERY_LIMIT, so `count` (and the
        // validator set) is capped below the true federation size and N here is a
        // floor, not the real N. We still finalize: every indexer truncates the
        // same way at the same block, so the capped set is cross-hub deterministic
        // and quorum stays consistent fleet-wide. Refusing would instead halt all
        // consensus the moment the validator set outgrows the limit, a worse
        // failure than a quorum over a deterministic cap. So raise a loud,
        // throttled operator warning (same idiom as _onFetchError) telling the
        // operator to raise VALIDATOR_QUERY_LIMIT, and proceed. The warning is the
        // only safe lever here because the cap is invisible in N alone.
        if (snapshot.truncated === true) {
            let now = Date.now();
            if (now - this._truncWarnAt > this.cacheTtlMs) {
                this._truncWarnAt = now;
                console.error('CapabilitySnapshot: quorum computed over a TRUNCATED validator-set snapshot ' +
                    '(capability=' + snapshot.capability + ' block=' + snapshot.blockIndex + ' count=' + snapshot.count +
                    '): the indexer hit VALIDATOR_QUERY_LIMIT, so N is CAPPED below the true federation size. ' +
                    'Quorum stays cross-hub deterministic (all indexers truncate identically) but is computed over a ' +
                    'partial set; raise the frozen VALIDATOR_QUERY_LIMIT consensus constant (coordinated fleet upgrade) on the indexers so the full validator set is returned.');
            }
        }
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

    // Resolve this hub's authoritative MIN_STAKE threshold for a capability as a
    // string (the form the indexer RPC and the cache key expect), or null when
    // the registry isn't wired yet (pre-startCapabilities) or has no threshold
    // for the capability (in which case the indexer falls back to its own config).
    // Resolve the MIN_STAKE threshold for this capability AT the snapshot's block. Threading
    // blockIndex is what makes the snapshot federation-deterministic: every hub resolves the same
    // threshold for the same block from the block-anchored governance history, so they fold the
    // identical min_stake into the cache key and request the identical qualifying set (#3703).
    _resolveMinStake(capability, blockIndex) {
        let reg = this.hub.capabilityRegistry;
        if (!reg || typeof reg.getMinStake !== 'function') return null;
        let v = reg.getMinStake(capability, blockIndex);
        return (v === null || v === undefined) ? null : String(v);
    }

    // Drop every cached snapshot for a capability: both the count-keyed
    // (capability:...) and the weight-keyed (w:capability:...) entries. Called
    // when a governance MIN_STAKE change lands so the next consensus read
    // re-queries the indexer under the new threshold. With min_stake folded into
    // the cache key the stale entries are already unreachable; this reclaims them
    // immediately instead of waiting for the TTL to prune them. Returns the count
    // of entries removed. The '*'-keyed whole-federation snapshots carry no
    // capability filter and are intentionally left untouched.
    flushCapability(capability) {
        if (!capability) return 0;
        let prefixes = [capability + ':', 'w:' + capability + ':'];
        let removed = 0;
        for (let k of this.cache.keys()) {
            for (let p of prefixes) {
                if (k.indexOf(p) === 0) { this.cache.delete(k); removed++; break; }
            }
        }
        return removed;
    }

    _prune(now) {
        for (let [k, v] of this.cache) {
            if (v.expiresAt <= now) this.cache.delete(k);
        }
    }
}

module.exports = CapabilitySnapshot;
