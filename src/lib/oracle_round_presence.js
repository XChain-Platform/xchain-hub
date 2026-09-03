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
 * XChain Hub - Oracle round PRESENCE
 *
 * Presence is a weaker and far more comparable claim than price: for each round
 * in a range, did this hub record the round AT ALL, and with what outcome class?
 * Testnet rounds 25-27 (2026-08-28) finalized on nobody and left rows on exactly
 * one of five validators, and nothing in the hub surfaced that: getpricesnapshots
 * returns the rows a hub HAS, so a hub that holds nothing for a round looks
 * identical to a hub asked about a round that never existed.
 *
 * The fold below turns a range of price_snapshots rows into one row per round,
 * classified into a small stable vocabulary, plus the explicit `missing` list and
 * a digest over (round, status) pairs. Two hubs agree iff their digests match over
 * the same range; when they differ, `missing` and the per-round statuses say where.
 *
 * Deliberately NOT part of the digest: pair counts, prices, reference blocks. Pair
 * COUNT legitimately differs between hubs (the derived-pair activation gate is
 * round-keyed, and a per-pair drop marker writes a skipped row for some pairs of an
 * otherwise finalized round), so folding it in would make healthy rounds diverge and
 * train operators to ignore the signal. Counts still ride along as detail.
 */
'use strict';

const crypto = require('crypto');

// Outcome classes, most-to-least authoritative. A round with ANY finalized pair
// finalized here; one with only skipped rows was recorded as lost here; 'disputed'
// is the reorg-retraction state; 'missing' is the absence this module exists for.
const STATUS_FINALIZED = 'finalized';
const STATUS_SKIPPED   = 'skipped';
const STATUS_DISPUTED  = 'disputed';
const STATUS_MISSING   = 'missing';

// Cap on how many rounds one presence answer covers. A comparison is only useful
// when both hubs are asked about the same range, and an unbounded range turns a
// cheap health probe into a table scan.
const MAX_RANGE = 1000;
const DEFAULT_RANGE = 50;

// Number('') and Number(null) are both 0, so an absent bound would silently become
// round 0 and make the answer claim every round since genesis is missing. Reject the
// empty-ish values explicitly rather than trusting Number.isFinite alone.
function toInt(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    let n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Fold price_snapshots rows (any order, any subset of the range) into one entry
// per round of [fromRound, toRound]. Rows outside the range are ignored, so the
// caller may hand over a wider result set than it asked about.
function summarizeRoundPresence(rows, fromRound, toRound) {
    let from = toInt(fromRound);
    let to   = toInt(toRound);
    if (from === null || to === null || to < from) return { rounds: [], missing: [], digest: null };

    let byRound = new Map();
    for (let row of (rows || [])) {
        let r = toInt(row && row.round_number);
        if (r === null || r < from || r > to) continue;
        let entry = byRound.get(r);
        if (!entry) {
            entry = { round: r, pairs: 0, finalized_pairs: 0, skipped_pairs: 0, disputed_pairs: 0,
                      reference_block: null, block_timestamp: null };
            byRound.set(r, entry);
        }
        entry.pairs++;
        if (row.status === STATUS_FINALIZED)      entry.finalized_pairs++;
        else if (row.status === STATUS_SKIPPED)   entry.skipped_pairs++;
        else if (row.status === STATUS_DISPUTED)  entry.disputed_pairs++;
        // The anchor is per-round, so the lowest non-null value any pair carries is
        // the round's. Kept as detail: two hubs disagreeing on a round's BTC anchor
        // is a different (and rarer) fault than disagreeing on its presence.
        let block = toInt(row.reference_block);
        if (block !== null && (entry.reference_block === null || block < entry.reference_block))
            entry.reference_block = block;
        let ts = toInt(row.block_timestamp);
        if (ts !== null && (entry.block_timestamp === null || ts < entry.block_timestamp))
            entry.block_timestamp = ts;
    }

    let out = [];
    let missing = [];
    for (let r = from; r <= to; r++) {
        let entry = byRound.get(r);
        if (!entry) {
            missing.push(r);
            out.push({ round: r, status: STATUS_MISSING, pairs: 0, finalized_pairs: 0,
                       skipped_pairs: 0, disputed_pairs: 0, reference_block: null, block_timestamp: null });
            continue;
        }
        entry.status = entry.finalized_pairs > 0 ? STATUS_FINALIZED
                     : entry.skipped_pairs   > 0 ? STATUS_SKIPPED
                     : entry.disputed_pairs  > 0 ? STATUS_DISPUTED
                     : STATUS_MISSING;   // rows with an unrecognised status: presence unproven
        out.push(entry);
    }

    return { rounds: out, missing: missing, digest: presenceDigest(out) };
}

// One comparable string over the whole range. Round order is the range's own, so
// two hubs asked about the same range hash the same sequence.
function presenceDigest(rounds) {
    let canonical = (rounds || []).map(r => r.round + ':' + r.status).join('|');
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Compare presence answers from several hubs over the SAME range. Returns the
// rounds where they disagree, each with the per-hub status, so an operator sees
// "round 26: validator03 skipped, everyone else missing" rather than a bare
// "digests differ". `answers` is [{ hub, presence }].
function comparePresence(answers) {
    let entries = (answers || []).filter(a => a && a.presence && Array.isArray(a.presence.rounds));
    if (entries.length < 2) return { agreed: entries.length === 1, divergent: [], hubs: entries.length };

    let byRound = new Map();
    for (let { hub, presence } of entries) {
        for (let r of presence.rounds) {
            if (!byRound.has(r.round)) byRound.set(r.round, {});
            byRound.get(r.round)[hub] = r.status;
        }
    }

    let divergent = [];
    for (let round of [...byRound.keys()].sort((a, b) => a - b)) {
        let perHub = byRound.get(round);
        let seen = new Set();
        for (let hub of entries.map(e => e.hub)) seen.add(perHub[hub] || STATUS_MISSING);
        if (seen.size > 1) divergent.push({ round: round, statuses: perHub });
    }
    return { agreed: divergent.length === 0, divergent: divergent, hubs: entries.length };
}

module.exports = {
    summarizeRoundPresence,
    presenceDigest,
    comparePresence,
    MAX_RANGE,
    DEFAULT_RANGE,
    STATUS_FINALIZED,
    STATUS_SKIPPED,
    STATUS_DISPUTED,
    STATUS_MISSING
};
