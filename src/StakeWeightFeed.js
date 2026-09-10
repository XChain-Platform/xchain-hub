'use strict';

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
 * XChain Hub - StakeWeightFeed
 *
 * The federation's stake view for a hub that holds no capability config of its
 * own: a hub that receives the validators' frames over the mesh but serves no
 * capability itself, so nothing ever wrote it a MIN_STAKE threshold.
 *
 * Two things depended on that threshold and both failed closed without it.
 * CapabilitySnapshot refuses to build a snapshot when a live capability registry
 * resolves no floor for a capability, because omitting min_stake would let each
 * indexer apply its OWN local threshold and fork the qualifying set; with the
 * registry seeded from an absent HUB_CAPABILITY_CONFIG that refusal fired on
 * EVERY round, so a weighted round never found the weight snapshot it needs.
 * And the oracle submission audit resolved a sender through the hand-maintained
 * addr->key registry alone, which such a hub has no reason to carry rows in.
 *
 * The floor served here is the canonical one from the pinned BTC staking bundle
 * (coins/BTC.js STAKING.CAPABILITIES), NOT a local invention: it is the same
 * value XChainHub._assertCanonicalMinStakes requires every configured hub to
 * carry, refusing boot on a divergence, and the bundle itself is verified
 * against CONSENSUS_CONFIG_PIN before the hub opens its database. So the request
 * this feed lets the hub form is byte-for-byte the request its validators form,
 * against the same indexer RPC at the same buried height, and the snapshot that
 * comes back is theirs rather than a second opinion.
 *
 * Membership is answered off that same snapshot, so a sender is authorized by
 * on-chain qualifying stake rather than by an operator-typed registry row. That
 * is the stronger of the two attributions and it is the set the round's own
 * aggregation already filters submissions down to.
 *
 * The feed never overrides a configured threshold: CapabilitySnapshot asks it
 * only after the registry answered null, so a validator hub reaches none of this.
 *
 ********************************************************************/

const coins = require('./coins');

class StakeWeightFeed {

    constructor(hub) {
        this.hub = hub;
        // Resolved floors, keyed by capability. The bundle is frozen for the
        // process, so a name resolves once and a name the bundle does not carry
        // is remembered as null rather than re-resolved every round.
        this._floors = new Map();
        // Rounds whose membership question this feed answered from a snapshot,
        // and those it could not. Read by getDiagnostics on the oracle path.
        this.membershipResolved   = 0;
        this.membershipUnresolved = 0;
    }

    // The federation's qualifying floor for `capability` as a decimal string, or
    // null when the canonical bundle carries no entry under that name (an
    // unknown capability, or a coin config that will not resolve). Null leaves
    // every caller on its existing fail-closed path.
    minStake(capability) {
        let key = String(capability);
        if (this._floors.has(key)) return this._floors.get(key);
        let value = this._resolveFloor(key);
        this._floors.set(key, value);
        return value;
    }

    // Whether `pubkey` holds qualifying stake for `capability` at `blockIndex`,
    // read from the SAME weight snapshot the round is evaluated under. Returns
    // false when the snapshot cannot be resolved, so an unreachable Bitcoin view
    // authorizes nobody.
    async isQualified(capability, blockIndex, pubkey) {
        if (!pubkey) return false;
        let members = await this.qualifiedPubkeys(capability, blockIndex);
        if (!members) return false;
        return members.has(String(pubkey).toLowerCase());
    }

    // Lowercased pubkeys of the qualifying set at `blockIndex`, or null when the
    // snapshot is unavailable. Deliberately not cached here: CapabilitySnapshot
    // already caches the snapshot itself for a full PBFT round, and a second
    // cache would outlive a stake change the first one has let go.
    async qualifiedPubkeys(capability, blockIndex) {
        let snapshot = await this._weightSnapshot(capability, blockIndex);
        if (!snapshot || !Array.isArray(snapshot.validators)) {
            this.membershipUnresolved++;
            return null;
        }
        this.membershipResolved++;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set;
    }

    // The weight snapshot, or null. Guarded because every caller here is on a
    // best-effort path beside a consensus decision that has already been made:
    // an indexer fault must cost an audit row, never the round.
    async _weightSnapshot(capability, blockIndex) {
        let cs = this.hub && this.hub.capabilitySnapshot;
        if (!cs || typeof cs.getWeightSnapshot !== 'function') return null;
        try {
            return await cs.getWeightSnapshot(capability, blockIndex);
        } catch (e) {
            console.warn('StakeWeightFeed: could not resolve the ' + capability + ' weight snapshot at block ' +
                blockIndex + ': ' + ((e && e.message) ? e.message : e));
            return null;
        }
    }

    // Read the floor out of the canonical staking bundle. Staking is BTC-anchored,
    // so BTC is the only bundle that carries thresholds, and the network follows
    // XChainHub._assertCanonicalMinStakes' own convention (a hub that declared
    // none is asserted against mainnet).
    _resolveFloor(capability) {
        let network = (this.hub && this.hub.network) || 'mainnet';
        let entry;
        try {
            let cfg = coins.getCoinConfig('BTC', network);
            let caps = (cfg.STAKING && cfg.STAKING.CAPABILITIES) ? cfg.STAKING.CAPABILITIES : null;
            entry = caps ? caps[capability] : null;
        } catch (e) {
            console.warn('StakeWeightFeed: no canonical BTC staking bundle for network "' + network +
                '" (' + ((e && e.message) ? e.message : e) + '); serving no floor for ' + capability + '.');
            return null;
        }
        if (!entry || entry.MIN_STAKE === undefined || entry.MIN_STAKE === null) return null;
        return String(entry.MIN_STAKE);
    }
}

module.exports = StakeWeightFeed;
