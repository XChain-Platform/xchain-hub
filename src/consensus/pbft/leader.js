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
 * XChain Hub - PBFT Consensus Engine: leader election and vote identity
 *
 * Who leads a (seq, view), which population elects them, how a vote's signing
 * key is resolved, and the quorum predicate every phase tallies with.
 *
 * src/consensus/pbft.js installs every method below on Consensus.prototype,
 * non-enumerable like the class's own methods, so callers, stubs and the e2e
 * harness keep reaching them as consensus.<method>().
 *
 ********************************************************************/

'use strict';

const swq    = require('../stake_weighted_quorum.js');
const eq     = require('../equivocation_header.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Normalize a locked snapshot's validators into the source-keyed shape the
    // weighted predicate needs ([{pubkey:lower, source, weight}]); [] in count mode.
    normalizeValidators(snapshot, weighted) {
        if (!weighted || !snapshot || !Array.isArray(snapshot.validators)) return [];
        let out = snapshot.validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            source: String(v.source != null ? v.source : ''),
            weight: String(v.weight != null ? v.weight : '0')
        }));
        // SWQ-TRUNC parity: carry the truncation marker onto the rebuilt array. It is a
        // plain array property that CapabilitySnapshot sets on the SNAPSHOT, so the .map
        // above drops it, and meetsStakeThreshold reads it off the array it is handed;
        // without this the round's weighted tally silently loses its fail-closed guard and
        // an under-counted S lets a minority of stake clear the 2/3 bar. Same one-liner as
        // CrossChainDexEngine.js, OracleConsensus.js and StakeShareWatcher.js.
        if (snapshot.truncated === true) out.truncated = true;
        return out;
    },

    // Leader-election population. The lowercased signing pubkeys of the
    // block-locked snapshot: the same rows that sized this round's quorum, so
    // election and quorum finally read one population instead of two. Returns
    // null when no usable snapshot exists (indexer down, single-node bootstrap),
    // which every caller reads as "fall back to legacy live-set rotation".
    // Mirrors OracleConsensus.memberPubkeySet.
    memberPubkeySet(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set.size > 0 ? set : null;
    },

    // Resolve a (lowercase) signing pubkey to its P2P addr. Snapshot rows carry
    // no addr (they are indexer staker rows), so the binding has to come from
    // local state: the loaded validator set first, then the peer registry
    // (lowest addr wins so a key bound to several addrs resolves identically on
    // every hub), then this hub's own identity. Null when unknown; the leader
    // is then only recognizable by pubkey, and a round whose leader no hub can
    // address times out into a view change that rotates to the next member.
    // Mirrors OracleConsensus.addrForPubkey.
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

    // This hub's own lowercased signing pubkey, or null before the identity is
    // available. Needed because a snapshot-derived leader may be recognizable
    // only by key: one such case is two hubs holding different addr bindings
    // for the same staker, which an addr-only self-check turns back into the
    // very divergence the pinning removes.
    selfPubkey() {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (!identity) return null;
        let pk = identity.getPubkeyHex();
        return pk ? String(pk).toLowerCase() : null;
    },

    // True when `addr` (with verified pubkey `pubkey`, may be null) is the round
    // leader. Matches on addr OR verified pubkey so a snapshot-derived leader is
    // still recognized when this hub's addr binding for that key differs from
    // the one addrForPubkey picked. Mirrors OracleConsensus.isLeaderIdentity.
    isLeaderIdentity(leader, addr, pubkey) {
        if (!leader) return false;
        if (leader.addr && leader.addr === addr) return true;
        let lpk = leader.pubkey ? String(leader.pubkey).toLowerCase() : null;
        return !!(lpk && pubkey && lpk === pubkey);
    },

    // Shared PRE_PREPARE leader-identity guard. A PRE_PREPARE must
    // come from the validator the rotation designates as leader for the CLAIMED
    // (seq, view), mirroring the check handleNewView applies to NEW_VIEW and
    // OracleConsensus applies to PROPOSE: a Byzantine node can then only ever
    // propose in a (seq, view) for which it is already the legitimate leader.
    // The rotation is evaluated over `memberPubkeys` when the round has a pinned
    // population, else over the live set (unchanged legacy behavior).
    leaderIdentityOk(seq, view, envelope, memberPubkeys) {
        let leader = this.leaderAt(seq, view, memberPubkeys);
        if (!leader) {
            logger.warn('PBFT: Rejecting PRE_PREPARE for seq ' + seq + ' view ' + view +
                ' from ' + envelope.sender + ': no leader can be elected (empty validator set)');
            return false;
        }
        if (!this.isLeaderIdentity(leader, envelope.sender, this.resolveSenderPubkey(envelope))) {
            logger.warn('PBFT: Rejecting PRE_PREPARE for seq ' + seq + ' view ' + view +
                ' from non-leader ' + envelope.sender);
            return false;
        }
        return true;
    },

    // The pinned leader-election population for `seq` when this hub still holds
    // the round's context: the pending proposal first, then the view-change
    // context the initiator stashed after the proposal was cleared. Null when
    // neither survives, which is the graceful-degradation path back to live-set
    // rotation.
    memberPubkeysForSeq(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (proposal && proposal.memberPubkeys) return proposal.memberPubkeys;
        let vcCtx = this.viewChangeQuorums.get(seq);
        if (vcCtx && vcCtx.memberPubkeys) return vcCtx.memberPubkeys;
        return null;
    },

    // Add this hub's own signing pubkey to a weighted vote set (no-op if the
    // identity isn't available yet, e.g. before the hub finishes initializing).
    addSelfPubkey(pubkeySet) {
        if (!pubkeySet) return;
        let identity = this.hub.getIdentity && this.hub.getIdentity();
        if (identity) pubkeySet.add(identity.getPubkeyHex().toLowerCase());
    },

    // EQUIV durable canonical (the 6th engine, XCONFIG). Config-change
    // PBFT signs only the ephemeral transport envelope today; this adds a durable
    // per-validator signature over
    //   buildEquivCanonical('XCONFIG', seq, view, `${blockHeight}|${digest}`)
    // i.e. content = `<snapshot_block>|<config-digest>`. The snapshot_block (the round's
    // locked BTC tip, the whole-federation set that authorized this config slot) is carried
    // IN the signed content so a BTC indexer can recover the membership set from the proof
    // ALONE and slash a config equivocator (SLASH.md). It is constant for a (seq,view): every
    // PRE_PREPARE/PREPARE/COMMIT vote locks the same snapshot, and the digest-conflict guard
    // keeps an honest node from signing two configs for one slot, so the two header-identical,
    // SAME-snapshot_block, DIFFERENT-digest messages are the slashable artifact. blockHeight is
    // never null here (isEquivHeaderActive(null) is false => {} below). base-10 block + hex
    // digest are pipe-free, so the wire action splits cleanly. Carried as {equiv_sig,
    // equiv_pubkey} per vote, additive to the count + weighted tally, gated on tip + network.
    // Returns {} below the flag-day or when no identity is available (vote still counts).
    equivVote(seq, view, digest, blockHeight) {
        if (!eq.isEquivHeaderActive(blockHeight, this.hub && this.hub.network)) return {};
        let identity = this.hub.getIdentity && this.hub.getIdentity();
        if (!identity) return {};
        let canonical = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, seq, view, String(blockHeight) + '|' + digest);
        return { equiv_sig: identity.sign(canonical), equiv_pubkey: identity.getPubkeyHex().toLowerCase() };
    },

    // Resolve a voting peer's signing pubkey from an authenticated envelope.
    // Prefer envelope.sig_pubkey (PeerManager already verified the envelope with
    // it), fall back to the addr->pubkey registry, else null. In the null case the
    // vote still counts in the address set and is only omitted from the weighted
    // stake tally (a known validator on a transient version mismatch; weighted
    // mode only activates post-flag-day when every hub stamps sig_pubkey).
    resolveSenderPubkey(envelope) {
        if (envelope && envelope.sig_pubkey && typeof envelope.sig_pubkey === 'string')
            return envelope.sig_pubkey.toLowerCase();
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (registry && envelope) {
            let pk = registry.get(envelope.sender);
            if (pk) return String(pk).toLowerCase();
        }
        return null;
    },

    // Quorum predicate shared by PREPARE / COMMIT / VIEW_CHANGE. Under
    // STAKE_WEIGHTED_QUORUM: 3*sum(distinct-source signer weight) > 2*S over the
    // pubkeys that voted; below activation: the legacy 2f+1 count of the address
    // vote set against the round-locked quorum. `ctx` is a proposal (PREPARE/COMMIT)
    // or a {quorum, weighted, validators} view-change context.
    quorumMet(ctx, addrSet, pubkeySet) {
        if (ctx.weighted)
            return swq.meetsStakeThreshold(ctx.validators, pubkeySet || new Set());
        let quorum = (typeof ctx.quorum === 'number') ? ctx.quorum : this.getQuorum();
        // Count DISTINCT SIGNING KEYS, not sender addrs. Both are populated, but the
        // key set is the honest one: it dedupes a key that voted under several addrs
        // and it counts a chain-attributed validator that has no registry addr. The
        // addr set is retained for diagnostics and for the pre-bootstrap window where
        // no envelope carries a key (pubkeySet empty), which is the only case that
        // falls back to it.
        let keyed = pubkeySet ? pubkeySet.size : 0;
        return (keyed > 0 ? keyed : addrSet.size) >= quorum;
    },

    // Rotation leader for (seq, view). When the round carries a pinned
    // population (`memberPubkeys`, the block-locked snapshot the quorum was
    // sized from), elect sorted-member-pubkeys[(seq + view) % N] and resolve the
    // addr locally, so every hub in the federation elects the same key for the
    // same round no matter how its local peer set has drifted. Without one, the
    // legacy live-set rotation is preserved unchanged, which is the single-node
    // and indexer-unavailable path. Note that when the two populations agree the
    // two rotations are identical: setValidatorSet canonicalizes the live set by
    // lowercased pubkey ascending (validator_order.js), the same order the
    // sorted member keys give.
    leaderAt(seq, view, memberPubkeys) {
        if (memberPubkeys && memberPubkeys.size > 0) {
            let keys = [...memberPubkeys].sort();
            let pubkey = keys[(seq + view) % keys.length];
            return { addr: this.addrForPubkey(pubkey), pubkey: pubkey };
        }
        if (this.validatorSet.length === 0) return null;
        return this.validatorSet[(seq + view) % this.validatorSet.length];
    },

    getLeader(seq, memberPubkeys) {
        return this.leaderAt(seq, this.view, memberPubkeys);
    },

    isLeader(seq, memberPubkeys) {
        let leader = this.getLeader(seq, memberPubkeys);
        return this.isLeaderIdentity(leader, this.peerManager.validatorAddr, this.selfPubkey());
    }
};
