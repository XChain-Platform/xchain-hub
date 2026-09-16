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
 * XChain Hub - Attestation Responsible Set
 *
 * Who may serve a request, and who may sign for it. The selection is
 * consensus-critical and exists in copies outside this repo, so the rule is
 * kept whole here: the provider stake floor that filters the snapshot, the
 * liveness ladder's extra slots, and the hash-ordered slice itself.
 *
 ********************************************************************/

'use strict';
const crypto = require('crypto');
const bc     = require('../../bcmath.js');
const wid    = require('../../consensus/gates/attest_responsible_widening_gate.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The responsible set for one request, or null when this hub must not open a
    // round for it: an unresolvable provider floor and a set too small to ever
    // finalize both refuse here, before any provider is paid.
    responsibleSetFor(rid, request, snapshot, snapshotBlk, latestBlock, redundancy, providerId, weighted){
        // PROVIDER STAKE FLOOR. A HIGHER, per-provider bar on top of the
        // capability MIN_STAKE the snapshot was already built at: serving an `llm`
        // attestation costs more stake than serving an `http_get` one. Resolved from
        // the BLOCK-ANCHORED provider history at the request's own block, for the same
        // reason the model identity below is: a governance change that finalized at a
        // different wall-clock moment on another hub must not make the two hubs filter
        // the same request's validator set differently.
        //
        // Fail closed on an unresolvable floor, mirroring CapabilitySnapshot's #S-F3
        // posture for the capability threshold: a floorless provider must not silently
        // widen the serving set to everyone who clears the (lower) capability bar.
        // typeof-guarded so a registry that cannot answer resolves to null and the
        // weighted path skips the round, rather than throwing mid-poll and losing every
        // other pending request in the same sweep. Fails closed either way.
        let providerFloor = (this.providerRegistry && typeof this.providerRegistry.getMinStake === 'function')
            ? this.providerRegistry.getMinStake(providerId, snapshotBlk) : null;
        if(weighted && providerFloor === null){
            logger.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has no min_stake_xchain floor at block ' + snapshotBlk + ' (failing closed)');
            return null;
        }
        // RESPONSIBLE-SET WIDENING (spec §8.2 liveness ladder). A staked validator that
        // serves nothing keeps its slot forever, because the snapshot is drawn from stake
        // alone, so a set holding one dead member can never produce the `redundancy`
        // signatures finalization needs and the request burns its whole window. The set
        // therefore grows by one slot per segment of the request's own serviceable span.
        // Pure function of chain height and the request's own fields, on FROZEN constants
        // rather than this hub's tunables, so every hub and every indexer derive the same
        // widening; flag-day gated per network, and 0 below it, where this is byte-for-byte
        // the legacy fixed-REDUNDANCY selection. `needed` is untouched: widening grows the
        // pool permitted to sign, never the count required to finalize.
        let widen = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? wid.widenSlots(Number(latestBlock), snapshotBlk, Number(request.deadline_block), this.hub.network)
            : 0;
        let responsible = this.computeResponsibleSet(snapshot.validators, rid, redundancy, weighted, providerFloor, widen);
        // Unservable-redundancy guard (Pkg 7 / 87441a53): when the snapshot (or
        // its weighted source-dedupe) yields fewer responsible slots than
        // REDUNDANCY, the round can never finalize; the indexer requires
        // >= redundancy valid signatures and only responsible-set members can
        // sign. AttestationConsensus.propose already refuses the round
        // (unfinalizable-round guard); skipping HERE additionally saves the paid
        // provider fetch that propose() would discard. Same loud warn; the
        // request reaches its normal deadline expiry + refund (or, at/above the
        // indexer's ATTEST_ADMISSION flag-day, is rejected at admission and
        // never polled at all).
        if(responsible.length < Math.max(1, redundancy)){
            logger.warn('AttestationRound: skipping unfinalizable ' + rid.substring(0,16) +
                '... (responsible=' + responsible.length + ' < redundancy=' + Math.max(1, redundancy) +
                ' at block ' + snapshotBlk +
                (weighted ? ', weighted source-dedupe, provider floor ' + providerFloor : '') + ')');
            return null;
        }
        return { responsible: responsible, widen: widen, providerFloor: providerFloor };
    },

    // Deterministic responsibility computation. Sort validators by
    // SHA256(request_id || pubkey) ascending, take top REDUNDANCY.
    // Returns [{ pubkey, hash }] sorted by hash. responsible[0] is leader.
    // STAKE_WEIGHTED_QUORUM (weighted=true): first dedupe by staking source so a
    // source's delegated keys can't occupy multiple responsible slots; keep each
    // source's lowest-hash key (iterate in hash order).
    //
    // CONSENSUS-CRITICAL: this rule exists in THREE copies that must apply it
    // identically or validation forks:
    //   1. here (AttestationRound.computeResponsibleSet)
    //   2. the indexer, xchain-indexer/src/actions/attest/index.js
    //   3. AttestationPublisher.computeResponsible (failover-rank derivation)
    // All three are behaviorally identical (hash-order sort, source===null keep
    // branch, redundancy slice with the SAME Math.max(1, Number(redundancy) || 1)
    // normalization). A FOURTH copy exists for the reorg recompute of missed_count:
    // xchain-indexer/src/rollback.js responsibleSet, which mirrors attest/index.js.
    // Any silent change to one copy is a fork surface; always update all four together.
    //
    // All four now run the SAME canonical vectors
    // (xchain-documentation/protocol/test-vectors/responsible_set.json): copies 1 and 3
    // in attestation_round.test.js, copies 2 and 4 in the indexer's
    // test/unit/actions/attest_responsible_set_vectors.test.js. Add a vector there when
    // you change the rule, or the copies can drift in a direction every suite calls green.
    //
    // PROVIDER STAKE FLOOR (weighted only): `minStake` is the request
    // provider's block-anchored min_stake_xchain. Sources whose aggregate weight is
    // below it are dropped BEFORE the ranking, so the freed slot goes to the next
    // qualifying validator rather than shrinking the set. Only the weighted snapshot
    // carries the source-aggregate `weight` the floor is defined against, which is why
    // the floor rides the STAKE_WEIGHTED_QUORUM anchor instead of minting its own
    // flag-day height. Below the gate the capability threshold stays the only bar.
    // `widen` is the liveness ladder's extra slot count for the current chain height
    // (attest_responsible_widening_gate.js), 0 below its flag-day and on an unratified
    // network, where this routine is byte-for-byte its pre-widening self.
    computeResponsibleSet(validators, requestId, redundancy, weighted, minStake, widen){
        if(weighted)
            validators = validators.filter(v => this.meetsProviderFloor(v && v.weight, minStake));
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(requestId, 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        if(weighted){
            let seen = new Set();
            withHash = withHash.filter(v => {
                if(v.source === null) return true;          // no source info -> keep (defensive)
                if(seen.has(v.source)) return false;        // source already represented
                seen.add(v.source);
                return true;
            });
        }
        let extra = Number(widen);
        if(!Number.isFinite(extra) || extra < 0) extra = 0;
        return withHash.slice(0, Math.max(1, redundancy) + extra);
    },

    // CONSENSUS-CRITICAL predicate: does a weighted-snapshot row clear the provider
    // floor? `weight` is the row's SOURCE-AGGREGATE stake (every effective key of a
    // source carries the same weight), so the bar is on the staking address, not on
    // each delegated key: a source cannot clear a 25000 floor by splitting 25000
    // across five keys, and does not have to stake 25000 per key.
    //
    // An unusable weight or an unusable floor EXCLUDES the row. Excluding is the safe
    // direction (it can only shrink the responsible set, which the caller's
    // unfinalizable-round guard already handles) and it is what keeps the rule
    // writable identically in every copy. Byte-mirrors
    // xchain-indexer/src/attestation/providerMinStakeHistory.js meetsProviderFloor,
    // down to the strict decimal-string acceptance and the decimal.js `.gte()`
    // comparison (bcmath.js bcgte), which is exact where mathjs's largerEq applies a
    // ~1e-12 epsilon; a consensus predicate that rounds is a fork surface.
    meetsProviderFloor(weight, minStake){
        const usable = (v) => {
            if(v === null || v === undefined || typeof v === 'boolean') return null;
            let s = String(v).trim();
            return /^\d+(\.\d+)?$/.test(s) ? s : null;
        };
        let floor = usable(minStake);
        if(floor === null) return false;
        let w = usable(weight);
        if(w === null) return false;
        return bc.bcgte(w, floor);
    }

};
