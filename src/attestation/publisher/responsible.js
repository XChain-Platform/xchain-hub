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
 * XChain Hub - Attestation Publisher: failover rank
 *
 * This node's step-in rank and the third copy of the responsible-set rule it is
 * computed over. Installed on AttestationPublisher.prototype by
 * src/attestation/publisher.js.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const swq    = require('../../stake_weighted_quorum.js');
const bcmath = require('../../bcmath.js');

module.exports = {

    // This node's rank in the request's responsible set: 0 = leader, ≥1 = follower
    // (step-in order). Returns null if this node holds no identity / isn't listed.
    _myRank(entry){
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if (!myPubkey) return null;
        if (Array.isArray(entry.responsible) && entry.responsible.length){
            let ordered = entry.responsible.map(p => String(p).toLowerCase());
            let idx = ordered.indexOf(myPubkey);
            if (idx < 0) return null;
            // The consensus leader ROTATES down the hash order when earlier
            // slots go silent (attestation_escalation.js), so the round's
            // actual broadcaster may not be hash-slot 0. Rank relative to the
            // recorded round leader, or the hash-slot-0 hub would fast-retry
            // (leaderRetryMs) a response the real leader already broadcast
            // that merely hasn't confirmed into a block yet.
            let leaderIdx = entry.leaderPubkey ? ordered.indexOf(String(entry.leaderPubkey).toLowerCase()) : 0;
            if (leaderIdx < 0) leaderIdx = 0;
            return (idx - leaderIdx + ordered.length) % ordered.length;
        }
        // Fallback when the responsible ordering couldn't be computed: treat the
        // recorded leader as rank 0 and ourselves as the sole follower (rank 1).
        if (entry.leaderPubkey){
            return String(entry.leaderPubkey).toLowerCase() === myPubkey ? 0 : 1;
        }
        return 0;
    },

    // Recompute the deterministic responsible-set ordering for a request, exactly
    // as AttestationRound does: sort the qualifying `attestation` validators at
    // the request's block boundary by SHA256(request_id || pubkey) ascending,
    // take the top `redundancy`. responsible[0] is the leader. Returns an array
    // of lowercase pubkeys, or null when the snapshot is unavailable.
    //
    // STAKE_WEIGHTED_QUORUM: when active at blockIndex, resolve the SOURCE-keyed
    // weight snapshot and dedupe by staking source so a source's delegated keys
    // cannot occupy multiple responsible slots (mirrors AttestationRound._computeResponsibleSet).
    // CONSENSUS-CRITICAL: this is the THIRD copy of the responsible-set rule;
    // it must stay byte-for-byte in sync with
    // AttestationRound._computeResponsibleSet and the indexer's attest/index.js,
    // including the caller's Math.max(1, Number(redundancy) || 1) normalization.
    // A silent change to any one copy is a fork surface; update all three together.
    //
    // PROVIDER STAKE FLOOR (weighted only): sources below the request
    // provider's block-anchored min_stake_xchain are dropped before the ranking, the
    // same filter AttestationRound._computeResponsibleSet applies. This ordering only
    // drives failover step-in timing, but ranking against a set the other copies do
    // not agree with means followers step in early or the true rank-1 steps in late,
    // so it tracks them exactly. An unresolvable floor returns null (rank unknown),
    // which the caller already handles as "snapshot unavailable".
    // `widen` mirrors AttestationRound's liveness ladder (attest_responsible_widening_activation.js):
    // the failover rank must be computed over the SAME set the round authorized, or a
    // widened member never learns it is allowed to step in and publish. 0 below the
    // flag-day, where this is byte-for-byte its pre-widening self.
    async _computeResponsible(rid, blockIndex, redundancy, providerId, widen){
        try {
            if (!this.hub.capabilitySnapshot) return null;
            let weighted = swq.isStakeWeightedQuorumActive(blockIndex, this.hub.network);
            let snapshot = weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('attestation', blockIndex)
                : await this.hub.capabilitySnapshot.getSnapshot('attestation', blockIndex);
            if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
            let validators = snapshot.validators;
            if (weighted) {
                let registry = this.hub.providerRegistry || null;
                let floor = (registry && providerId != null)
                    ? registry.getMinStake(String(providerId), blockIndex) : null;
                if (floor === null) return null;
                validators = validators.filter(v => this._meetsProviderFloor(v && v.weight, floor));
                if (validators.length === 0) return null;
            }
            let withHash = validators.map(v => {
                let pk = String(v.pubkey).toLowerCase();
                let h  = crypto.createHash('sha256').update(rid, 'utf8').update(pk, 'utf8').digest('hex');
                return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
            });
            withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
            if (weighted) {
                let seen = new Set();
                withHash = withHash.filter(v => {
                    if (v.source === null) return true;   // no source info: keep (defensive)
                    if (seen.has(v.source)) return false; // source already represented
                    seen.add(v.source);
                    return true;
                });
            }
            let extra = Number(widen);
            if (!Number.isFinite(extra) || extra < 0) extra = 0;
            return withHash.slice(0, Math.max(1, redundancy) + extra).map(x => x.pubkey);
        } catch (e) {
            return null;
        }
    },

    // Byte-mirror of AttestationRound._meetsProviderFloor (and of the indexer's
    // providerMinStakeHistory.meetsProviderFloor). Strict decimal-string acceptance
    // plus decimal.js `.gte()`; an unusable weight or floor excludes the row. Kept as
    // its own method rather than imported so all copies of the responsible-set rule
    // read alike side by side in their own file.
    _meetsProviderFloor(weight, minStake){
        const usable = (v) => {
            if (v === null || v === undefined || typeof v === 'boolean') return null;
            let s = String(v).trim();
            return /^\d+(\.\d+)?$/.test(s) ? s : null;
        };
        let floor = usable(minStake);
        if (floor === null) return false;
        let w = usable(weight);
        if (w === null) return false;
        return bcmath.bcgte(w, floor);
    }

};
