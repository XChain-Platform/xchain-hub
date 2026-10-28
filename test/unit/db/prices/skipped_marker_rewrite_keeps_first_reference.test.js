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

// A skipped marker row that is written again must keep its first reference_block and
// block_timestamp. A live mirror drops a skipped-to-skipped change (only a finalized or
// disputed row replaces an existing one), so a hub that rewrote the columns in place
// diverged from every mirror that was streaming, while a freshly bootstrapped mirror
// copied the rewritten value. The hub upsert therefore must not assign either column
// from VALUES() on a duplicate key.

const assert = require('node:assert/strict');
const priceQueries = require('../../../../src/db/prices/index.js');

async function capture(){
    const calls = [];
    await priceQueries.setSkippedPriceSnapshotRound.call({
        async doQuery(sql, params){ calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return {}; }
    }, 136870, ['XCHAIN/USD'], 136870, 1700000002);
    assert.equal(calls.length, 1);
    return calls[0];
}

describe('setSkippedPriceSnapshotRound rewrite', () => {
    it('does not refresh reference_block or block_timestamp on a duplicate key', async () => {
        const { sql } = await capture();
        const update = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
        assert.ok(update.length > 0);
        assert.doesNotMatch(update, /reference_block\s*=/);
        assert.doesNotMatch(update, /block_timestamp\s*=/);
        assert.doesNotMatch(update, /VALUES\(/);
    });

    it('never demotes a finalized row', async () => {
        const { sql } = await capture();
        const update = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
        assert.doesNotMatch(update, /status\s*=\s*'skipped'\s*[,)]?\s*$/);
        assert.doesNotMatch(update, /price\s*=/);
    });
});
