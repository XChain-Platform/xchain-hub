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
 * XChain Hub - relay effective_time propagation floor
 *
 * Both mirror-settled engines stamp a quorum-signed row with an
 * `effective_time` and every indexer applies the row at the first block whose
 * block_time reaches it (`effective_time <= block_time`). The stamp is
 * therefore a propagation deadline, not a timestamp: if a row becomes
 * effective before it has reached every indexer, the node that already has it
 * injects at block N while a node that receives it a moment later injects at
 * N+1. Both then carry different action-index counters, and the action index
 * is in the call_id / settlement preimage, so the ledgers fork permanently.
 *
 * The floor here is what makes "effective in the future" a rule rather than a
 * default. It is enforced at BOTH halves, because each half closes a different
 * failure:
 *
 *   producer  clamps the operator-tunable margin from below, so an unsafe
 *             XCALL_RELAY_MARGIN_BLOCKS=0 (or a DEX match, which had no margin
 *             mechanism at all) can no longer stamp the bare clock second;
 *   follower  refuses to co-sign a row that is not at least MIN_FUTURE_S ahead
 *             of its OWN clock, so a faulty or Byzantine leader cannot hand
 *             honest validators an immediately-effective row whatever its own
 *             configuration says.
 *
 * MIN_FUTURE_S is deliberately far smaller than any producer margin. The
 * follower's job is only to refuse a row with no propagation window at all;
 * sizing the full designed margin is the producer's. Keeping it small also
 * keeps the existing +/-3600s clock-skew tolerance essentially intact (an
 * honest row survives 3600 - MIN_FUTURE_S seconds of adverse skew plus round
 * latency), so closing this hole cannot stall finalization on a fleet whose
 * clocks were already good enough to finalize yesterday.
 *
 **********************************************************************/

'use strict';

// Nominal block interval (seconds) per chain, used ONLY to size relay margins in
// wall-clock seconds. Not consensus-critical: a margin need only comfortably
// exceed realistic hub->indexer row-arrival lag, so an approximate interval is fine.
const NOMINAL_BLOCK_INTERVAL_S = { BTC: 600, LTC: 150, DOGE: 60 };

// Forward margin, in blocks of the chain that GATES the row.
const DEFAULT_RELAY_MARGIN_BLOCKS = 4;

// Hard ceiling (seconds) on any computed margin. A follower refuses a row whose
// effective_time is more than 3600s ahead of its clock, so the margin must stay
// safely under that or an honest leader's row would be rejected.
const RELAY_MARGIN_MAX_S = 3000;

// Follower-side floor (seconds): the minimum distance into the future an adopted
// effective_time must sit before this validator will co-sign the row.
const RELAY_MIN_FUTURE_S = 60;

function blockIntervalS(gatingChain){
    return NOMINAL_BLOCK_INTERVAL_S[gatingChain] || NOMINAL_BLOCK_INTERVAL_S.BTC;
}

// The non-negotiable producer margin for `gatingChain`: DEFAULT_RELAY_MARGIN_BLOCKS
// of that chain, capped by the follower clock-skew bound.
function relayMarginFloorS(gatingChain){
    return Math.min(DEFAULT_RELAY_MARGIN_BLOCKS * blockIntervalS(gatingChain), RELAY_MARGIN_MAX_S);
}

// Margin (seconds) a producer stamps for `gatingChain` at a configured block
// count: clamped UP to the floor and DOWN to the ceiling, so neither a zeroed nor
// an absurd XCALL_RELAY_MARGIN_BLOCKS can produce a row a peer must refuse.
function relayMarginS(gatingChain, blocks){
    let want = (Number.isFinite(blocks) ? blocks : DEFAULT_RELAY_MARGIN_BLOCKS) * blockIntervalS(gatingChain);
    return Math.min(Math.max(want, relayMarginFloorS(gatingChain)), RELAY_MARGIN_MAX_S);
}

module.exports = {
    NOMINAL_BLOCK_INTERVAL_S,
    DEFAULT_RELAY_MARGIN_BLOCKS,
    RELAY_MARGIN_MAX_S,
    RELAY_MIN_FUTURE_S,
    blockIntervalS,
    relayMarginFloorS,
    relayMarginS
};
