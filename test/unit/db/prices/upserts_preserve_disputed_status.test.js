'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('node:assert/strict');
const priceQueries = require('../../../../src/db/prices/index.js');

const ADMIT = { admit_block_btc: 11, admit_block_ltc: 12, admit_block_doge: 13 };

async function capture(method) {
    const calls = [];
    const db = { async doQuery(sql, params) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return {};
    } };
    const common = [7, [{ pair: 'BTC/USD', coinPair: 'BTC/USD', price: '50000' }], 101];
    if (method === 'setFinalizedPriceSnapshotRound') {
        await priceQueries[method].call(db, ...common, 1700000000, 3, '[]', ADMIT);
    } else if (method === 'setPushedPriceSnapshotRound') {
        await priceQueries[method].call(db, ...common, 'DOGE', 1700000000, 3, '[]', 4, 5,
            new Date('2026-01-01T00:00:00Z'), ADMIT);
    } else {
        await priceQueries[method].call(db, ...common, 'DOGE', 1700000000, 3, '{"batch":{}}', 4, 5,
            1700000100, new Date('2026-01-01T00:00:00Z'), ADMIT);
    }
    assert.equal(calls.length, 1);
    return calls[0].sql;
}

function parts(sql) {
    const marker = 'ON DUPLICATE KEY UPDATE';
    const at = sql.indexOf(marker);
    assert.notEqual(at, -1);
    return { insert: sql.slice(0, at), update: sql.slice(at) };
}

describe('finalized price snapshot upserts', () => {
    for (const method of [
        'setFinalizedPriceSnapshotRound',
        'setPushedPriceSnapshotRound',
        'setBatchPriceSnapshotRound',
    ]) {
        it(method + ' inserts finalized but cannot revive a concurrent dispute', async () => {
            const { insert, update } = parts(await capture(method));
            assert.match(insert, /'finalized'/);
            assert.match(update, /status\s*=\s*IF\(status\s*=\s*'disputed',\s*status,\s*'finalized'\)/);
            assert.doesNotMatch(update, /status\s*=\s*'finalized'/);
        });
    }

    it('keeps canonical landing metadata mutable while the disputed status stays fixed', async () => {
        for (const method of ['setPushedPriceSnapshotRound', 'setBatchPriceSnapshotRound']) {
            const { update } = parts(await capture(method));
            assert.match(update, /reference_block\s*=\s*VALUES\(reference_block\)/);
            assert.match(update, /source_action_index\s*=\s*VALUES\(source_action_index\)/);
            assert.match(update, /push_generation\s*=\s*VALUES\(push_generation\)/);
        }
    });

    it('only upgrades skipped rows when finalizing a round', async () => {
        const { update } = parts(await capture('setFinalizedPriceSnapshotRound'));
        const guarded = ['price', 'reference_block', 'block_timestamp', 'validator_count',
            'consensus_proof', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'];
        for (const column of guarded) {
            const pattern = new RegExp(column + "\\s*=\\s*IF\\(status\\s*=\\s*'skipped',\\s*VALUES\\(" +
                column + '\\),\\s*' + column + '\\)');
            assert.match(update, pattern, column);
        }
        assert.doesNotMatch(update, /\b(reference_chain|source_chain|source_action_index|push_generation|batch_block_time)\s*=/);
        assert.match(update, /status\s*=\s*IF\(status\s*=\s*'disputed',\s*status,\s*'finalized'\)\s*$/);
    });
});
