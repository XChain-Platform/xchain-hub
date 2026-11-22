'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

function parseWholeInteger(value) {
    if (typeof value === 'number')
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

module.exports = parseWholeInteger;
