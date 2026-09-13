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

const { expect } = require('chai');
const { buildOraclePricesSnapshotQuery, MAX_SNAPSHOT_ROWS } =
    require('../../src/oraclePricesSnapshotQuery');
const { DB_METHODS } = require('../helpers/mockHub');

// The two statements now live in src/db/oracle.js and the builder names which one
// the route runs. sqlOf calls that named method against a doQuery stand-in and
// returns the SQL it issued, so the assertions below still read the real text.
function sqlOf(built) {
    let issued = null;
    DB_METHODS[built.method].apply({ doQuery: (sql) => { issued = sql; return Promise.resolve([]); } }, built.params);
    return issued;
}

describe('buildOraclePricesSnapshotQuery', function () {

    describe('default (page) mode - indexer bootstrap, must not change', function () {

        it('pages ascending by id from since_id', function () {
            const built = buildOraclePricesSnapshotQuery({ since: 500, limit: 1000 });
            const { params, mode } = built;
            const sql = sqlOf(built);
            expect(mode).to.equal('page');
            expect(sql).to.match(/WHERE id > \? ORDER BY id ASC LIMIT \?/);
            expect(sql).to.not.match(/GROUP BY/);
            expect(params).to.deep.equal([500, 1000]);
        });

        it('defaults since to 0 and limit to the cap when omitted', function () {
            const { params } = buildOraclePricesSnapshotQuery({});
            expect(params).to.deep.equal([0, MAX_SNAPSHOT_ROWS]);
        });

        it('clamps a negative / non-numeric since_id to 0 (no NaN bind)', function () {
            expect(buildOraclePricesSnapshotQuery({ since: -7 }).params[0]).to.equal(0);
            expect(buildOraclePricesSnapshotQuery({ since: 'abc' }).params[0]).to.equal(0);
        });

        it('clamps limit into [1, cap]', function () {
            expect(buildOraclePricesSnapshotQuery({ limit: 999999 }).params[1]).to.equal(MAX_SNAPSHOT_ROWS);
            expect(buildOraclePricesSnapshotQuery({ limit: 0 }).params[1]).to.equal(MAX_SNAPSHOT_ROWS);
            expect(buildOraclePricesSnapshotQuery({ limit: -5 }).params[1]).to.equal(MAX_SNAPSHOT_ROWS);
            expect(buildOraclePricesSnapshotQuery({ limit: 250 }).params[1]).to.equal(250);
        });
    });

    describe('latest mode - dashboard current-per-feed', function () {

        it('selects the MAX(effective_at) row per (source_address,coin,tick,fiat), not per id', function () {
            const built = buildOraclePricesSnapshotQuery({ latest: true, now: 1000 });
            const { params, mode } = built;
            const sql = sqlOf(built);
            expect(mode).to.equal('latest');
            expect(sql).to.match(/MAX\(effective_at\)/);
            // Feed identity includes the operator: grouping without
            // source_address returns only the freshest operator's row for a
            // (coin,tick,fiat) pair, hiding an abandoned operator's stale feed
            // while dispensers pinned to that ORACLE_ADDRESS keep settling.
            expect(sql).to.match(/GROUP BY source_address, coin, tick, fiat/);
            expect(sql).to.match(/ON op\.source_address = latest\.source_address/);
            // latest is defined by effective_at, so it must NOT reduce to a plain
            // max-id / since_id page (a future-dated UPDATE has a lower id but a
            // higher effective_at).
            expect(sql).to.not.match(/WHERE id > \?/);
            expect(sql).to.not.match(/MAX\(id\)/);
            expect(params).to.deep.equal([1000, MAX_SNAPSHOT_ROWS]);
        });

        it('gates the MAX(effective_at) subquery to now, hiding future-dated rows', function () {
            const sql = sqlOf(buildOraclePricesSnapshotQuery({ latest: true, now: 1000 }));
            expect(sql).to.match(/WHERE effective_at <= \? GROUP BY source_address, coin, tick, fiat/);
        });

        it('ignores since_id in latest mode (no page cursor bound)', function () {
            const built = buildOraclePricesSnapshotQuery({ latest: true, since: 12345, now: 1000 });
            const { params } = built;
            const sql = sqlOf(built);
            expect(params).to.deep.equal([1000, MAX_SNAPSHOT_ROWS]);
            expect(sql).to.not.contain('12345');
        });

        it('still honours an explicit row cap', function () {
            const { params } = buildOraclePricesSnapshotQuery({ latest: true, now: 1000, limit: 200 });
            expect(params).to.deep.equal([1000, 200]);
        });

        it('defaults now to the current time when omitted', function () {
            const before = Math.floor(Date.now() / 1000);
            const { params } = buildOraclePricesSnapshotQuery({ latest: true });
            const after = Math.floor(Date.now() / 1000);
            expect(params[0]).to.be.at.least(before).and.at.most(after);
        });
    });
});
