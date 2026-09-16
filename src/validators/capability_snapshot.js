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
 * participate in the round; N still includes it. This is what makes
 * the snapshot cross-hub deterministic.
 *
 * Nothing on-chain penalises that absence: SLASH burns on equivocation
 * proofs only, and the hub-local suspended status is not a stake effect
 * (no quorum read consults it). On a network where ROLLCALL is active,
 * a source absent for K consecutive rolled epochs is evicted by
 * deactivation (protocol/actions/rollcall.md), and N then shrinks the
 * way it shrinks for any UNSTAKE.
 *
 ********************************************************************/

const axios = require('axios');
// Consensus-input fetches fail closed but used to fail SILENTLY for
// every reason except auth and echo mismatch. The monitor counts every outcome,
// owns the log throttle, and raises the alert that /health reports.
const { ConsensusInputMonitor, REASONS } = require('./consensus_input_monitor.js');
// The fetch guards, the MIN_STAKE resolution, the quorum and the boot settings live
// beside this file in capability_snapshot/ and are installed on the prototype below.
// axios stays here: the unit suites stub it for this module alone, so no part loads it.
const fetchGuardMethods  = require('./capability_snapshot/fetch_guards.js');
const minStakeMethods    = require('./capability_snapshot/min_stake.js');
const quorumMethods      = require('./capability_snapshot/quorum.js');
const bootSettingMethods = require('./capability_snapshot/boot_settings.js');

// Operator-facing detail lines for the non-transport failure classes. Held as
// constants because each is raised from all four fetchers and must read the
// same way in a log no matter which one tripped.
const NO_INDEXER_DETAIL = 'No BTC indexer URL could be resolved (BTC_INDEXER_API_URL / BTC_INDEXER_URL, or the ' +
    'configs table). Without it this hub can read NO consensus input at all.';
const MALFORMED_DETAIL  = 'The response carried no `validators` array. Refusing it rather than treating a wrong ' +
    'shape as an empty validator set (quorum 0 is indistinguishable from single-node mode).';
const WEIGHTLESS_DETAIL = 'A row in the source-keyed weight snapshot carried no usable `weight`. Refusing the whole ' +
    'snapshot: a missing weight read as 0 keeps the source in the dedupe map with no stake, shrinking the ' +
    'denominator S and LOWERING the two-thirds bar it is measured against.';

// The indexer answered but the JSON-RPC body is unusable. Keep the reported
// error text short: it lands in a log line, and the useful part is which of the
// two cases happened (no result at all vs. an explicit error).
function rpcErrorDetail(result) {
    if (!result) return 'The indexer returned no JSON-RPC result (empty or non-JSON body).';
    let msg = result.error && (result.error.message || result.error);
    return 'The indexer returned a JSON-RPC error: ' + String(msg).slice(0, 200) + '.';
}

class CapabilitySnapshot {

    constructor(hub) {
        this.hub = hub;
        // (capability:blockIndex) → { validators: [{pubkey, amount}], count, blockIndex, capability, expiresAt }
        this.cache = new Map();
        // How long to keep a snapshot. 60s default, enough to span a PBFT round.
        this.cacheTtlMs = 60 * 1000;
        // Reorg-depth buffer (#S-F7): every snapshot resolves at
        // (requested block - buffer), clamped at 0, instead of at the requested
        // height itself. Callers pass a tip-derived height, and stake state at
        // the tip is not reorg-safe: a shallow BTC reorg can rewrite the stake
        // set of the last few blocks, so a snapshot locked AT tip can serve a
        // pre-reorg validator set for up to the cache TTL. Resolving a few
        // blocks below the tip pins the set to a buried, reorg-stable height.
        // CONSENSUS-CRITICAL: the buffer is part of what every hub folds into
        // the same round height, so it must be identical federation-wide (same
        // tier as ORACLE_EPOCH_START). Override via HUB_SNAPSHOT_REORG_BUFFER
        // only as a coordinated fleet change; on mainnet/testnet a divergent
        // value now refuses boot rather than forking silently (#4167, see
        // resolveReorgBuffer). Default 6 = the BTC confirmation depth the
        // platform already treats as buried (XCHAIN_CONFIRMATIONS_BTC).
        this.reorgBufferBlocks = this.resolveReorgBuffer();
        // Last time we alarmed on a truncated validator-set snapshot (#4479).
        // Truncation is alarm-and-PROCEED (the snapshot is still usable and
        // cross-hub deterministic), so it is not a monitor failure and keeps
        // its own throttle stamp: one warning per cacheTtlMs, not one per call.
        this._truncWarnAt = 0;
        // Every path that returns a null snapshot reports here. The
        // monitor owns counting, per-reason log throttling and the alert flag
        // that /health turns into a degraded status, so a fail-closed hub is
        // visible instead of merely silent.
        this.monitor = new ConsensusInputMonitor({
            throttleMs:         this.cacheTtlMs,
            alertAfterFailures: this.resolveAlertAfterFailures()
        });
    }

