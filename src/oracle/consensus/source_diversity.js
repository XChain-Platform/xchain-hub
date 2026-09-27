'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function singleSourcePairs(submissions, capablePairs, limit = 5) {
    let submittersByPair = new Map();
    if (!submissions) return { pairs: [], total: 0 };

    for (let [submitter, submission] of submissions) {
        if (!submission || !Array.isArray(submission.prices)) continue;
        for (let price of submission.prices) {
            if (!price || typeof price.coinPair !== 'string') continue;
            if (capablePairs && !capablePairs.has(price.coinPair)) continue;
            if (!Number.isFinite(price.sources) || price.sources > 1) continue;
            if (!submittersByPair.has(price.coinPair)) submittersByPair.set(price.coinPair, new Set());
            submittersByPair.get(price.coinPair).add(String(submitter).slice(0, 12));
        }
    }

    let pairs = [...submittersByPair]
        .map(([coinPair, submitters]) => ({ coinPair, submitters: [...submitters].sort() }))
        .sort((a, b) => a.coinPair.localeCompare(b.coinPair));
    return { pairs: pairs.slice(0, limit), total: pairs.length };
}

module.exports = { singleSourcePairs };
