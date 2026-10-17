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
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const { updateStateCheckpointClearStamp } = require('../../../src/db/state_checkpoints');

describe('db/state_checkpoints.js guarded anchor stamp clear', function () {
    it('clears only the matching stamp and passes through the query result', async function () {
        const calls = [];
        const queryResult = { affectedRows: 1 };
        const db = {
            async doQuery(sql, params) {
                calls.push({ sql, params });
                return queryResult;
            },
        };
        const txid = 'ab'.repeat(32);

        const result = await updateStateCheckpointClearStamp.call(
            db, txid, 'BTC', 'regtest', 101, 7);

        expect(calls).to.deep.equal([{
            sql: 'UPDATE state_checkpoints SET anchor_txid = NULL WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid = ?',
            params: ['BTC', 'regtest', 101, 7, txid],
        }]);
        expect(result).to.equal(queryResult);
    });
});
