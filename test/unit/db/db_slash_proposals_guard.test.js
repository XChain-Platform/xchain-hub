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
 * src/db/slash_proposals.js builds findSlashProposalsFiltered's LIMIT clause
 * by string concatenation rather than a placeholder (MariaDB will not bind a
 * placeholder into a bare LIMIT the way it will into a WHERE value here), so
 * the integer check ahead of the concatenation is the only thing standing
 * between a caller and attacker text landing in the statement. The caller
 * already clamps the page size before calling; this drives the guard itself.
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const Database = require('../../../src/db');

// Async functions never throw synchronously: the guard runs before any
// `await`, so a hostile `limit` rejects the returned promise rather than
// throwing at the call site.
async function assertRejects(fn) {
    let threw = false;
    try {
        await fn();
    } catch (err) {
        threw = true;
        expect(err.message).to.match(/limit must be a positive integer/);
    }
    expect(threw, 'expected the call to reject').to.equal(true);
}

function recordingDb() {
    const db = Object.create(Database.prototype);
    db.calls = [];
    db.doQuery = async function (sql, params) {
        db.calls.push({ sql, params: params || [] });
        return [];
    };
    return db;
}

// Hostile inputs the guard must refuse before the LIMIT clause is ever built.
const HOSTILE_INPUTS = [0, -1, 1.5, '30) OR (1=1', '5 UNION SELECT 1', null, undefined, NaN];

describe('db/slash_proposals.js: findSlashProposalsFiltered limit guard', function () {
    it('accepts a positive integer and concatenates it into the LIMIT clause', async function () {
        const db = recordingDb();
        await db.findSlashProposalsFiltered(null, null, 10);
        expect(db.calls).to.have.length(1);
        expect(db.calls[0].sql).to.match(/LIMIT 10$/);
    });

    for (const bad of HOSTILE_INPUTS) {
        it('refuses ' + String(bad) + ' before any statement is built', async function () {
            const db = recordingDb();
            await assertRejects(() => db.findSlashProposalsFiltered(null, null, bad));
            expect(db.calls, 'doQuery must not have been reached').to.have.length(0);
        });
    }
});
