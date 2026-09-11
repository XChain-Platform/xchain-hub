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
 * XChain Hub - Attestation Escalation Schedule
 *
 * Pure, block-deterministic escalation arithmetic shared by the attestation
 * round pipeline. Two independent ladders, both keyed only on chain state
 * every hub already agrees on (the request's block, the provider's
 * confirmation lag, the indexer tip), so every hub derives the same answer
 * without any extra coordination messages:
 *
 *   1. LEADER ROTATION - a dead or unresponsive round leader must not stall
 *      a request until deadline expiry. The leader index advances one slot
 *      down the responsible set per `rotationWindowBlocks` of elapsed chain
 *      time, capped at MAX_LEADER_ROTATIONS (spec §8.2: "rotation count
 *      capped at 3"). Slots whose member the CALLER has proven silent are
 *      stepped over for free, so the cap counts live rotations only; see
 *      effectiveLeaderSlot.
 *
 *   2. MODEL FALLBACK - a provider whose primary model/vendor is down must
 *      not burn the whole deadline window re-trying the same dead endpoint.
 *      The request's [start, deadline] span is divided into equal segments,
 *      one per approved model, so the round switches to the next
 *      governance-approved model as the deadline approaches. All validators
 *      in a round always fetch with the SAME model (mixed-model rounds fail
 *      the judge's equivalence check; see providers/llm.js).
 *
 * Hubs whose indexer tips briefly differ across a window boundary can
 * disagree on the index for one poll cycle; the round then simply fails to
 * quorum and converges on the next retry. This is the same transient skew
 * the confirmation gate already tolerates.
 *
 ********************************************************************/

'use strict';

const MAX_LEADER_ROTATIONS           = 3;  // spec §8.2
const DEFAULT_ROTATION_WINDOW_BLOCKS = 2;  // matches the publisher's failover window

// Blocks elapsed since the round became serviceable (request block +
// confirmation lag). Negative elapses clamp to 0 (round not yet startable;
// callers gate on confirmations before fetching anyway).
function blocksElapsed(latestBlock, requestBlock, confirmations){
    let start = Number(requestBlock) + (Number(confirmations) || 0);
    let d     = Number(latestBlock) - start;
    return (Number.isFinite(d) && d > 0) ? d : 0;
}

// Escalation step: one increment per rotation window of elapsed chain time.
function escalationStep(latestBlock, requestBlock, confirmations, rotationWindowBlocks){
    let win = Number(rotationWindowBlocks);
    if(!Number.isFinite(win) || win < 1) win = DEFAULT_ROTATION_WINDOW_BLOCKS;
    return Math.floor(blocksElapsed(latestBlock, requestBlock, confirmations) / win);
}

// Membership test over the caller's silent-slot collection, which may be a Set,
// an Array or absent. Absent means "nothing proven silent", i.e. the plain
// pre-skip ladder.
function isSilentSlot(silentSlots, i){
    if(!silentSlots) return false;
    if(typeof silentSlots.has === 'function') return !!silentSlots.has(i);
    return !!silentSlots[i];
}

// First slot at or after `from` that is not proven silent, or -1 when the set
// runs out.
function nextLiveSlot(from, count, silentSlots){
    for(let i = from; i < count; i++){
        if(!isSilentSlot(silentSlots, i)) return i;
    }
    return -1;
}

// EFFECTIVE leader slot for a given escalation step, given the slots the caller
// has proven silent (ledger P60). Rotates down the hash-ordered responsible set
// one slot per step, stepping OVER a silent slot instead of stopping on it.
//
// Three properties this has to hold, and the reason for each:
//
//   - A skip is free. Only a rotation onto a LIVE slot counts against
//     MAX_LEADER_ROTATIONS, so a set whose first slots are dead still gets the
//     full three live attempts the cap promises.
//   - It never wraps. A slot already proven silent is never returned to: the
//     walk only ever moves forward, so the audit trail stays unambiguous and no
//     round re-elects a member the fleet has already watched say nothing.
//   - A dead end HOLDS. When no live slot remains ahead, the walk stays on the
//     last live slot it reached rather than falling off the end, so the round
//     still names a leader (a leaderless round has no canonical stamp to settle
//     on and times out forever, which is the defect this whole path exists for).
//
// RULED ACCEPTABLE: the hold in that third bullet can seat a slot LOWER than
// the plain step-only ladder (leaderIndex) would land on, when every slot
// ahead of the last live one is silent: the ladder's raw target slot is
// itself silent and everything past it is too, so the walk settles on an
// earlier live slot instead of advancing onto (or past) dead ground. That is
// a deliberate regression, not a defect: the alternative is stopping on a
// slot already proven mute, which is exactly the freeze this function exists
// to break. It never returns to a slot already proven silent (second bullet)
// and never invents a member outside `responsibleCount`, so the seated slot
// is always a real, live candidate, just not necessarily the furthest one
// the step count alone would suggest.
//
// `silentSlots` is an OBSERVATION supplied by the caller, not something derived
// here: this function stays pure and block-deterministic, and two callers
// holding the same observation always agree on the slot.
function effectiveLeaderSlot(step, responsibleCount, silentSlots){
    let count = Number(responsibleCount);
    if(!Number.isFinite(count) || count <= 1) return 0;
    let s = Number(step);
    if(!Number.isFinite(s) || s < 0) s = 0;
    let rotations = Math.min(s, MAX_LEADER_ROTATIONS);

    let idx = nextLiveSlot(0, count, silentSlots);
    // Every slot is silent: hold the LAST one rather than wrapping to slot 0,
    // which the set has already proven mute.
    if(idx < 0) return count - 1;

    for(let r = 0; r < rotations; r++){
        let next = nextLiveSlot(idx + 1, count, silentSlots);
        if(next < 0) break;   // dead end: hold `idx`, the last live slot reached
        idx = next;
    }
    return idx;
}

// Leader slot for a given escalation step with nothing proven silent: the plain
// spec §8.2 ladder. Retained as its own name because that ladder is the contract
// the round's opening line and the publisher's failover rank are written
// against; it is effectiveLeaderSlot's empty-observation case, not a second rule.
function leaderIndex(step, responsibleCount){
    return effectiveLeaderSlot(step, responsibleCount, null);
}

// Has a leader held its slot long enough to be PROVEN silent? True once a full
// rotation window of chain time has passed since `sinceBlock`, the height at
// which the caller first observed this member holding the slot.
//
// A full window is the bar because it is the same span the ladder gives a live
// leader to answer in: anything shorter would convict a leader whose PROPOSE is
// merely in flight, and a wrongly-skipped live leader costs the round a slot it
// could have finalized on.
function isProvenSilent(latestBlock, sinceBlock, rotationWindowBlocks){
    let win = Number(rotationWindowBlocks);
    if(!Number.isFinite(win) || win < 1) win = DEFAULT_ROTATION_WINDOW_BLOCKS;
    // null/'' coerce to 0 and would convict on the very first poll, so screen the
    // empty spellings before the numeric guard rather than after it.
    if(latestBlock === null || latestBlock === undefined || sinceBlock === null || sinceBlock === undefined) return false;
    let now   = Number(latestBlock);
    let since = Number(sinceBlock);
    if(!Number.isFinite(now) || !Number.isFinite(since)) return false;
    return (now - since) >= win;
}

// Model slot for the current chain height: the request's serviceable span
// [requestBlock + confirmations, deadlineBlock] divided into `modelCount`
// equal segments, one per entry of the block-anchored approved_models list.
// A height past the deadline (with a valid span) clamps to the last model
// (n - 1). A degenerate span (deadline <= serviceable start) falls back to
// the primary model (index 0) instead; see the tested contract below.
function modelIndex(latestBlock, requestBlock, confirmations, deadlineBlock, modelCount){
    let n = Number(modelCount);
    if(!Number.isFinite(n) || n <= 1) return 0;
    let start = Number(requestBlock) + (Number(confirmations) || 0);
    let span  = Number(deadlineBlock) - start;
    if(!Number.isFinite(span) || span <= 0) return 0;
    let segment = span / n;
    let idx = Math.floor(blocksElapsed(latestBlock, requestBlock, confirmations) / segment);
    return Math.max(0, Math.min(idx, n - 1));
}

module.exports = {
    MAX_LEADER_ROTATIONS,
    DEFAULT_ROTATION_WINDOW_BLOCKS,
    blocksElapsed,
    escalationStep,
    leaderIndex,
    effectiveLeaderSlot,
    isProvenSilent,
    modelIndex
};
