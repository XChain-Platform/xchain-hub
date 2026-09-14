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
 * XChain Hub - Price Aggregator: PRICE v0 round validation
 *
 * Everything a pushed single-round PRICE v0 can be judged on from the push
 * alone: the header fields, the wire-format pair and price rules under their
 * flag days, and the structural signature shape. No database and no signature
 * verification, so a malformed push costs nothing.
 *
 ********************************************************************/

const { PRICE_MAX } = require('../../constants.js');
const pricePair         = require('../../price_pair_activation.js');
const priceScale        = require('../../price_scale_activation.js');

// The round header: the fields that anchor the signed payload and the stored row.
// Returns { reason } for a refusal, or the parsed values the rest of the path reads.
function validateRoundFields(sourceChain, roundData) {
    if (!roundData || roundData.round === undefined || roundData.round === null || !Array.isArray(roundData.pairs) || roundData.pairs.length < 1) {
        return { reason: 'invalid roundData' };
    }

    let round = parseInt(roundData.round);
    if (!Number.isFinite(round) || round < 0) {
        return { reason: 'invalid round' };
    }

    // The round number must be one this hub's own schedule could have
    // produced. Checked BEFORE any signature work, since an out-of-band round is
    // refused whatever it is signed with.
    let bandReason = this.refuseOutOfBandRound(round, sourceChain, 'PRICE v0 round');
    if (bandReason) return { reason: bandReason };

    // timestamp is part of the signed payload; it must be present and sane
    let timestamp = parseInt(roundData.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
        return { reason: 'invalid timestamp' };
    }

    // block_index anchors both the signed payload's validator snapshot and
    // the stored reference_block; verification is impossible without it
    let referenceBlock = parseInt(roundData.block_index);
    if (!Number.isFinite(referenceBlock) || referenceBlock < 0) {
        return { reason: 'invalid block_index' };
    }

    // btc_block_height is the round's BTC anchor, part of the signed payload and
    // the on-chain PRICE v0 wire. It is what the EQUIV header gate keys on, so the
    // hub reconstructs identical bytes to what the validators signed (#4232). It is
    // distinct from block_index (the block the PRICE tx itself was mined in).
    let btcBlockHeight = parseInt(roundData.btc_block_height);
    if (!Number.isFinite(btcBlockHeight) || btcBlockHeight < 0) {
        return { reason: 'invalid btc_block_height' };
    }
    return { round, timestamp, referenceBlock, btcBlockHeight };
}

// Every pair must satisfy the on-chain wire-format rules (mirrors the
// indexer's PRICE v0 parser) so the canonical payload reconstruction
// below is byte-exact with what the validators signed.
//
// The pair-name bound is flag-day gated (price_pair_activation.js,
// vendored byte-identically from the indexer): below it the ticker side caps
// at 5 characters and the 6-character XCHAIN/USD pair is unrepresentable;
// at/above it, 6 is accepted. UNARMED on mainnet today.
//
// KEYED ON THE ROUND TIMESTAMP, while the chain keys on the block time of the
// block the PRICE tx landed in. The push payload carries no block time (see
// actions/price.js), and the two are not equal: a round is stamped, then
// mined, so block_time >= timestamp. That asymmetry is deliberate and is the
// safe direction - the hub can only activate LATER than the chain, never
// earlier, so it may briefly withhold on a round the chain accepted (one
// round of carry-forward, self-healing) but can never finalize one the chain
// will reject. If even that blip is unacceptable at arming time, the clean
// fix is to add block_time to the hub-push payload and key on it here.
function validateRoundPairs(roundData, timestamp) {
    let pairPattern = pricePair.pricePairPattern(timestamp, this.hub && this.hub.network);

    // The price-value flag day (price_scale_activation.js, vendored byte-identically
    // from the indexer) rides the SAME key as the pair bound above, so the hub can
    // never grade a price under a rule the chain is not yet applying. At/above it a
    // price is canonical: no leading zeros, at most 8 decimals, which is what every
    // producer already emits and what bounds the stored string to 19 characters,
    // inside the price column. UNARMED on mainnet today.
    let pricePattern = priceScale.priceValuePattern(timestamp, this.hub && this.hub.network);
    for (let p of roundData.pairs) {
        if (!p || typeof p.pair !== 'string' || !pairPattern.test(p.pair) ||
            p.price === undefined || p.price === null || !pricePattern.test(String(p.price)) ||
            // Enforce the consensus PRICE_MAX ceiling at ingest, as constants.js mandates
            // ("the ingestion layer must reject anything at or above it"); every other
            // price entry point already does, so the ingest/aggregate bounds cannot drift
            // apart and a Byzantine round cannot smuggle an at/above-PRICE_MAX pair past
            // ingest (item 9e6c0acd). The positive lower bound mirrors the
            // governance-path check below: a quorum-signed zero (or all-zero)
            // price must not pass ingest and finalize as a real price.
            !(parseFloat(String(p.price)) > 0) ||
            !(parseFloat(String(p.price)) < PRICE_MAX)) {
            return 'invalid pairs';
        }
    }
    return null;
}

// Structural sig validation: [{ pubkey: 64-hex, sig: 128-hex }, ...]
function validateRoundSigs(roundData) {
    if (!Array.isArray(roundData.sigs) || roundData.sigs.length < 1) {
        return { reason: 'invalid sigs' };
    }
    let sigs = [];
    for (let s of roundData.sigs) {
        if (!s || typeof s.pubkey !== 'string' || typeof s.sig !== 'string' ||
            !/^[0-9a-fA-F]{64}$/.test(s.pubkey) || !/^[0-9a-fA-F]{128}$/.test(s.sig)) {
            return { reason: 'invalid sigs' };
        }
        sigs.push({ pubkey: s.pubkey.toLowerCase(), sig: s.sig.toLowerCase() });
    }
    return { sigs };
}

module.exports = { validateRoundFields, validateRoundPairs, validateRoundSigs };