    // Network qualifier folded into every cache key. HUB_NETWORK is read once at
    // process start, validated, and frozen onto the hub (XChainHub.js), so it is
    // invariant across every entry today and this prefix changes nothing for a
    // single-network process. It is bound explicitly so the network-safety of the
    // key is stated by construction rather than inferred: a future change that lets
    // one CapabilitySnapshot instance straddle networks (multi-network reader, a
    // test harness swapping hub.network, reuse across two indexer targets) can no
    // longer serve a mainnet snapshot for a testnet (capability, blockIndex) query.
    netKey() {
        return (this.hub && this.hub.network) || '';
    }

    // Fetch (or read from cache) the deterministic validator set for the given
    // capability at the given block boundary. Returns:
    //   { validators: [{pubkey, amount}, ...], count, blockIndex, capability }
    // Returns null when the indexer can't be reached or returns an error.
    async getSnapshot(capability, blockIndex) {
        blockIndex = this.buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;

        // Resolve this hub's MIN_STAKE, or refuse the read when a live registry has
        // none; the determinism and fork rationale for both sits on snapshotThreshold.
        const threshold = this.snapshotThreshold(capability, blockIndex);
        if (!threshold.ok) return null;
        let minStake = threshold.minStake;
        let key = this.netKey() + ':' + capability + ':' + blockIndex + ':' + (minStake === null ? '' : minStake);
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub.resolveBtcIndexerUrl();
        if (!url) return this.fail('getcapabilityvalidators', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

        let params = { capability: capability, block_index: blockIndex };
        if (minStake !== null) params.min_stake = minStake;

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getcapabilityvalidators',
                params:  params
            }, { headers: this.hub.btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return this.fail('getcapabilityvalidators', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this.coerceValidators(result);
            if (validators === null) return this.fail('getcapabilityvalidators', REASONS.MALFORMED, MALFORMED_DETAIL);
            if (!this.blockEchoOk('getcapabilityvalidators', result, blockIndex)) return null;
            if (!this.capabilityEchoOk('getcapabilityvalidators', result, capability)) return null;
            this.monitor.recordSuccess('getcapabilityvalidators');
            let snapshot = {
                capability:  result.capability,
                blockIndex:  result.block_index,
                count:       result.count,
                truncated:   result.truncated === true,
                validators:  validators,
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this.prune(now);
            return snapshot;
        } catch (err) {
            // Indexer unreachable / down (or 401/403 auth mismatch): caller falls
            // back to local validator set; onFetchError surfaces an auth misconfig.
            return this.onFetchError('getcapabilityvalidators', err);
        }
    }

    // Source-keyed weight snapshot for STAKE_WEIGHTED_QUORUM. Like getSnapshot but
    // each row carries { pubkey, source, weight } (the staking address + its
    // aggregate stake), so the quorum tally can dedupe by source. Cache key is
    // disjoint from the count snapshot ('w:' prefix). Returns null on indexer error.
    async getWeightSnapshot(capability, blockIndex) {
        blockIndex = this.buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;

        // min_stake rides in the cache key for the same reason as getSnapshot:
        // it determines the qualifying set, so a governance threshold change must
        // force a fresh fetch rather than serve a snapshot keyed to the old one.
        let minStake = this.resolveMinStake(capability, blockIndex);
        // Fail closed (#S-F3): see getSnapshot. A live registry with no threshold for
        // this capability must not fall back to the indexer's local config (fork risk).
        if (minStake === null && this.registryReady()) {
            this.warnMinStakeMissing(capability);
            return null;
        }
        let key = 'w:' + this.netKey() + ':' + capability + ':' + blockIndex + ':' + (minStake === null ? '' : minStake);
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub.resolveBtcIndexerUrl();
        if (!url) return this.fail('getstakeweightsbycapability', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

        let params = { capability: capability, block_index: blockIndex };
        if (minStake !== null) params.min_stake = minStake;

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getstakeweightsbycapability',
                params:  params
            }, { headers: this.hub.btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return this.fail('getstakeweightsbycapability', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this.coerceValidators(result, { requireWeight: true });
            if (validators === null) return this.fail('getstakeweightsbycapability', REASONS.MALFORMED,
                Array.isArray(result.validators) ? WEIGHTLESS_DETAIL : MALFORMED_DETAIL);
            if (!this.blockEchoOk('getstakeweightsbycapability', result, blockIndex)) return null;
            if (!this.capabilityEchoOk('getstakeweightsbycapability', result, capability)) return null;
            this.monitor.recordSuccess('getstakeweightsbycapability');
            let snapshot = {
                capability:  result.capability,
                blockIndex:  result.block_index,
                count:       result.count,
                truncated:   result.truncated === true,
                sourceCount: result.source_count,
                validators:  validators,                   // [{pubkey, source, weight}]
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this.prune(now);
            return snapshot;
        } catch (err) {
            return this.onFetchError('getstakeweightsbycapability', err);
        }
    }

    // Whole-federation snapshot: every pubkey with ANY active stake at the
    // block, regardless of capability. Used by Consensus (config-change PBFT)
    // where quorum is over all stakers, not a capability subset. Cache key is
    // disjoint from capability snapshots (capability='*').
    async getActiveValidatorSnapshot(blockIndex) {
        blockIndex = this.buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;
        let key = '*:' + this.netKey() + ':' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub.resolveBtcIndexerUrl();
        if (!url) return this.fail('getactivevalidators', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getactivevalidators',
                params:  { block_index: blockIndex }
            }, { headers: this.hub.btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return this.fail('getactivevalidators', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this.coerceValidators(result);
            if (validators === null) return this.fail('getactivevalidators', REASONS.MALFORMED, MALFORMED_DETAIL);
            if (!this.blockEchoOk('getactivevalidators', result, blockIndex)) return null;
            this.monitor.recordSuccess('getactivevalidators');
            let snapshot = {
                capability:  '*',
                blockIndex:  result.block_index,
                count:       result.count,
                truncated:   result.truncated === true,
                validators:  validators,
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this.prune(now);
            return snapshot;
        } catch (err) {
            return this.onFetchError('getactivevalidators', err);
        }
    }

    // Source-keyed whole-federation weight snapshot: every staker with ANY active
    // stake at the block (no capability filter), each row carrying { pubkey, source,
    // weight }. The STAKE_WEIGHTED_QUORUM counterpart of getActiveValidatorSnapshot,
    // used by Consensus (config-change PBFT) to weight quorum by stake. Cache key is
    // disjoint ('wa:' prefix). Returns null on indexer error.
    async getActiveWeightSnapshot(blockIndex) {
        blockIndex = this.buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;
        let key = 'wa:' + this.netKey() + ':' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub.resolveBtcIndexerUrl();
        if (!url) return this.fail('getactivestakeweights', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getactivestakeweights',
                params:  { block_index: blockIndex }
            }, { headers: this.hub.btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return this.fail('getactivestakeweights', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this.coerceValidators(result, { requireWeight: true });
            if (validators === null) return this.fail('getactivestakeweights', REASONS.MALFORMED,
                Array.isArray(result.validators) ? WEIGHTLESS_DETAIL : MALFORMED_DETAIL);
            if (!this.blockEchoOk('getactivestakeweights', result, blockIndex)) return null;
            this.monitor.recordSuccess('getactivestakeweights');
            let snapshot = {
                capability:  '*',
                blockIndex:  result.block_index,
                count:       result.count,
                truncated:   result.truncated === true,
                sourceCount: result.source_count,
                validators:  validators,                   // [{pubkey, source, weight}]
                expiresAt:   now + this.cacheTtlMs
            };
            this.cache.set(key, snapshot);
            this.prune(now);
            return snapshot;
        } catch (err) {
            return this.onFetchError('getactivestakeweights', err);
        }
    }

    // Drop every cached snapshot for a capability: both the count-keyed
    // (net:capability:...) and the weight-keyed (w:net:capability:...) entries.
    // Called when a governance MIN_STAKE change lands so the next consensus read
    // re-queries the indexer under the new threshold. With min_stake folded into
    // the cache key the stale entries are already unreachable; this reclaims them
    // immediately instead of waiting for the TTL to prune them. The network
    // qualifier rides in the key ahead of the capability, so the prefixes carry it
    // too. Returns the count of entries removed. The '*'-keyed whole-federation
    // snapshots carry no capability filter and are intentionally left untouched.
    flushCapability(capability) {
        if (!capability) return 0;
        let net = this.netKey();
        let prefixes = [net + ':' + capability + ':', 'w:' + net + ':' + capability + ':'];
        let removed = 0;
        for (let k of this.cache.keys()) {
            for (let p of prefixes) {
                if (k.indexOf(p) === 0) { this.cache.delete(k); removed++; break; }
            }
        }
        return removed;
    }

    // Map a caller-supplied (tip-derived) height to the buried height every
    // snapshot actually resolves at: max(0, blockIndex - reorgBufferBlocks).
    // Returns null for a null/undefined/non-numeric input (the fetchers'
    // existing "no height" sentinel), so callers still degrade gracefully.
    // The buried height feeds the cache key, the indexer RPC and the echo
    // guard alike, so the snapshot is labeled with the height it truly
    // represents.
    buriedBlockIndex(blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;
        let n = Number(blockIndex);
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.floor(n) - this.reorgBufferBlocks);
    }

    prune(now) {
        for (let [k, v] of this.cache) {
            if (v.expiresAt <= now) this.cache.delete(k);
        }
    }
}

// Install each part's methods on the prototype non-enumerably, as src/db/index.js does,
// so a moved method stays indistinguishable from one declared in the class above. A
// name already on the prototype throws rather than one part replacing another's method.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate CapabilitySnapshot method: ' + name + ' is already on the prototype');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(CapabilitySnapshot.prototype, [fetchGuardMethods, minStakeMethods, quorumMethods, bootSettingMethods]);

module.exports = CapabilitySnapshot;
