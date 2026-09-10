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
 * Oracle clamp-reference round alignment.
 *
 * WHAT FLIPS AT THIS HEIGHT. One thing: whether OracleConsensus re-reads the
 * last-finalized clamp reference for the round it is about to judge
 * (_refreshLastFinalizedForRound) before finalizeRound aggregates and before
 * _handlePropose's co-sign gate reads it. Below the height neither call site runs,
 * so the reference has exactly the three writers it had before the alignment
 * landed: the start-up seed, this hub's own _storeSnapshot (plus the push-ingest
 * fold that shares its monotonic writer) and the 60 s timed re-seed. At or above
 * it the round-aligned re-read runs unchanged.
 *
 * WHY IT NEEDS A GATE. The reference is what _clampToLastFinalized bounds the
 * emitted median against and what the no-local-submission co-sign band measures
 * against, so it decides bytes the federation signs. Measured on the guard case:
 * with a reference one round stale an identical submission set clamps to
 * 125.00000000 where an aligned hub emits 250.00000000, twice the price and far
 * outside the co-sign band. A rolling deploy therefore puts aligned and unaligned
 * hubs on the same PROPOSE with different references, which is the split the
 * alignment exists to close, reintroduced for the length of the roll wave. Under
 * one height the whole fleet changes reference on the same round whatever order
 * the binaries land in.
 *
 * ACTIVATION PLANE: the ROUND's own BTC block height. finalizeRound gates on the
 * btcBlockHeight it was called with, the same value it hands
 * CapabilitySnapshot.getWeightSnapshot('price', ...) to lock the round's validator
 * set, and the same value stake_weighted_quorum keys on. _handlePropose gates on
 * the envelope's btcBlockHeight, which is the field that becomes `blockHeight`
 * for the weighted-quorum gate a few lines below it, so a follower and the leader
 * evaluate one round against one height. Rounds that arrive by push from a source
 * chain carry no BTC height into this path at all: they are folded through
 * noteIngestedPriceRow, never through finalizeRound or _handlePropose, so they
 * touch neither call site and need no plane of their own.
 *
 * The propose-side height is read before the freshness bound that checks it
 * against this hub's own tip. A registered sender can therefore claim a height
 * across the gate and make recipients take the other branch for that round before
 * the PROPOSE is dropped. It buys nothing: the re-read is monotonic and fail-soft,
 * it can only carry the reference forward to rows this hub's own database already
 * holds, and that is exactly the state the 60 s re-seed reaches on its own
 * schedule below the height. There is no reference a forged height can produce
 * that an honest hub could not already have been holding.
 *
 * HEIGHTS.
 *
 *   testnet 152400. BTC testnet tip was 151817 measured 2026-09-10 at 17:35Z and
 *   testnet blocks run about 20 minutes each, so 583 blocks is roughly 8 days out,
 *   a week past the v0.17.0 hub roll. It is deliberately the SAME boundary as
 *   ATTEST_LEADER_SILENCE_SKIP_ACTIVATION, so the v0.17.0 hub roll has ONE
 *   activation boundary to rehearse, watch and roll back rather than two.
 *
 *   mainnet null, the UNRATIFIED sentinel: the timer-only reference runs byte for
 *   byte. Mainnet hub writes are held, so there is no wave to coordinate and
 *   nothing to arm against; the height is ratified in the same operator ruling
 *   that lifts the hold.
 *
 *   regtest 0, armed at genesis so the e2e venue exercises the aligned path.
 *
 * HUB-ONLY, AND DELIBERATELY NOT VENDORED. The clamp runs inside the hub's
 * aggregation and its own co-sign decision; no indexer recomputes it. PRICE v0
 * validation reads the published prices and the signature tally, never the
 * reference a hub bounded them with, so there is no indexer twin to keep
 * value-identical. This map is therefore not a member of
 * consensus_rules_digest.js's SHARED_GATES, which is the hub/indexer
 * INTERSECTION: a hub-only entry there would report ABSENT on every indexer and
 * turn a correct build into a permanent rules mismatch, and would also lengthen
 * the ROLLCALL v1 GATES field, dropping every validator whose last rolled call
 * predates it. xchain_price_activation.js and
 * attest_leader_silence_skip_activation.js are the standing precedents for a
 * hub-only gate that stays out of the digest for the same reason.
 *
 ********************************************************************/

'use strict';

// Per-network activation height. Compared against the round's own BTC block
// height. See the header for how each value was sized.
const ORACLE_CLAMP_REFERENCE_ACTIVATION = {
    mainnet: null,        // INERT: operator-owned height, unratified while mainnet hub writes are held
    testnet: 152400,      // SIZED 2026-09-10: tip 151817 at 17:35Z at about 20 min/block, so about 8 days out, a week past the v0.17.0 hub roll and the same boundary as ATTEST_LEADER_SILENCE_SKIP_ACTIVATION
    regtest: 0,           // ARMED at genesis so the e2e venue exercises the aligned path
};

// Networks already reported by the guard below, so a per-round per-PROPOSE path
// says it once rather than once per message.
const warnedUnknownNetworks = new Set();

// True when a round at `blockHeight` re-reads its clamp reference. False is the
// timer-only reference, byte for byte.
//
// `null` is the UNRATIFIED sentinel and must read as "off": without the explicit
// null test `blk >= null` coerces to `blk >= 0` and aligns every round of an
// unratified network, the inverse of what the sentinel means. A network with NO
// ENTRY is a misconfiguration rather than a posture, and is reported once.
function isClampReferenceAlignActive(blockHeight, network){
    let threshold = ORACLE_CLAMP_REFERENCE_ACTIVATION[network];
    if(threshold === undefined && !warnedUnknownNetworks.has(String(network))){
        warnedUnknownNetworks.add(String(network));
        console.warn('Oracle clamp reference: no activation entry for network ' +
            JSON.stringify(String(network)) + ', so the round-aligned re-read is OFF for every round. ' +
            'Known networks: ' + Object.keys(ORACLE_CLAMP_REFERENCE_ACTIVATION).join(', ') + '.');
    }
    if(threshold === null || threshold === undefined) return false;
    let blk = parseInt(blockHeight);
    if(!Number.isFinite(blk)) return false;
    return blk >= threshold;
}

module.exports = {
    ORACLE_CLAMP_REFERENCE_ACTIVATION,
    isClampReferenceAlignActive
};
