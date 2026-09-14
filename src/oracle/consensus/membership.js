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
 * XChain Hub - Oracle Consensus: the round-locked validator set
 *
 * Who counts for a round: the snapshot normalization and member set, the submission
 * filter, leader election and the addr/pubkey resolution it needs, and the quorum and
 * snapshot predicates every guard on both round paths shares.
 *
 ********************************************************************/

'use strict';

const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');

module.exports = {

    // Normalize a locked snapshot's validators into the source-keyed shape the
    // weighted predicate needs ([{pubkey:lower, source, weight}]); [] in count mode.
    // Mirrors Consensus.normalizeValidators, including the truncation carry.
    //
    // SWQ-TRUNC parity: the marker is a plain array property CapabilitySnapshot sets on
    // the SNAPSHOT, so the .map below drops it while meetsStakeThreshold reads it off the
    // array it is handed. Without the carry a round locked over a capped snapshot loses
    // its fail-closed guard and an under-counted S lets a minority of stake clear the 2/3
    // bar. Same one-liner as the sibling rebuilds in this file (:2083) and in
    // CrossChainDexEngine.js / StakeShareWatcher.js.
    normalizeValidators(snapshot, weighted) {
        if (!weighted || !snapshot || !Array.isArray(snapshot.validators)) return [];
        let out = snapshot.validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            source: String(v.source != null ? v.source : ''),
            weight: String(v.weight != null ? v.weight : '0')
        }));
        if (snapshot.truncated === true) out.truncated = true;
        return out;
    },

    // Pubkey set of a locked capability snapshot, or null when there is no usable
    // snapshot (indexer unreachable / empty validators). Null disables the
    // membership filter, preserving the legacy graceful-degradation path; the
    // empty-snapshot case is separately skipped via isEmptyFederationSnapshot.
    memberPubkeySet(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set.size > 0 ? set : null;
    },

    // Oracle M1: restrict a sender-keyed submission map to validators that are
    // members of the round's locked price snapshot, one submission per PUBKEY.
    // Quorum is sized from the snapshot, so submissions from merely-REGISTERED
    // validators (no qualifying stake) must not reach the trimmed median, the
    // minSubmissions floor, or the fallback-proposer election; and since the
    // registry may bind one key to several addrs, dedup on the verified key,
    // first arrival wins (Map iteration is insertion-ordered). A null memberPubkeys
    // (no usable snapshot) returns the map unchanged (legacy behavior).
    filterSubmissionsToSnapshot(submissions, memberPubkeys) {
        if (!submissions || !memberPubkeys) return submissions;
        let filtered = new Map();
        let seen = new Set();
        for (let [addr, sub] of submissions) {
            let pk = (sub && sub.pubkey) ? sub.pubkey : this.resolveSenderPubkey(addr);
            if (!pk || !memberPubkeys.has(pk)) continue;
            if (seen.has(pk)) continue;
            seen.add(pk);
            filtered.set(addr, sub);
        }
        return filtered;
    },

    // Hub F3: when the round has a block-locked snapshot, the leader
    // is derived from the snapshot's member pubkeys (sorted, round % N), NOT
    // the live registered validatorSet. The live set drifts with registration
    // churn mid-round, so live-set indexing lets two hubs elect different
    // leaders for the same round and reject each other's legitimate PROPOSE
    // (liveness stall until fallback/timeout). The snapshot is already the
    // federation-deterministic set every hub locks at the round's block
    // boundary, so deriving the leader from it keeps the election identical
    // everywhere. Without a usable snapshot (memberPubkeys null), legacy
    // live-set rotation is preserved (graceful-degradation path).
    _getLeader(round, memberPubkeys) {
        if (memberPubkeys && memberPubkeys.size > 0) {
            let keys = [...memberPubkeys].sort();
            let pubkey = keys[round % keys.length];
            return { addr: this.addrForPubkey(pubkey), pubkey: pubkey };
        }
        if (this.validatorSet.length === 0) return null;
        return this.validatorSet[round % this.validatorSet.length];
    },

    // Resolve a (lowercase) signing pubkey to its P2P addr: the loaded
    // validator set first, then the peer registry (lowest addr wins so a key
    // bound to several addrs resolves identically on every hub), then own
    // identity. Null when unknown; leader-addr comparisons then fail and the
    // fallback-proposer election salvages the round.
    addrForPubkey(pubkey) {
        for (let v of this.validatorSet) {
            if (v && v.pubkey && String(v.pubkey).toLowerCase() === pubkey) return v.addr;
        }
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (registry && typeof registry.get === 'function') {
            let matches = [];
            for (let [addr, pk] of registry) {
                if (pk && String(pk).toLowerCase() === pubkey) matches.push(addr);
            }
            if (matches.length > 0) return matches.sort()[0];
        }
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (identity && String(identity.getPubkeyHex()).toLowerCase() === pubkey) {
            return this.peerManager.validatorAddr;
        }
        return null;
    },

    // True when `addr` (with verified pubkey `pubkey`, may be null) is the
    // round leader. Matches on addr OR verified pubkey so a snapshot-derived
    // leader is still recognized when this hub's addr binding for that key
    // differs from the one addrForPubkey picked.
    isLeaderIdentity(leader, addr, pubkey) {
        if (!leader) return false;
        if (leader.addr && leader.addr === addr) return true;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        return !!(lpk && pubkey && lpk === pubkey);
    },

    // Addr under which the leader's submission is recorded in a
    // snapshot-filtered submission map (keys are addrs, values carry the
    // verified pubkey), or null when the leader has not submitted.
    leaderSubmissionAddr(submissions, leader) {
        if (!leader || !submissions) return null;
        if (leader.addr && submissions.has(leader.addr)) return leader.addr;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        if (!lpk) return null;
        for (let [addr, sub] of submissions) {
            let pk = (sub && sub.pubkey) ? sub.pubkey : this.resolveSenderPubkey(addr);
            if (pk === lpk) return addr;
        }
        return null;
    },

    getQuorum() {
        let N = this.validatorSet.length;
        if (N <= 0) {
            // Fall back to peer count
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        // N<=1: single node, no peer to reach (0 = caller bypasses). Above that,
        // the majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    },

    // True when a capability snapshot was fetched but qualified ZERO validators
    // AND this hub is part of a federation. getQuorum() over an empty snapshot
    // returns 0, which collides with the genuine single-node bypass; taking that
    // bypass in a federation self-finalizes the round with ONE signature, storing
    // a divergent 'finalized' row and publishing a PRICE v0 the indexer's
    // >2/3-stake gate then rejects. Such a round must be SKIPPED instead. The
    // federation test is `getQuorum() > 0` (validatorSet has >=2 registered
    // members, or a live peer is connected); a genuine single-node / regtest
    // bootstrap has `getQuorum() === 0`, so it keeps the self-finalize path. A
    // null snapshot (indexer unreachable) is a DIFFERENT case, handled one guard
    // earlier on both round paths by hasDeterministicSnapshot.
    isEmptyFederationSnapshot(snapshot) {
        if (!snapshot) return false;
        let vals = snapshot.validators;
        let empty = !Array.isArray(vals) || vals.length === 0;
        return empty && this.getQuorum() > 0;
    },

    // Fail-closed gate for a federated hub: a block-anchored snapshot is what makes the
    // round's N the SAME number on every hub. Null (indexer down / timeout / 401-403 /
    // malformed) is not a smaller federation, it is an unknown one, and sizing quorum
    // from local live state at that point makes the finalization threshold a function of
    // this hub's reachability. Present-but-EMPTY is a different case (a real, agreed-upon
    // zero-qualifier set) and is handled by isEmptyFederationSnapshot.
    // Mirrors Consensus.hasDeterministicSnapshot.
    hasDeterministicSnapshot(snapshot) {
        return !!(snapshot && Array.isArray(snapshot.validators));
    }
};
