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
 * XChain Hub - Attestation Leader Election
 *
 * Which responsible member leads a round right now: the deterministic
 * escalation ladder, and the silent-slot skip layered over it. Every hub
 * derives the same answer from the same chain height and its own observation
 * of who has spoken for the request.
 *
 ********************************************************************/

'use strict';
const esc    = require('../escalation.js');
// The leader-rotation silent-slot skip flag day. Keyed on the REQUEST's own block
// like the widening and zero-conf flag days, so every hub flips the leader arithmetic on the same request
// rather than on whichever tip it happened to poll.
const lss    = require('../../attest_leader_silence_skip_activation.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The EFFECTIVE leader for this poll: the escalation ladder's slot, with
    // slots whose member this hub has proven silent stepped over.
    //
    // WHY A SKIP RATHER THAN A STOP (ledger P60, measured on testnet4). The bare
    // ladder caps at MAX_LEADER_ROTATIONS and never wraps, so for a request at
    // block R the slot froze at 3 from R+9 onward. A frozen slot holding a member
    // that never sends a PROPOSE is terminal: with no leader proposal,
    // AttestationConsensus.resolveRoundEffectiveTime falls back to each hub's own
    // wall clock, the hubs stamp tens of seconds apart, no two PREPAREs share a
    // canonical, and the round times out on every retry for the rest of the
    // request's life (request 233: 28 consecutive rounds at leaderSlot=3 with
    // every llm-capable hub seated and proposing status=ok).
    //
    // Silence is OBSERVED here and never derived, which is what keeps the
    // arithmetic in attestation_escalation.js pure: a member is proven silent only
    // once it has held the slot for a full rotation window of chain time with no
    // PROPOSE from it for this request. A silent key sends nothing to ANY hub, so
    // every hub reaches the same set from its own local observation; a hub that
    // gets there a window later runs the pre-skip ladder for one more poll, which
    // is the same transient skew the escalation module's header already tolerates.
    //
    // GATED on attest_leader_silence_skip_activation.js, keyed on `requestBlock`
    // (the request's own block_index, the same anchor the widening and zero-conf
    // gates use). Below the height this returns the bare spec §8.2 ladder and
    // touches nothing else: no silent set is consulted, no watch is armed and no
    // skip warning is emitted, so a mixed-version fleet cannot disagree about the
    // leader of a request admitted below the flag day. `esc.leaderIndex` is the
    // empty-observation case of `esc.effectiveLeaderSlot`, which is what makes the
    // gated-off path the pre-skip result rather than a reimplementation of it.
    //
    // `latestBlock` is the poll's indexer tip and `step` the ladder step already
    // derived from it. Returns { index, pubkey } for the slot the round should run.
    resolveLeader(rid, responsible, step, latestBlock, requestBlock){
        if(!lss.isLeaderSilenceSkipActive(requestBlock, this.hub ? this.hub.network : undefined)){
            let plain = esc.leaderIndex(step, responsible.length);
            return { index: plain, pubkey: this.slotPubkey(responsible, plain) };
        }

        let rec    = this.leaderSilenceRecord(rid);
        let idx    = esc.effectiveLeaderSlot(step, responsible.length, this.silentLeaderSlots(rec, responsible));
        let pubkey = this.slotPubkey(responsible, idx);

        if(pubkey && rec.watchPubkey === pubkey && !this.hasProposedForRequest(rid, pubkey)
           && esc.isProvenSilent(latestBlock, rec.watchBlock, this.leaderRotationBlocks)){
            ({ index: idx, pubkey: pubkey } = this.skipSilentLeader(rid, rec, responsible, step, latestBlock, idx, pubkey));
        }

        // Arm (or re-arm) the window on whoever holds the slot now. The watch
        // block is the height this hub FIRST saw this member holding it, so the
        // full-window test above measures a held slot rather than a poll gap.
        if(pubkey !== rec.watchPubkey){
            rec.watchPubkey = pubkey;
            rec.watchBlock  = Number(latestBlock);
        }
        return { index: idx, pubkey: pubkey };
    },

    // The member holding slot `i`, falling back to slot 0: a widened set can be
    // shorter than the ladder's step, and slot 0 always exists.
    slotPubkey(responsible, i){
        return responsible[i] ? responsible[i].pubkey : (responsible[0] ? responsible[0].pubkey : null);
    },

    // The per-request silence observation, created on first use. Evicted on the
    // `rounds` TTL, so a long-dead request cannot hold one forever.
    leaderSilenceRecord(rid){
        let rec = this.leaderSilence.get(rid);
        if(!rec){
            rec = { silent: new Set(), watchPubkey: null, watchBlock: null, heldLogged: false, updatedAt: 0 };
            this.leaderSilence.set(rid, rec);
        }
        rec.updatedAt = Date.now();
        return rec;
    },

    // Slot indices are recomputed from pubkeys on every call: the responsible
    // set can widen mid-request (attest_responsible_widening_activation.js), so
    // a slot NUMBER is not stable across polls while the pubkey in it is.
    silentLeaderSlots(rec, responsible){
        let s = new Set();
        for(let i = 0; i < responsible.length; i++){
            if(rec.silent.has(responsible[i].pubkey)) s.add(i);
        }
        return s;
    },

    // Has this member proposed for this request at any point, across every
    // retry round? Consensus owns that record because it owns the PROPOSE
    // wire; typeof-guarded so a hub wired to a consensus without the accessor
    // simply never skips, i.e. degrades to the pre-skip ladder.
    hasProposedForRequest(rid, pubkey){
        return !!(pubkey && this.consensus
            && typeof this.consensus.hasProposedFor === 'function'
            && this.consensus.hasProposedFor(rid, pubkey));
    },

    // Step over a slot whose member this hub has now PROVEN silent, and say so.
    // The skip does not spend a rotation: the ladder's own step is unchanged and
    // only the silent set it walks over grows.
    skipSilentLeader(rid, rec, responsible, step, latestBlock, idx, pubkey){
        rec.silent.add(pubkey);
        logger.warn('AttestationRound: leader slot ' + idx + ' skipped for ' + rid.substring(0,16) +
                     '... (' + pubkey.substring(0,16) + '... held the slot from block ' + rec.watchBlock +
                     ' to ' + latestBlock + ' with no PROPOSE for this request; the skip does not spend a rotation)');
        let skippedIdx = idx;
        idx    = esc.effectiveLeaderSlot(step, responsible.length, this.silentLeaderSlots(rec, responsible));
        pubkey = this.slotPubkey(responsible, idx);

        // Rule: when no live slot remains AHEAD, the ladder holds the last live
        // slot it reached instead of running off the end. The tell is that the
        // walk could not get past the slot just proven silent. Say so once per
        // request, so an operator reading a stalled request sees the fleet is
        // out of leaders rather than that rotation quietly stopped working.
        if(idx <= skippedIdx && !rec.heldLogged){
            rec.heldLogged = true;
            logger.warn('AttestationRound: no live leader slot remains for ' + rid.substring(0,16) +
                         '... (' + rec.silent.size + ' of ' + responsible.length +
                         ' responsible members proven silent); holding slot ' + idx);
        }
        return { index: idx, pubkey: pubkey };
    },

    // Leader rotation (Phase 4): a silent leader must not stall the request
    // until deadline expiry. The leader slot advances one step down the
    // hash-ordered responsible set per rotation window of elapsed chain
    // time. The SET stays identical (indexer signature validation keys on
    // membership, never on leadership), only the slot that runs agree() and
    // broadcasts first moves. Falls back to slot 0 when the poll couldn't
    // resolve a tip height.
    //
    // resolveLeader layers the silent-slot skip (ledger P60) over that
    // arithmetic: the ladder stopping ON a mute member, rather than stepping
    // over it, is what pinned request 233 at leaderSlot=3 forever. The skip is
    // gated on the request's own block (attest_leader_silence_skip_activation.js),
    // so a request admitted below the flag day gets the bare ladder on every hub
    // whatever build it runs.
    electLeader(rid, responsible, latestBlock, snapshotBlk){
        let step = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? esc.escalationStep(Number(latestBlock), snapshotBlk, this.confirmationsFor(snapshotBlk), this.leaderRotationBlocks)
            : 0;
        return this.resolveLeader(rid, responsible, step, latestBlock, snapshotBlk);
    }

};
