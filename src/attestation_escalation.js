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
 *      capped at 3").
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
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§8.2, Phase 4)
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

// Leader slot for a given escalation step. Rotates down the hash-ordered
// responsible set one slot per step, stopping at the rotation cap (or the
// end of the set for small sets). Never wraps: wrapping back to a leader
// already proven silent buys nothing and makes the audit trail ambiguous.
function leaderIndex(step, responsibleCount){
    let count = Number(responsibleCount);
    if(!Number.isFinite(count) || count <= 1) return 0;
    let s = Number(step);
    if(!Number.isFinite(s) || s < 0) s = 0;
    return Math.min(s, MAX_LEADER_ROTATIONS, count - 1);
}

// Model slot for the current chain height: the request's serviceable span
// [requestBlock + confirmations, deadlineBlock] divided into `modelCount`
// equal segments, one per entry of the block-anchored approved_models list.
// Height past the deadline (or a degenerate span) clamps to the last model.
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
    modelIndex
};
