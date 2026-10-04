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

const sinon      = require('sinon');
const { expect } = require('chai');

const Database = require('../../../../src/db');

const CASES = [
    {
        table:  'bridge_transfers',
        getter: 'getBridgeTransfersMaxLiveId',
        finder: 'findBridgeTransfers'
    },
    {
        table:  'policy_snapshots',
        getter: 'getPolicySnapshotsMaxId',
        finder: 'findPolicySnapshots'
    },
    {
        table:  'list_snapshots',
        getter: 'getListSnapshotsMaxId',
        finder: 'findListSnapshots'
    }
];

function stubbedDb(rows) {
    const db = Object.create(Database.prototype);
    db.doQuery = sinon.stub().resolves(rows);
    return db;
}

function whereClause(sql, removeCursor) {
    const match = String(sql).match(/\bWHERE\s+([\s\S]*?)(?=\s+ORDER\s+BY\b|\s+LIMIT\b|$)/i);
    if(!match) return null;
    const terms = match[1].split(/\s+AND\s+/i)
        .map(term => term.trim().replace(/\s+/g, ' '))
        .filter(term => !removeCursor || !/^id\s*>\s*\?$/i.test(term));
    return terms.length ? terms.join(' AND ') : null;
}

describe('ready-frame maximum ids', function () {
    for(const testCase of CASES) {
        describe(testCase.getter + '()', function () {
            it('selects the maximum id from ' + testCase.table + ' and returns the query rows', async function () {
                const rows = [{ max_id: 73 }];
                const db = stubbedDb(rows);

                const result = await db[testCase.getter]();

                expect(result).to.equal(rows);
                expect(db.doQuery.calledOnce).to.equal(true);
                expect(db.doQuery.firstCall.args[0]).to.match(
                    new RegExp('^SELECT MAX\\(id\\) AS max_id FROM ' + testCase.table + '(?: WHERE .+)?$'));
            });

            it('uses the finder predicate after removing its cursor term', async function () {
                const db = stubbedDb([]);

                await db[testCase.getter]();
                await db[testCase.finder](11, 25);

                const getterSql = db.doQuery.firstCall.args[0];
                const finderSql = db.doQuery.secondCall.args[0];
                expect(whereClause(getterSql, false)).to.equal(whereClause(finderSql, true));
            });
        });
    }
});
