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
 **********************************************************************
 *
 * Rules-digest checkpoint lookup contract.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const { findStateCheckpointsByRulesDigest } = require('../../../src/db/state_checkpoints');

describe('db/state_checkpoints.js rules-digest reader', function () {
    it('binds a lowercased digest and passes through the query result', async function () {
        const calls = [];
        const queryResult = [{ checkpoint_seq: 7 }];
        const db = {
            async doQuery(sql, params) {
                calls.push({ sql, params });
                return queryResult;
            },
        };
        const digest = 'AB'.repeat(32);

        const result = await findStateCheckpointsByRulesDigest.call(
            db, 'BTC', 'regtest', digest);

        expect(calls).to.deep.equal([{
            sql: 'SELECT checkpoint_seq, block_index, supersedes_from, rules_digest FROM state_checkpoints WHERE chain = ? AND network = ? AND rules_digest = ? ORDER BY checkpoint_seq ASC',
            params: ['BTC', 'regtest', digest.toLowerCase()],
        }]);
        expect(result).to.equal(queryResult);
    });

    it('rejects malformed digests without querying', async function () {
        const calls = [];
        const db = {
            async doQuery(sql, params) {
                calls.push({ sql, params });
            },
        };

        for (const digest of ['ab', 'zz'.repeat(32), null, 7]) {
            let error;
            try {
                await findStateCheckpointsByRulesDigest.call(db, 'BTC', 'regtest', digest);
            } catch (caught) {
                error = caught;
            }
            expect(error).to.be.instanceOf(TypeError);
        }
        expect(calls).to.deep.equal([]);
    });
});
