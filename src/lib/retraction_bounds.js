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
 * XChain Hub - Reorg-retraction bound normalization ()
 *
 * The three reorg-retraction engines (price, XCALL, DEX) take the same
 * (from, to, generation) triple off an indexer push and turn it into a
 * destructive DELETE/UPDATE. Each one used to coerce the optional bounds
 * inline, which failed OPEN: a supplied-but-unparseable to_action_index or
 * retraction_generation became NaN, missed the Number.isFinite guard, and
 * collapsed into the same branch as an ABSENT bound, silently widening a
 * closed generation-fenced retraction into an open-ended one. Two of them
 * also bound the required lower bound raw, where MariaDB coerces a
 * nonnumeric to 0 and the retraction takes the whole chain.
 *
 * Absent (undefined/null) still means open-ended / unfenced, which is the
 * documented older-indexer contract; only SUPPLIED-but-invalid is rejected.
 * The accepted set mirrors RetractionConsensus._normalizeRetraction so a
 * retraction this hub applies locally is one its peers will also co-sign.
 */

// Parse one action-index-shaped value, rejecting anything that is not plainly a
// number. Number() alone is too lenient here ('', ' ', [], [7], true all coerce
// to a number), and parseInt() is too lenient the other way ('12abc' -> 12,
// '1e3' -> 1); both silently invent a bound rather than refusing one.
function parseIndex(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
    if (typeof value !== 'string') return null;
    let trimmed = value.trim();
    if (trimmed === '') return null;
    let n = Number(trimmed);
    // Safe-integer, not merely integer: these columns are BIGINT and a value past 2^53
    // has already lost precision by the time it gets here, so it is not the bound sent.
    return Number.isSafeInteger(n) ? n : null;
}

// Normalize a retraction's bound triple, fail-closed. Returns { error } for a
// supplied-but-invalid value; otherwise { from, to, gen, bounded, fenced },
// where to/gen are null when the caller omitted them.
function normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration) {
    let from = parseIndex(fromActionIndex);
    if (from === null || from < 0) return { error: 'invalid from_action_index' };

    let to = null;
    if (toActionIndex !== undefined && toActionIndex !== null) {
        to = parseIndex(toActionIndex);
        // to < from is rejected rather than treated as an empty range: peers reject
        // the same event, so applying it locally is a divergence, not a no-op.
        if (to === null || to < from) return { error: 'invalid to_action_index' };
    }

    let gen = null;
    if (retractionGeneration !== undefined && retractionGeneration !== null) {
        gen = parseIndex(retractionGeneration);
        if (gen === null || gen < 0) return { error: 'invalid retraction_generation' };
    }

    return { from, to, gen, bounded: to !== null, fenced: gen !== null };
}

module.exports = { normalizeRetractionBounds, parseIndex };
