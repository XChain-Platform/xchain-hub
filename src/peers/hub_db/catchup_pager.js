'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { MIRRORED_TABLES } = require('./catchup_verifiers.js');

const mirroredTableSet = new Set(MIRRORED_TABLES);

function createSnapshotFetcher({ apiUrl, feedKey, fetchImpl = globalThis.fetch }) {
    const baseUrl = String(apiUrl).replace(/\/+$/, '');

    return async function fetchPage({ table, sinceId, limit }) {
        const url = baseUrl + '/hub-db/snapshot/' + encodeURIComponent(table)
            + '?since_id=' + encodeURIComponent(sinceId)
            + '&limit=' + encodeURIComponent(limit);
        const headers = {};
        if (feedKey) headers['x-api-key'] = feedKey;

        const response = await fetchImpl(url, { method: 'GET', headers });
        if (!response.ok) {
            throw new Error('Snapshot request failed with status ' + response.status);
        }
        return response.json();
    };
}

function integerId(value) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
    return null;
}

function pageSnapshotTable({ table, fetchPage, onRow, limit = 1000 }) {
    if (!mirroredTableSet.has(table)) {
        throw new Error('Unknown mirrored table: ' + table);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        throw new RangeError('Snapshot page limit must be an integer from 1 to 10000');
    }

    return page();

    async function page() {
        let rows = 0;
        let lastId = 0;

        while (true) {
            try {
                const body = await fetchPage({ table, sinceId: lastId, limit });
                if (!body || body.table !== table || !Array.isArray(body.rows)) {
                    throw new Error('Invalid snapshot response for table ' + table);
                }

                for (const row of body.rows) {
                    const id = row && integerId(row.id);
                    const cursor = integerId(lastId);
                    if (id === null || cursor === null || id <= cursor) {
                        throw new Error('Snapshot row id did not advance the cursor');
                    }
                    await onRow(row);
                    lastId = row.id;
                    rows++;
                }

                if (body.rows.length < limit) {
                    return { complete: true, rows, lastId };
                }
            } catch (error) {
                return { complete: false, rows, lastId, error };
            }
        }
    }
}

module.exports = { createSnapshotFetcher, pageSnapshotTable };
