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
 * XChain Hub - CapabilitySnapshot MIN_STAKE resolution
 *
 * Where the qualifying-stake threshold a capability snapshot requests comes
 * from, and the fail-closed refusal when a live registry has none.
 * src/validators/capability_snapshot.js installs every method below on
 * CapabilitySnapshot.prototype, so callers keep writing snapshot.<method>().
 *
 ********************************************************************/

const { REASONS } = require('../consensus_input_monitor.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Resolve the MIN_STAKE a capability snapshot read folds into its RPC and its
    // cache key as { ok: true, minStake }, or { ok: false } when the read must be
    // refused. getSnapshot reads its threshold here.
    //
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
    snapshotThreshold(capability, blockIndex) {
        let minStake = this.resolveMinStake(capability, blockIndex);
        // Fail closed (#S-F3): a null threshold from a LIVE registry means this
        // capability is unconfigured, and falling back to the indexer's local config
        // silently forks the qualifying set across independently-operated indexers.
        // Refuse the snapshot so the caller declines to vote / aborts the round.
        if (minStake === null && this.registryReady()) {
            this.warnMinStakeMissing(capability);
            return { ok: false, minStake: null };
        }
        return { ok: true, minStake: minStake };
    },

    // Resolve this hub's authoritative MIN_STAKE threshold for a capability as a
    // string (the form the indexer RPC and the cache key expect), or null when
    // the registry isn't wired yet (pre-startCapabilities) or has no threshold
    // for the capability (in which case the indexer falls back to its own config).
    // Threading blockIndex makes the snapshot federation-deterministic: every hub
    // resolves the same threshold for the same block from block-anchored governance
    // history, so they fold the identical min_stake into the cache key and request
    // the identical qualifying set (#3703).
    resolveMinStake(capability, blockIndex) {
        let reg = this.hub.capabilityRegistry;
        if (!reg || typeof reg.getMinStake !== 'function') return null;
        let v = reg.getMinStake(capability, blockIndex);
        if (v !== null && v !== undefined) return String(v);
        return this.feedMinStake(capability);
    },

    // Second and last place a threshold can come from: the hub's stake-weight feed.
    // A hub that serves no capability of its own carries no HUB_CAPABILITY_CONFIG,
    // so its live registry resolves null for every name and the guards above refused
    // EVERY snapshot it ever asked for. That is not the fork the refusal exists to
    // stop: the fork case is omitting min_stake and letting each indexer apply its
    // own local threshold, and the feed omits nothing. It answers with the canonical
    // floor from the pinned staking bundle, which is the value
    // XChainHub.assertCanonicalMinStakes refuses to let a configured hub diverge
    // from, so the request formed here is the request every peer forms.
    //
    // A configured threshold always wins (this is only reached once the registry
    // answered null), and a hub with no feed keeps the refusal byte for byte.
    feedMinStake(capability) {
        let feed = this.hub && this.hub.stakeWeightFeed;
        if (!feed || typeof feed.minStake !== 'function') return null;
        let v;
        try { v = feed.minStake(capability); }
        catch (e) { return null; }
        if (v === null || v === undefined) return null;
        this.noteFeedFloor(capability, v);
        return String(v);
    },

    // Say once per capability that this hub is reading the federation's floor
    // rather than its own, so the operator can tell a deliberate config-free hub
    // from one whose capability file failed to load.
    noteFeedFloor(capability, value) {
        if (!this._feedFloorNoted) this._feedFloorNoted = new Set();
        if (this._feedFloorNoted.has(capability)) return;
        this._feedFloorNoted.add(capability);
        logger.info('CapabilitySnapshot: no configured MIN_STAKE for "' + capability +
            '"; using the canonical federation floor ' + value + ' from the stake-weight feed. ' +
            'Set CAPABILITY_' + String(capability).toUpperCase() + '_MIN_STAKE in HUB_CAPABILITY_CONFIG ' +
            'to pin it locally.');
    },

    // True once the capability registry is wired (post-startCapabilities). The
    // registry seeds a genesis MIN_STAKE for every CONFIGURED capability in its
    // constructor (synchronously), so a null threshold from a READY registry means
    // the capability was never put in HUB_CAPABILITY_CONFIG, not that we are mid-
    // startup. Before the registry exists, min_stake is legitimately omitted (no
    // consensus rounds run pre-startCapabilities); this distinguishes the two.
    registryReady() {
        let reg = this.hub && this.hub.capabilityRegistry;
        return !!(reg && typeof reg.getMinStake === 'function');
    },

    // Throttled loud alarm for a wired-but-unconfigured capability threshold.
    // Routed through the monitor like every other fail-closed path, sub-keyed by
    // capability so a second missing threshold is not swallowed by the first
    // one's throttle window.
    warnMinStakeMissing(capability) {
        this.fail('getsnapshot', REASONS.MIN_STAKE,
            'Capability "' + capability + '" has NO configured MIN_STAKE threshold (missing from ' +
            'HUB_CAPABILITY_CONFIG) while the registry is live. Refusing to build a snapshot for it: omitting ' +
            'min_stake would let each indexer apply its OWN local threshold, so two hubs could qualify different ' +
            'validator sets for the same round and FORK. Add CAPABILITY_' + String(capability).toUpperCase() +
            '_MIN_STAKE to HUB_CAPABILITY_CONFIG (equal to the indexer constant).',
            String(capability));
    }
};
