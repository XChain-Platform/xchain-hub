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
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
// Consensus-input fetches fail closed but used to fail SILENTLY for
// every reason except auth and echo mismatch. The monitor counts every outcome,
// owns the log throttle, and raises the alert that /health reports.
const { ConsensusInputMonitor, REASONS, classifyFetchError } = require('./lib/consensus_input_monitor.js');

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

// A weight is a plain decimal string, exactly as stake_weighted_quorum.bcnum
// accepts one. Kept identical to that predicate's own pattern so a row this
// class admits can never be one the predicate then fails closed on.
const NUMERIC_WEIGHT = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// The canonical reorg-depth buffer every hub in a federation must resolve
// snapshots at. 6 = the BTC confirmation depth the platform already treats as
// buried (XCHAIN_CONFIRMATIONS_BTC). Named once so the default and the
// divergence assertion below can never drift apart.
//
// The literal now comes from the shared, byte-vendored
// snapshot_reorg_buffer.js rather than living here, because the three verifier
// families outside this repo (indexer attest.js, indexer recovery.js, sdk
// light.js) must bury by the SAME depth the signer buried by. A hub-local 6 and
// a verifier-local 6 that drift apart resolve different validator sets for the
// same declared height with nothing logged.
const { CANONICAL_REORG_BUFFER } = require('./snapshot_reorg_buffer.js');

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
        // _resolveReorgBuffer). Default 6 = the BTC confirmation depth the
        // platform already treats as buried (XCHAIN_CONFIRMATIONS_BTC).
        this.reorgBufferBlocks = this._resolveReorgBuffer();
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
            alertAfterFailures: this._resolveAlertAfterFailures()
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
    _netKey() {
        return (this.hub && this.hub.network) || '';
    }

    // Classify a federation-read failure and return null (the fetch helpers'
    // "indexer unavailable" sentinel). A 401/403 is NOT "indexer down": it means
    // the hub's x-api-key (BTC_INDEXER_API_KEY) does not match the indexer's
    // INDEXER_API_KEY. Swallowed silently (as every catch did), that misconfig is
    // indistinguishable from a dead indexer or an empty validator set, so every
    // attestation round and config-change quorum collapses to a null snapshot
    // while nothing points the operator at auth. Surface it distinctly, throttled.
    _onFetchError(method, err) {
        let reason = classifyFetchError(err);
        let detail;
        if (reason === REASONS.AUTH) {
            detail = 'HTTP ' + err.response.status + ': the hub\'s x-api-key (BTC_INDEXER_API_KEY) does not ' +
                'match the indexer\'s INDEXER_API_KEY. Federation snapshots stay NULL (attestation + ' +
                'config-change quorum collapse) until the two keys match.';
        } else if (reason === REASONS.HTTP_ERROR) {
            detail = 'HTTP ' + err.response.status + ' from the BTC indexer.';
        } else {
            detail = 'The BTC indexer did not respond (' + ((err && err.message) || 'unknown transport error') +
                '); check that it is running and reachable at the configured URL.';
        }
        return this._fail(method, reason, detail);
    }

    // Record a consensus-input failure and return the null sentinel every fetch
    // path already uses. Single choke point so no future null-return can be
    // added without also raising the alarm (the exact regression the
    // consensus-input monitor closes).
    _fail(method, reason, detail, throttleKey) {
        this.monitor.recordFailure(method, reason, detail, throttleKey);
        return null;
    }

    // Coerce an indexer result's `validators` field into a real array, or return
    // null when the shape is MALFORMED. A valid response always carries a
    // validators array (possibly empty after the qualifying-stake filter, or
    // capped when `truncated`); both of those are LEGITIMATE and must produce a
    // real snapshot, so an actual array (even length 0) passes through. Anything
    // else (missing field, object, string, number) is a parse failure / wrong
    // shape and returns null, which routes the caller through the consensus
    // fail-closed gate instead of silently yielding a zero-validator snapshot
    // (quorum=0) that is indistinguishable from single-node.
    //
    // On the WEIGHT fetchers the caller passes requireWeight, and a row
    // whose weight is missing/blank/nonnumeric makes the whole snapshot MALFORMED.
    // stake_weighted_quorum fails closed on such a row, but only if it ever sees
    // one: every consumer of this snapshot re-maps it through
    // `String(v.weight != null ? v.weight : '0')`, which launders a missing weight
    // into a real '0' and hands the predicate a well-formed row carrying no stake.
    // That is the exact defect the predicate guards against - the source stays in
    // the dedupe map, S shrinks, and a smaller real stake clears 3*tally > 2*S -
    // so the rejection has to happen HERE, at the point the wire row enters the
    // hub, not at the predicate the laundering hides it from. Rejecting the whole
    // snapshot (rather than dropping the row) is deliberate: dropping a row shrinks
    // S exactly the same way. A legitimate '0' weight still passes.
    _coerceValidators(result, opts) {
        if (!result || !Array.isArray(result.validators)) return null;
        if (opts && opts.requireWeight) {
            for (let v of result.validators) {
                if (!v || v.weight === null || v.weight === undefined) return null;
                let w = String(v.weight).trim();
                if (w === '' || !NUMERIC_WEIGHT.test(w)) return null;
            }
        }
        return result.validators;
    }

    // Freshness / echo guard. The indexer fail-closes on a not-yet-indexed block
    // (`block_index > latest` -> error, surfaced here as a null snapshot) and
    // echoes the REQUESTED block on success, so a mismatch means the indexer
    // answered for a different height than asked. Locking a snapshot mislabeled
    // with `requested` would let two hubs compute quorum over different validator
    // sets for the same round. Reject on mismatch (throttled log follows the
    // auth idiom with its own field, so echo and auth alarms never mask each
    // other). Returns true when the echoed block matches the request.
    _blockEchoOk(method, result, requested) {
        if (Number(result.block_index) === Number(requested)) return true;
        this._fail(method, REASONS.ECHO_MISMATCH,
            'Returned block_index ' + result.block_index + ' for requested block ' + requested +
            '; rejecting the snapshot (freshness/echo mismatch, possible indexer bug or misconfiguration).');
        return false;
    }

    // The OTHER half of the request key, guarded the same way and for the same
    // reason. `capability` selects which stake rows the indexer filters, so a
    // response answering for a different capability is a validator set for the wrong
    // population - and it would be cached under the REQUESTED key for the full TTL
    // and consumed as the round's N by every quorum caller. Strict, exactly like the
    // block echo: an ABSENT capability field fails too, because a stripped field is
    // indistinguishable here from a wrong one. Fail-closed costs this hub a vote;
    // fail-open casts a wrong one. Only the two capability-scoped fetchers call this;
    // the whole-federation ('*') fetchers send no capability and have nothing to echo.
    _capabilityEchoOk(method, result, requested) {
        if (String(result.capability) === String(requested)) return true;
        this._fail(method, REASONS.ECHO_MISMATCH,
            'Returned capability ' + result.capability + ' for requested capability ' + requested +
            '; rejecting the snapshot (echo mismatch, possible indexer bug or misconfiguration).');
        return false;
    }

    // Fetch (or read from cache) the deterministic validator set for the given
    // capability at the given block boundary. Returns:
    //   { validators: [{pubkey, amount}, ...], count, blockIndex, capability }
    // Returns null when the indexer can't be reached or returns an error.
    async getSnapshot(capability, blockIndex) {
        blockIndex = this._buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;

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
        // Fail closed (#S-F3): a null threshold from a LIVE registry means this
        // capability is unconfigured, and falling back to the indexer's local config
        // silently forks the qualifying set across independently-operated indexers.
        // Refuse the snapshot so the caller declines to vote / aborts the round.
        if (minStake === null && this._registryReady()) {
            this._warnMinStakeMissing(capability);
            return null;
        }
        let key = this._netKey() + ':' + capability + ':' + blockIndex + ':' + (minStake === null ? '' : minStake);
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return this._fail('getcapabilityvalidators', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

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
            if (!result || result.error) return this._fail('getcapabilityvalidators', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this._coerceValidators(result);
            if (validators === null) return this._fail('getcapabilityvalidators', REASONS.MALFORMED, MALFORMED_DETAIL);
            if (!this._blockEchoOk('getcapabilityvalidators', result, blockIndex)) return null;
            if (!this._capabilityEchoOk('getcapabilityvalidators', result, capability)) return null;
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
        blockIndex = this._buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;

        // min_stake rides in the cache key for the same reason as getSnapshot:
        // it determines the qualifying set, so a governance threshold change must
        // force a fresh fetch rather than serve a snapshot keyed to the old one.
        let minStake = this._resolveMinStake(capability, blockIndex);
        // Fail closed (#S-F3): see getSnapshot. A live registry with no threshold for
        // this capability must not fall back to the indexer's local config (fork risk).
        if (minStake === null && this._registryReady()) {
            this._warnMinStakeMissing(capability);
            return null;
        }
        let key = 'w:' + this._netKey() + ':' + capability + ':' + blockIndex + ':' + (minStake === null ? '' : minStake);
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return this._fail('getstakeweightsbycapability', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

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
            if (!result || result.error) return this._fail('getstakeweightsbycapability', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this._coerceValidators(result, { requireWeight: true });
            if (validators === null) return this._fail('getstakeweightsbycapability', REASONS.MALFORMED,
                Array.isArray(result.validators) ? WEIGHTLESS_DETAIL : MALFORMED_DETAIL);
            if (!this._blockEchoOk('getstakeweightsbycapability', result, blockIndex)) return null;
            if (!this._capabilityEchoOk('getstakeweightsbycapability', result, capability)) return null;
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
        blockIndex = this._buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;
        let key = '*:' + this._netKey() + ':' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return this._fail('getactivevalidators', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getactivevalidators',
                params:  { block_index: blockIndex }
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return this._fail('getactivevalidators', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this._coerceValidators(result);
            if (validators === null) return this._fail('getactivevalidators', REASONS.MALFORMED, MALFORMED_DETAIL);
            if (!this._blockEchoOk('getactivevalidators', result, blockIndex)) return null;
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
        blockIndex = this._buriedBlockIndex(blockIndex);
        if (blockIndex === null) return null;
        let key = 'wa:' + this._netKey() + ':' + blockIndex;
        let cached = this.cache.get(key);
        let now = Date.now();
        if (cached && cached.expiresAt > now) return cached;

        let url = await this.hub._resolveBtcIndexerUrl();
        if (!url) return this._fail('getactivestakeweights', REASONS.NO_INDEXER, NO_INDEXER_DETAIL);

        try {
            let res = await axios.post(url, {
                jsonrpc: '2.0',
                id:      now,
                method:  'getactivestakeweights',
                params:  { block_index: blockIndex }
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            let result = res && res.data && res.data.result;
            if (!result || result.error) return this._fail('getactivestakeweights', REASONS.RPC_ERROR, rpcErrorDetail(result));
            let validators = this._coerceValidators(result, { requireWeight: true });
            if (validators === null) return this._fail('getactivestakeweights', REASONS.MALFORMED,
                Array.isArray(result.validators) ? WEIGHTLESS_DETAIL : MALFORMED_DETAIL);
            if (!this._blockEchoOk('getactivestakeweights', result, blockIndex)) return null;
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
        // Coerce N from the raw indexer JSON. `count` can arrive as a STRING; left
        // uncoerced, `Math.ceil((N + 1) / 2)` string-concatenates ("5" + 1 -> "51")
        // and explodes the quorum (26-of-5 -> permanent consensus halt / DoS). Fall
        // back to the actual membership-set size when count is not a sane integer, so
        // a malformed count can never silently drop quorum to a single-node bypass.
        let N = Number(snapshot.count);
        if (!Number.isInteger(N) || N < 0) N = Array.isArray(snapshot.validators) ? snapshot.validators.length : 0;
        // N<=1: single node (0 = caller bypasses consensus). Above that, the
        // majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    }

    // Whether a pubkey appears in the snapshot's validator set (used to gate PBFT vote counting).
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
    // Threading blockIndex makes the snapshot federation-deterministic: every hub
    // resolves the same threshold for the same block from block-anchored governance
    // history, so they fold the identical min_stake into the cache key and request
    // the identical qualifying set (#3703).
    _resolveMinStake(capability, blockIndex) {
        let reg = this.hub.capabilityRegistry;
        if (!reg || typeof reg.getMinStake !== 'function') return null;
        let v = reg.getMinStake(capability, blockIndex);
        return (v === null || v === undefined) ? null : String(v);
    }

    // True once the capability registry is wired (post-startCapabilities). The
    // registry seeds a genesis MIN_STAKE for every CONFIGURED capability in its
    // constructor (synchronously), so a null threshold from a READY registry means
    // the capability was never put in HUB_CAPABILITY_CONFIG, not that we are mid-
    // startup. Before the registry exists, min_stake is legitimately omitted (no
    // consensus rounds run pre-startCapabilities); this distinguishes the two.
    _registryReady() {
        let reg = this.hub && this.hub.capabilityRegistry;
        return !!(reg && typeof reg.getMinStake === 'function');
    }

    // Throttled loud alarm for a wired-but-unconfigured capability threshold.
    // Routed through the monitor like every other fail-closed path, sub-keyed by
    // capability so a second missing threshold is not swallowed by the first
    // one's throttle window.
    _warnMinStakeMissing(capability) {
        this._fail('getsnapshot', REASONS.MIN_STAKE,
            'Capability "' + capability + '" has NO configured MIN_STAKE threshold (missing from ' +
            'HUB_CAPABILITY_CONFIG) while the registry is live. Refusing to build a snapshot for it: omitting ' +
            'min_stake would let each indexer apply its OWN local threshold, so two hubs could qualify different ' +
            'validator sets for the same round and FORK. Add CAPABILITY_' + String(capability).toUpperCase() +
            '_MIN_STAKE to HUB_CAPABILITY_CONFIG (equal to the indexer constant).',
            String(capability));
    }

    // Consecutive consensus-input failures before the monitor raises the alert
    // and /health flips to degraded. Operator-tunable for a venue with a flaky
    // link; a non-positive or non-integer value falls back to the default rather
    // than disabling the alarm (a typo must not silently restore the old
    // silent-fail-closed behaviour).
    _resolveAlertAfterFailures() {
        let raw = process.env.HUB_CONSENSUS_INPUT_ALERT_AFTER;
        if (raw === undefined || raw === '') return undefined;
        let n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
            console.error('CapabilitySnapshot: HUB_CONSENSUS_INPUT_ALERT_AFTER "' + raw + '" is not a positive ' +
                'integer; using the default consensus-input alert threshold.');
            return undefined;
        }
        return n;
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
        let net = this._netKey();
        let prefixes = [net + ':' + capability + ':', 'w:' + net + ':' + capability + ':'];
        let removed = 0;
        for (let k of this.cache.keys()) {
            for (let p of prefixes) {
                if (k.indexOf(p) === 0) { this.cache.delete(k); removed++; break; }
            }
        }
        return removed;
    }

    // Resolve the reorg-depth buffer from HUB_SNAPSHOT_REORG_BUFFER (default 6).
    // Only a non-negative integer is accepted; anything else warns loudly and
    // falls back to the default rather than silently forking the federation on
    // a typo'd env value.
    //
    // A VALID but non-canonical value is the sharper hazard and is why this is
    // more than a parse (#4167): the buffer is subtracted before the cache key
    // and the indexer RPC are formed, so two hubs handed the same requested
    // height resolve DIFFERENT blocks, and their validator sets and quorum N
    // diverge with nothing logged. Mainnet/testnet therefore refuse the value
    // outright (throws out of the constructor, halting boot fail-closed);
    // regtest/standalone warn and accept so test venues can run deliberate
    // depths. XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1 is the loud one-off bypass
    // for a coordinated fleet-wide change. Same shape and same reasoning as
    // XChainHub._assertCanonicalMinStakes, which guards the identical fork
    // class for MIN_STAKE.
    _resolveReorgBuffer() {
        let raw = process.env.HUB_SNAPSHOT_REORG_BUFFER;
        if (raw === undefined || raw === '') return CANONICAL_REORG_BUFFER;
        let n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
            console.error('CapabilitySnapshot: HUB_SNAPSHOT_REORG_BUFFER "' + raw + '" is not a ' +
                'non-negative integer; using the default (' + CANONICAL_REORG_BUFFER + '). This value ' +
                'is CONSENSUS-CRITICAL and must match across the federation.');
            return CANONICAL_REORG_BUFFER;
        }
        if (n === CANONICAL_REORG_BUFFER) return n;
        let detail = 'HUB_SNAPSHOT_REORG_BUFFER is ' + n + ' but the canonical federation value is ' +
            CANONICAL_REORG_BUFFER + '. Every hub subtracts this buffer before resolving a snapshot, ' +
            'so a hub running a different value locks a different block for the same round: divergent ' +
            'validator sets and quorum N across the federation. Change it fleet-wide or not at all ' +
            '(XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1 to bypass on a venue where every hub runs the SAME override).';
        if (process.env.XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT === '1') {
            console.warn('XCHAIN_HUB_SKIP_REORG_BUFFER_ASSERT=1: skipping the canonical reorg-buffer ' +
                'assertion. ' + detail);
            return n;
        }
        // Strict only on a declared consensus network: standalone ('' - no
        // consensus runs) and regtest venues warn instead of refusing.
        let network = (this.hub && this.hub.network) || '';
        if (network === 'mainnet' || network === 'testnet') {
            let err = new Error('CapabilitySnapshot: ' + detail);
            err.code = 'REORG_BUFFER_MISMATCH';
            throw err;
        }
        console.warn('CapabilitySnapshot: reorg-buffer mismatch (non-strict on ' +
            (network || 'standalone') + '): ' + detail);
        return n;
    }

    // Map a caller-supplied (tip-derived) height to the buried height every
    // snapshot actually resolves at: max(0, blockIndex - reorgBufferBlocks).
    // Returns null for a null/undefined/non-numeric input (the fetchers'
    // existing "no height" sentinel), so callers still degrade gracefully.
    // The buried height feeds the cache key, the indexer RPC and the echo
    // guard alike, so the snapshot is labeled with the height it truly
    // represents.
    _buriedBlockIndex(blockIndex) {
        if (blockIndex === undefined || blockIndex === null) return null;
        let n = Number(blockIndex);
        if (!Number.isFinite(n)) return null;
        return Math.max(0, Math.floor(n) - this.reorgBufferBlocks);
    }

    _prune(now) {
        for (let [k, v] of this.cache) {
            if (v.expiresAt <= now) this.cache.delete(k);
        }
    }
}

module.exports = CapabilitySnapshot;
