'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function hasUsablePrice(result, coinPairs) {
    if (!result || result.status !== 'fulfilled' || !result.value) return false;
    return coinPairs.some(pair =>
        result.value[pair] !== undefined && result.value[pair] !== null
    );
}

function summarizeSourceLiveness(keys, sourceResults, coinPairs) {
    const summary = { live: [], dead: [] };
    keys.forEach((key, index) => {
        const bucket = hasUsablePrice(sourceResults[index], coinPairs) ? summary.live : summary.dead;
        bucket.push(key);
    });
    return summary;
}

module.exports = { summarizeSourceLiveness };
