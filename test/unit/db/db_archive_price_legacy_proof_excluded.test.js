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
const archiveBookkeeping = require('../../../src/db/prices/archive_bookkeeping.js');

function stubbedDb() {
    return Object.assign({ doQuery: sinon.stub().resolves([]) }, archiveBookkeeping);
}

function lastCall(db) {
    const call = db.doQuery.lastCall;
    return { sql: call.args[0], args: call.args[1] };
}

describe('archive price selectors exclude legacy proofs', function () {
    it('excludes them while selecting pending rounds without changing bindings', async function () {
        const db = stubbedDb();
        await db.findPriceSnapshotRoundsByBatchSeq(288);
        const { sql, args } = lastCall(db);
        expect(sql).to.include('consensus_proof NOT LIKE \'["%\'');
        expect(args).to.deep.equal([288]);
    });

    it('excludes them while loading selected rounds without changing bindings', async function () {
        const db = stubbedDb();
        await db.findPriceSnapshotsForArchiveRounds([4, 5, 9]);
        const { sql, args } = lastCall(db);
        expect(sql).to.include('consensus_proof NOT LIKE \'["%\'');
        expect(args).to.deep.equal([4, 5, 9]);
    });
});
