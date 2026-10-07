'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Remembers peer rows catch-up refused for a lasting local reason, so a re-walk neither
// re-verifies nor re-logs them. The key covers the row's content, so a row the peer
// later changes in place (a round it finalizes) is verified again.

const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 500000;

function contentHash(row) {
    const columns = Object.keys(row || {}).filter(column => column !== 'id').sort();
    const body = JSON.stringify(columns.map(column => [column, row[column]]));
    return crypto.createHash('sha256').update(body).digest('hex');
}

function createRefusalMemo({ maxEntries } = {}) {
    const limit = Number(maxEntries) > 0 ? Number(maxEntries) : DEFAULT_MAX_ENTRIES;
    // A Set iterates in insertion order, so its first entry is always the oldest.
    const keys = new Set();

    function keyFor(peerIdentity, table, row) {
        const parts = [String(peerIdentity), String(table), Number(row && row.id), contentHash(row)];
        return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64');
    }

    function has(key) {
        return keys.has(key);
    }

    function remember(key) {
        keys.delete(key);
        keys.add(key);
        while (keys.size > limit) keys.delete(keys.values().next().value);
    }

    return { keyFor, has, remember, size: () => keys.size };
}

module.exports = { createRefusalMemo, DEFAULT_MAX_ENTRIES };
