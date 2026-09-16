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
 * XChain Hub - Price Aggregator: PRICE batch validation
 *
 * What a pushed batch can be judged on before any signature or database work:
 * the declared window, the landing and anchor heights, the per-round structure
 * with its forwarded admission maps, the header-anchor and flag-day straddle
 * rules, and the structural signature shape.
 *
 ********************************************************************/

const { PRICE_MAX } = require('../../constants.js');
const { PRICE_BATCH_MAX_ROUND_COUNT } = require('../../price_batch_compression.js');
const pricePair         = require('../../consensus/gates/price_pair_gate.js');
const priceScale        = require('../../consensus/gates/price_scale_gate.js');
// The verify-first tally rule is a registry row read by literal key (W5), on the
// batch's BTC anchor height.
const gateRegistry      = require('../../consensus/gate_registry');
const PRICE_SIG_TALLY_KEY = 'price_sig_tally_activation.PRICE_SIG_TALLY_ACTIVATION';
const swq               = require('../../consensus/stake_weighted_quorum.js');

// The declared round window: the batch shape, its DoS bound and the plausible-round
// band. Returns { reason } for a refusal, or the window the rest of the path reads.
function validateBatchWindow(sourceChain, batchData) {
    if (!batchData || !Array.isArray(batchData.rounds) || batchData.rounds.length < 1) {
        return { reason: 'invalid batchData' };
    }
    // DoS bound, mirroring the wire parser's own (D15): the round count rides in
    // from an external pusher and every round below costs a dedupe SELECT plus an
    // INSERT. The wire ceiling already makes a larger batch physically impossible.
    if (batchData.rounds.length > PRICE_BATCH_MAX_ROUND_COUNT) {
        return { reason: 'too many rounds' };
    }

    let firstRound = parseInt(batchData.first_round);
    let lastRound  = parseInt(batchData.last_round);
    if (!Number.isFinite(firstRound) || firstRound < 0 ||
        !Number.isFinite(lastRound)  || lastRound  < 0 || firstRound > lastRound) {
        return { reason: 'invalid round window' };
    }

    // Batch twin. Judged on lastRound alone: the per-round loop below
    // already refuses any round outside [firstRound, lastRound], so the window's
    // top bounds every round the batch can carry. A signed batch is atomic, so an
    // out-of-band round takes the whole batch down rather than being dropped from it.
    let bandReason = this.refuseOutOfBandRound(lastRound, sourceChain, 'PRICE v0 batch');
    if (bandReason) return { reason: bandReason };
    return { firstRound, lastRound };
}

