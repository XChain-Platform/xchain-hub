'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function nominalRoundSeconds(round, epochStartMs, roundIntervalMs) {
    if (!Number.isInteger(round) || round < 0 || !(roundIntervalMs > 0)) return null;

    // The scheduler already derives the round number from the epoch start and
    // interval, so this calculation gives every hub the same timestamp for a round.
    return Math.floor((epochStartMs + round * roundIntervalMs) / 1000);
}

function roundTimeMatches(wireTime, round, epochStartMs, roundIntervalMs) {
    return parseInt(wireTime) === nominalRoundSeconds(round, epochStartMs, roundIntervalMs);
}

module.exports = { nominalRoundSeconds, roundTimeMatches };
