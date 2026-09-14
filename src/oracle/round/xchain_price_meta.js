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
 * XChain Hub - Oracle Round XCHAIN/USD Metadata Line
 *
 * The audit line the round log carries for the derived pair. Required by the
 * round path that prints it and re-exported by round.js, which is where the
 * test that asserts it reads it from.
 *
 ********************************************************************/

// Render the XCHAIN/USD derivation metadata for the round log (§10 step 6).
//
// §5 claims manipulation of this pair is "visible". That claim is only true if the
// inputs behind a print are recorded somewhere an operator can read after the fact,
// so this line is part of the design rather than debug chatter. It carries the
// window height range, the fill counts (used, clamped, excluded), both volumes, the
// winsorization reference, and - critically - the RAW pre-winsorize VWAP beside the
// published rate. A round where those two differ is a round where the defence fired,
// and nothing else in the system would say so.
//
// Deliberately one line and human-readable: it lands in the same log a hub operator
// already tails for `Oracle: Round`, and a structured sink can be added later without
// changing what the derivation computes.
function formatXchainPriceMeta(meta) {
    if (!meta) return '(no metadata)';
    let w = meta.window || {};
    // Rendered with the bound semantics visible, because they are load-bearing: the
    // low bound is EXCLUSIVE and the high bound INCLUSIVE, which is what makes
    // consecutive rounds tile without double-counting a block's fills.
    let parts = ['window (' + (w.fromBlockExclusive != null ? w.fromBlockExclusive : '?') +
                 ', ' + (w.toBlockInclusive != null ? w.toBlockInclusive : '?') + ']'];

    if (meta.derived) {
        parts.push(meta.usedFills + ' fills');
        parts.push(meta.clampedFills + ' clamped');
        parts.push(meta.droppedFills + ' excluded');
        parts.push('vol ' + meta.btcVolume + ' BTC / ' + meta.totalXchain + ' XCHAIN');
        parts.push('raw ' + meta.rawXchainBtc + ' -> published ' + meta.xchainBtc + ' BTC');
        parts.push('ref ' + meta.refRate);
    } else {
        parts.push('carry-forward from ' + meta.carriedFrom);
        parts.push(meta.fillCount + ' fills in window');
        if (meta.reason) parts.push(meta.reason);
        // Present only when the volume gate was what held the price back, and it is
        // the field that distinguishes "the market was quiet" from "the market traded
        // and we chose not to follow it yet".
        if (meta.btcVolume !== undefined)
            parts.push('vol ' + meta.btcVolume + ' BTC vs threshold ' +
                       (meta.minBtcVolume === null ? 'DISABLED' : meta.minBtcVolume));
        if (meta.wouldHaveBeen !== undefined)
            parts.push('would have been ' + meta.wouldHaveBeen + ' BTC');
    }
    return '(' + parts.join(', ') + ')';
}

module.exports = { formatXchainPriceMeta };