// The heights and the clock a batch is judged on, plus the two wire-format patterns
// they key. Returns { reason } for a refusal, or the values the rest of the path reads.
function validateBatchAnchors(batchData) {
    // The BATCH anchor: part of the signed canonical, and the height every oracle
    // flag day below resolves on (§5.5). Distinct from each round's own anchor.
    let btcBlockHeight = parseInt(batchData.btc_block_height);
    if (!Number.isFinite(btcBlockHeight) || btcBlockHeight < 0) {
        return { reason: 'invalid btc_block_height' };
    }

    // block_index is the LANDING block on the landing chain, and it is what the
    // stored reference_block records (D8). It is NOT what the validator snapshot
    // resolves on; see the snapshot read below.
    let referenceBlock = parseInt(batchData.block_index);
    if (!Number.isFinite(referenceBlock) || referenceBlock < 0) {
        return { reason: 'invalid block_index' };
    }

    // block_time is the landing block's own clock, and it is why the batch push
    // carries a field the v0 push does not (D14). The pair-name flag day is keyed
    // on it below; digits-only and inside the safe-integer range, on the same
    // reasoning receiveOraclePrice records for its own block_time gate (parseInt
    // rounds silently past 2^53, and a coerced 0 would read as "before every flag
    // day" on a genesis-on network).
    if (!/^[0-9]+$/.test(String(batchData.block_time)) ||
        !Number.isSafeInteger(Number(batchData.block_time)) ||
        Number(batchData.block_time) <= 0) {
        return { reason: 'invalid block_time' };
    }
    let blockTime = parseInt(batchData.block_time, 10);

    // THE PAIR-NAME FLAG DAY IS KEYED ON THE BATCH'S block_time, NOT on each
    // round's own timestamp as v0 keys it (D14). v0 has no block time in its push
    // payload and accepts the resulting skew because it is one-sided and small: a
    // round is stamped, then mined, so block_time >= timestamp and the hub can only
    // activate LATER than the chain (one round of carry-forward, self-healing). A
    // batch widens that skew from ~10 minutes to ~70, so keying this gate on a
    // round timestamp would have the hub refuse a whole HOUR the chain accepted.
    // Carrying block_time and keying on it is the clean fix the
    // comment in receiveValidatedRound already names. One pattern for the whole
    // batch, because every round in it landed in the same block.
    let pairPattern = pricePair.pricePairPattern(blockTime, this.hub && this.hub.network);

    // The price-value flag day, keyed on the batch's block_time for the same reason
    // the pair bound is: one pattern for the whole batch, because every round in it
    // landed in the same block, and no window can straddle this gate.
    let pricePattern = priceScale.priceValuePattern(blockTime, this.hub && this.hub.network);
    return { btcBlockHeight, referenceBlock, blockTime, pairPattern, pricePattern };
}

// Identical pair rules to v0 (wire-format parity, PRICE_MAX ceiling and the
// positive lower bound), so a batch cannot smuggle past ingest a pair a
// single-round push would be refused for.
function validateBatchRoundPairs(pairs, pairPattern, pricePattern) {
    for (let p of pairs) {
        if (!p || typeof p.pair !== 'string' || !pairPattern.test(p.pair) ||
            p.price === undefined || p.price === null || !pricePattern.test(String(p.price)) ||
            !(parseFloat(String(p.price)) > 0) ||
            !(parseFloat(String(p.price)) < PRICE_MAX)) {
            return 'invalid pairs';
        }
    }
    return null;
}

// The round's admission map, forwarded from the push exactly as the producer
// signed it and never rebuilt from this hub's own tips (a re-resolved map would
// rebuild bytes no signature covers). Era-keyed on THIS round's own anchor, per
// round rather than per batch, because the rounds in one window were opened at
// different tips. Shape-checked here so a malformed map reads as a refusal with
// a reason rather than as a canonical builder throw; the era rule itself (a map
// exactly when the round is in the admission era) is enforced by the canonical
// builder below, which refuses in both directions.
function forwardedAdmitBlocks(r) {
    let admitBlocks = null;
    if (r.admit_blocks !== undefined && r.admit_blocks !== null) {
        if (typeof r.admit_blocks !== 'object') return { reason: 'invalid admit_blocks' };
        let encoded;
        try { encoded = this.admission.encodeAdmitBlocks(r.admit_blocks); }
        catch (e) { return { reason: 'invalid admit_blocks' }; }
        admitBlocks = this.admission.decodeAdmitBlocks(encoded);
        if (admitBlocks === null) return { reason: 'invalid admit_blocks' };
    }
    return { admitBlocks };
}

