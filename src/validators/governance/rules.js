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
 * XChain Hub - governance RULES: the wire message types, the constants every hub
 * must agree on, and the pure helpers built from them.
 *
 * Nothing here touches the engine or the database. It is the half of governance a
 * reader has to hold to read any other half: what a vote is signed over, what makes
 * a vote seq usable, the earliest block a block-anchored change may activate at, and
 * the bounds a change is measured against. The engine and its mixins all read them
 * from here, so a constant has one definition per repo. The one flag-day table
 * among them is a row of the hub's activation registry, read here by key, so the
 * table lives in one place per repo and this module keeps its readers' shape.
 *
 ********************************************************************/

const { get } = require('../../consensus/gate_registry');

const GOV_PROPOSE = 'GOV_PROPOSE';
const GOV_VOTE    = 'GOV_VOTE';
const GOV_RESULT  = 'GOV_RESULT';

// Block-anchored activation for capability MIN_STAKE changes (#3703). Capability snapshots are
// BTC-anchored, so activation heights are reasoned in BTC blocks. A MIN_STAKE change must not
// take effect until every hub has finalized it -- i.e. comfortably after the voting period ends
// plus a propagation/apply margin -- so the activation block is computed as the proposer's latest
// observed block + (voting period in blocks) + a safety buffer. The proposer's value rides in the
// agreed, authenticated proposal, so every hub anchors the change to the identical block.
const BTC_BLOCK_MS                    = 600000; // ~10 min/block
const ACTIVATION_SAFETY_BUFFER_BLOCKS = 50;     // ~8h past finalize for GOV_RESULT propagation

// Change bounds
const MAX_INCREASE         = 0.50;  // 50% max increase
const MAX_DECREASE         = 0.33;  // 33% max decrease
const MAX_SLASH_INCREASE   = 0.25;  // 25% max increase for slashing params
const MAX_SLASH_DECREASE   = 0.20;  // 20% max decrease for slashing params
const COOLDOWN_DAYS        = 14;    // Days before re-proposing a rejected parameter

const SLASHING_PARAMS = ['SLASH_DEVIATION_THRESHOLD', 'SLASH_MISSED_ROUNDS_THRESHOLD'];

// R2-M2: the BTC height per network at/above which the electorate is
// snapshot-locked onto each proposal (the snapshot is REQUIRED and is the tally
// denominator; below it the legacy live-set tally applies). The heights and
// the why live with the row in consensus/gate_registry/hub_rows.js; the
// registry hands back a frozen table under the same name, so electorate.js
// indexes it by network exactly as it did the literal, and a build without
// the row throws here at load rather than reading the lock as off.
const GOV_SNAPSHOT_ACTIVATION = get('validators/governance/rules.GOV_SNAPSHOT_ACTIVATION');

// Bounds on a persisted/wire snapshot (DoS): a validator set is small, so a
// snapshot far past these is adversarial padding, not a real electorate.
const GOV_SNAPSHOT_MAX_VALIDATORS = 1000;
const GOV_SNAPSHOT_MAX_BYTES      = 262144;   // 256 KB serialized

// GOV-VOTE-REPLAY-1: the exact bytes a governance vote is signed over.
// THREE paths produce these bytes (vote() signs, handleVote and
// ingestResultVotes verify), and a one-byte disagreement between them silently
// drops every peer's vote, so they all call this and nothing builds the payload
// inline. Key order is part of the wire contract: never reorder it.
//
// `seq` is what makes a vote non-replayable. Without it the payload was a pure
// function of (proposal, choice, voter), so a captured (payload, signature) pair
// stayed valid forever and could be re-broadcast to overwrite a later opposite
// vote, since the sink is keyed on (proposal_id, voter_pubkey) and was
// last-write-wins. With seq inside the signed bytes, replaying an old vote
// reproduces its old seq, and the sink refuses anything not strictly greater.
function voteSigningPayload(proposalId, vote, voterPubkey, seq) {
    return JSON.stringify({ proposalId, vote, voter: voterPubkey, seq: normalizeVoteSeq(seq) });
}

// A vote seq is a positive integer that fits a BIGINT column and survives
// JSON.stringify byte-identically on every hub. Anything else (missing, NaN,
// negative, fractional, Infinity, a numeric string from an older peer) is not
// coerced into something plausible: it returns 0, which callers treat as
// "unsigned by a hub that predates GOV-VOTE-REPLAY-1" and refuse. Coercing would let a peer pick bytes
// our verifier reconstructs differently than the signer did.
function normalizeVoteSeq(seq) {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) return 0;
    return seq;
}

// Minimum activation block for parameters that are block-anchored. Used on the
// follower path to re-validate the proposer-supplied activation_block so a
// dishonest peer cannot install an already-past (or too-soon) anchor.
// `latestBlock` is this hub's best observed BTC height at receive time.
// `votingPeriodMs` is this hub's local governance.votingPeriod.
// Returns the minimum valid activation_block.
function minActivationBlock(latestBlock, votingPeriodMs) {
    let votingBlocks = Math.ceil(votingPeriodMs / BTC_BLOCK_MS);
    return latestBlock + votingBlocks + ACTIVATION_SAFETY_BUFFER_BLOCKS;
}

// Parse a decimal string into { neg, int, frac } digit strings, or null if it is
// not a finite decimal. Used for exact (non-float) bounds comparison so large
// parameter values aren't rounded past the float64 safe-integer range.
function parseDecimalParts(v){
    let s = String(v == null ? '' : v).trim();
    if(!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    let neg = s[0] === '-';
    if(s[0] === '+' || s[0] === '-') s = s.slice(1);
    let dot = s.indexOf('.');
    let int  = (dot === -1 ? s : s.slice(0, dot)) || '0';
    let frac = dot === -1 ? '' : s.slice(dot + 1);
    if(/^0*$/.test(int) && /^0*$/.test(frac)) neg = false;
    return { neg: neg, int: int, frac: frac };
}

// Render parsed decimal parts as a signed BigInt scaled to `scale` fraction digits.
function toScaledBigInt(parts, scale){
    let v = BigInt(parts.int + parts.frac.padEnd(scale, '0'));
    return parts.neg ? -v : v;
}

module.exports = {
    GOV_PROPOSE, GOV_VOTE, GOV_RESULT,
    BTC_BLOCK_MS, ACTIVATION_SAFETY_BUFFER_BLOCKS,
    MAX_INCREASE, MAX_DECREASE, MAX_SLASH_INCREASE, MAX_SLASH_DECREASE, COOLDOWN_DAYS,
    SLASHING_PARAMS,
    GOV_SNAPSHOT_ACTIVATION, GOV_SNAPSHOT_MAX_VALIDATORS, GOV_SNAPSHOT_MAX_BYTES,
    voteSigningPayload, normalizeVoteSeq, minActivationBlock,
    parseDecimalParts, toScaledBigInt
};
