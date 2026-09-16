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
 * ANCHOR publisher - signer and publisher-set resolution
 *
 * The oracle_publish set an election ranks, and the DOGE signing pipeline a
 * publish runs through.
 *
 ********************************************************************/

'use strict';

const swq = require('../../stake_weighted_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    async getActiveOraclePublishPubkeys(blockIndex){
        if(!this.hub) return [];
        if(blockIndex !== undefined && blockIndex !== null){
            // Block-PINNED election query. Fail CLOSED on a miss: the block-unpinned,
            // self-test/enabled-filtered, gossip-driven capabilityRegistry set is
            // per-hub, so substituting it here forks the election set across hubs
            // (two hubs elect over different member lists -> double-anchor of real
            // DOGE, stalled checkpoint, or an archive co-signature the indexer drops).
            // An empty (unresolved) set means abstain, which the pinned election gates
            // already fail-close on.
            //
            // Weighted snapshots carry one row per (source, pubkey), so dedupe before
            // returning: this set is used for membership and hash-order election, both of
            // which must see each key exactly once.
            let snapErr = null;
            if(this.hub.capabilitySnapshot){
                try {
                    let snap = await this.oraclePublishSnapshot(blockIndex);
                    if(snap && Array.isArray(snap.validators))
                        return [...new Set(snap.validators.map(v => String(v.pubkey).toLowerCase()))].sort();
                } catch(e){ snapErr = e; }
            }
            // Local-table fallback, the twin of the one in resolveCapabilitySet
            // and gated the same way: the per-hub capability_snapshots table is a
            // valid source only on seeded/regtest stacks, where the deterministic
            // snapshot path may simply not be wired. Off regtest a miss means THIS
            // hub's indexer is down, and electing over local rows while healthy
            // peers elect over the on-chain snapshot forks the election set, so
            // the abstain below stands. Without this fallback a regtest hub with
            // no live snapshot resolution abstained from every pinned election
            // and anchored nothing, silently.
            if(this.network === 'regtest' && this.db){
                try {
                    let rows = await this.db.findCapabilitySnapshotsBySnapshotBlockAndCapability(Number(blockIndex), 'oracle_publish');
                    // Weighted snapshots persist one row per (source, pubkey);
                    // membership and hash-order election need each key once.
                    if(rows && rows.length > 0)
                        return [...new Set(rows.map(r => String(r.signing_pubkey).toLowerCase()))].sort();
                } catch(e){ if(!snapErr) snapErr = e; }
            }
            this.warnMembershipUnresolved(blockIndex, snapErr);
            return [];
        }
        // Unpinned CURRENT-membership query (blockIndex null): the coarse BUNDLE_DONE /
        // FINALIZED sender pre-filter, which wants "is this sender a current
        // oracle_publish member" and NOT a block-pinned set. Every such caller
        // re-checks the sender against the block-PINNED election / observed-leader
        // set before acting, so the live registry is the correct source here and
        // this path must NOT fail closed (that would reject every legitimate peer
        // back-fill and force systematic re-anchoring).
        if(!this.hub.capabilityRegistry) return [];
        try {
            let pubkeys = await this.hub.capabilityRegistry.getActiveValidators('oracle_publish');
            return pubkeys.map(p => String(p).toLowerCase()).sort();
        } catch(e){ return []; }
    },

    // Flag-day aware, exactly like resolveCapabilitySet: at/above
    // STAKE_WEIGHTED_QUORUM the membership authority is the WEIGHT snapshot
    // (getstakeweightsbycapability), below it the count snapshot
    // (getcapabilityvalidators). Those are distinct indexer queries with
    // distinct membership semantics, and the on-chain verifier picks the same
    // way (`weighted ? getStakeWeightsByCapability : getValidatorsByCapability`,
    // xchain-indexer anchor.js). Reading the count snapshot unconditionally made
    // this gate answer a different question from the leader quorum that judges
    // the same round: above the flag-day a validator present in the weighted set
    // (so counted by the indexer, and listed in round.validators) but absent from
    // the count set returned early and never co-signed, silently starving the
    // archive / publisher-attestation quorum into a timeout and a degraded,
    // reward-withholding legacy anchor. Gated on the DEPLOYMENT network, never a
    // wire-supplied one: on a correctly-scoped hub that IS the record's network,
    // and an unscoped hub resolves the gate to off, i.e. today's behaviour.
    // Hands back the snapshot read's own promise, so the pinned query awaits exactly
    // what it awaited when this read sat inline.
    oraclePublishSnapshot(blockIndex){
        let weighted = swq.isStakeWeightedQuorumActive(Number(blockIndex), this.network);
        return weighted
            ? this.hub.capabilitySnapshot.getWeightSnapshot('oracle_publish', blockIndex)
            : this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
    },

    // Abstaining is still the correct fail-closed outcome (the pinned
    // election gates treat an empty set as "do not act"), but it must be
    // loud: an unresolved membership here surfaces as zero broadcasts with
    // no error anywhere, which reads as a healthy idle publisher.
    warnMembershipUnresolved(blockIndex, snapErr){
        logger.warn('StateAnchorPublisher: oracle_publish membership unresolved at block ' +
            Number(blockIndex) + ' (capability snapshot unavailable' +
            (this.network === 'regtest' ? ' and the local capability_snapshots table has no rows'
                                        : '; the local-table fallback is regtest-only') +
            (snapErr ? '; last error: ' + snapErr.message : '') +
            '); abstaining from this pinned election');
    },

    resolveSigner(){
        let op = this.hub.oraclePublisher || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    }

};