// Per-round structure. Rounds must be strictly ascending, unique and inside the
// declared window (D16); the window is validated for shape, deliberately NOT
// against the publisher's window-size knob, so validation stays range-agnostic.
function validateBatchRounds(batchData, window) {
    let rounds  = [];
    let prev    = null;
    for (let r of batchData.rounds) {
        if (!r || !Array.isArray(r.pairs) || r.pairs.length < 1) return { reason: 'invalid rounds' };
        let round = parseInt(r.round);
        if (!Number.isFinite(round) || round < 0)               return { reason: 'invalid rounds' };
        if (round < window.firstRound || round > window.lastRound) return { reason: 'round outside window' };
        if (prev !== null && round <= prev)                     return { reason: 'rounds not strictly ascending' };
        prev = round;

        let timestamp = parseInt(r.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < 0)       return { reason: 'invalid round timestamp' };
        let roundAnchor = parseInt(r.btc_block_height);
        if (!Number.isFinite(roundAnchor) || roundAnchor < 0)   return { reason: 'invalid round btc_block_height' };

        let pairsReason = validateBatchRoundPairs(r.pairs, window.pairPattern, window.pricePattern);
        if (pairsReason) return { reason: pairsReason };

        let admit = forwardedAdmitBlocks.call(this, r);
        if (admit.reason) return { reason: admit.reason };
        let entry = { round, timestamp, btcBlockHeight: roundAnchor, pairs: r.pairs };
        if (admit.admitBlocks !== null) entry.admitBlocks = admit.admitBlocks;
        rounds.push(entry);
    }
    return { rounds };
}

// THE HEADER ANCHOR IS CONSTRAINED TO THE LAST ROUND'S OWN ANCHOR (§4), the twin
// of the indexer parser's structural check. Both quorum gates below resolve on
// this one value and the straddle rule inspects only the per-round anchors, so an
// unconstrained header would let a colluding signing quorum pick which consensus
// rule judges its own batch while every per-round anchor stayed honest. The rounds
// are strictly ascending by the loop above, so the last one carries the window's
// highest anchor. Checked BEFORE the gates read it, or it protects nothing.
function refuseUnanchoredOrStraddlingBatch(btcBlockHeight, rounds) {
    if (btcBlockHeight !== rounds[rounds.length - 1].btcBlockHeight) {
        return 'batch anchor does not match the last round';
    }

    let network = this.hub && this.hub.network;

    // STRADDLE RULE (D7 / §5.4): a batch resolves the oracle flag days ONCE, on the
    // batch anchor, so a window whose first and last rounds sit on opposite sides of
    // an armed gate would judge its earlier rounds under the later rule. Such a batch
    // is invalid on-chain and the publisher never assembles one; refusing it here
    // keeps the hub from storing rounds the chain rejected.
    let firstAnchor = rounds[0].btcBlockHeight;
    let lastAnchor  = rounds[rounds.length - 1].btcBlockHeight;
    if (gateRegistry.activeAt(PRICE_SIG_TALLY_KEY, network, null, firstAnchor, null) !==
        gateRegistry.activeAt(PRICE_SIG_TALLY_KEY, network, null, lastAnchor, null) ||
        swq.isStakeWeightedQuorumActive(firstAnchor, network) !==
        swq.isStakeWeightedQuorumActive(lastAnchor, network) ||
        this.admission.isAdmissionEra(network, firstAnchor) !== this.admission.isAdmissionEra(network, lastAnchor)) {
        return 'batch straddles an oracle flag day';
    }
    return null;
}

// Structural sig validation: [{ pubkey: 64-hex, sig: 128-hex }, ...]
function validateBatchSigs(batchData) {
    if (!Array.isArray(batchData.sigs) || batchData.sigs.length < 1) {
        return { reason: 'invalid sigs' };
    }
    let sigs = [];
    for (let s of batchData.sigs) {
        if (!s || typeof s.pubkey !== 'string' || typeof s.sig !== 'string' ||
            !/^[0-9a-fA-F]{64}$/.test(s.pubkey) || !/^[0-9a-fA-F]{128}$/.test(s.sig)) {
            return { reason: 'invalid sigs' };
        }
        sigs.push({ pubkey: s.pubkey.toLowerCase(), sig: s.sig.toLowerCase() });
    }
    return { sigs };
}

module.exports = {
    validateBatchWindow, validateBatchAnchors, validateBatchRounds,
    refuseUnanchoredOrStraddlingBatch, validateBatchSigs
};
