'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('node:assert/strict');
const priceQueries = require('../../../../src/db/prices/index.js');

function compareRows(left, right, pairDirection) {
    if (left.round_number !== right.round_number) return right.round_number - left.round_number;
    return pairDirection * left.coin_pair.localeCompare(right.coin_pair);
}

function originalPage(rows, finalizedOnly, limit) {
    return rows.filter(row => !finalizedOnly || row.status === 'finalized')
        .sort((left, right) => compareRows(left, right, 1)).slice(0, limit);
}

function fakeDatabase(rows) {
    const calls = [];
    return {
        calls,
        async doQuery(sql, params) {
            calls.push({ sql, params });
            const finalizedOnly = /status = 'finalized'/.test(sql);
            let matches = rows.filter(row => !finalizedOnly || row.status === 'finalized');

            if (/^SELECT round_number FROM price_snapshots/.test(sql)) {
                matches.sort((left, right) => compareRows(left, right, -1));
                const row = matches[params[0]];
                return row ? [{ round_number: row.round_number }] : [];
            }

            assert.match(sql, /^SELECT \* FROM price_snapshots/);
            const hasRoundBound = /round_number >= \?/.test(sql);
            const roundBound = hasRoundBound ? params[0] : null;
            const limit = params[hasRoundBound ? 1 : 0];
            if (hasRoundBound) matches = matches.filter(row => row.round_number >= roundBound);
            return matches.sort((left, right) => compareRows(left, right, 1)).slice(0, limit);
        }
    };
}

async function readPage(rows, finalizedOnly, limit) {
    const db = fakeDatabase(rows.map(row => ({ ...row })));
    const method = finalizedOnly ? priceQueries.findPriceSnapshotsFinalized
        : priceQueries.findPriceSnapshotsAnyStatus;
    const result = await method.call(db, limit);
    return { calls: db.calls, result };
}

function row(round, pair, status = 'finalized') {
    return { round_number: round, coin_pair: pair, status, price: `${round}.${pair.length}` };
}

function generatedTable(seed) {
    let state = seed;
    const random = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
    const pairs = ['BTC/USD', 'DOGE/USD', 'ETH/USD', 'LTC/USD', 'XMR/USD'];
    const statuses = ['finalized', 'skipped', 'disputed'];
    const rows = [];
    const rounds = Math.floor(random() * 25);
    for (let roundNumber = 1; roundNumber <= rounds; roundNumber++) {
        for (const pair of pairs) {
            if (random() < 0.72) {
                rows.push(row(roundNumber, pair, statuses[Math.floor(random() * statuses.length)]));
            }
        }
    }
    return rows;
}

// Empty, fewer than the limit, exactly the limit, a boundary round split by the limit,
// and the finalized filter mixed with other statuses.
function boundaryCases() {
    return [
        { rows: [], limit: 5 },
        { rows: [row(3, 'BTC/USD')], limit: 5 },
        { rows: [row(3, 'BTC/USD'), row(3, 'DOGE/USD')], limit: 2 },
        {
            rows: [row(9, 'BTC/USD'), row(8, 'BTC/USD'), row(8, 'DOGE/USD'),
                row(8, 'ETH/USD'), row(7, 'BTC/USD')],
            limit: 3
        },
        {
            rows: [row(9, 'BTC/USD', 'skipped'), row(8, 'BTC/USD'),
                row(8, 'DOGE/USD', 'disputed'), row(7, 'BTC/USD')],
            limit: 2
        }
    ];
}

describe('price_snapshots newest page range bound', () => {
    for (const finalizedOnly of [false, true]) {
        const variant = finalizedOnly ? 'finalized rows' : 'rows in any status';

        it(`matches original ordering and limits for ${variant} across randomized tables`, async () => {
            for (let seed = 1; seed <= 100; seed++) {
                const rows = generatedTable(seed);
                const limit = 1 + (seed % 17);
                const { result } = await readPage(rows, finalizedOnly, limit);
                assert.deepEqual(result, originalPage(rows, finalizedOnly, limit), `seed ${seed}`);
            }
        });

        it(`matches original semantics for ${variant} at page boundary cases`, async () => {
            for (const item of boundaryCases()) {
                const { result } = await readPage(item.rows, finalizedOnly, item.limit);
                assert.deepEqual(result, originalPage(item.rows, finalizedOnly, item.limit));
            }
        });

        it(`uses two statements for ${variant} independent of table size`, async () => {
            for (const size of [4, 4000]) {
                const rows = Array.from({ length: size }, (_, index) =>
                    row(Math.floor(index / 4), `PAIR${String(index % 4).padStart(2, '0')}`));
                const { calls } = await readPage(rows, finalizedOnly, 3);
                assert.equal(calls.length, 2, `table size ${size}`);
            }
        });

        it(`uses an index-ordered boundary and a literal range for ${variant}`, async () => {
            const rows = [row(9, 'BTC/USD'), row(8, 'BTC/USD'), row(8, 'DOGE/USD')];
            const { calls } = await readPage(rows, finalizedOnly, 2);
            const status = finalizedOnly ? " WHERE status = 'finalized'" : '';
            const pageWhere = finalizedOnly ? "status = 'finalized' AND round_number >= ?"
                : 'round_number >= ?';
            assert.equal(calls[0].sql,
                `SELECT round_number FROM price_snapshots${status} ` +
                'ORDER BY round_number DESC, coin_pair DESC LIMIT 1 OFFSET ?');
            assert.deepEqual(calls[0].params, [1]);
            assert.equal(calls[1].sql,
                `SELECT * FROM price_snapshots WHERE ${pageWhere} ` +
                'ORDER BY round_number DESC, coin_pair ASC LIMIT ?');
            assert.deepEqual(calls[1].params, [8, 2]);
        });
    }
});
