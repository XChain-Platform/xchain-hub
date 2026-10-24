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

// The finalized per-pair round index on price_snapshots: the dated migration an aged hub
// applies, the key src/sql declares for a fresh hub, and the access path the last-finalized
// read gets from it. The access path is worked out the way EXPLAIN reports it for a
// single-table read: the longest run of leading index columns the WHERE pins by equality,
// then whether the next index column carries the range and the ORDER BY, which is what lets
// MariaDB read one index entry for ORDER BY ... DESC LIMIT 1 instead of filesorting.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const Database = require('../../../../src/db');
const { declaredIndex, freshSchemaRows } = require('../../../helpers/fresh_schema_model.js');
const { keyColumns, planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');

const FILE = '2026-10-24-price-snapshots-status-pair-round-index.sql';
const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations', FILE);
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const ADD = /^ALTER TABLE `([^`]+)` ADD INDEX IF NOT EXISTS `([^`]+)` \((.+)\);$/;

// Every price_snapshots index src/sql declares, as { name, columns } in key order.
function priceSnapshotIndexes() {
    const byName = new Map();
    for (const row of freshSchemaRows().indexes.filter(r => r.t === 'price_snapshots')) {
        if (!byName.has(row.i)) byName.set(row.i, []);
        byName.get(row.i).push(row.c.toLowerCase());
    }
    return [...byName].map(([name, columns]) => ({ name, columns }));
}

// The predicate shape of a single-table SELECT: equality columns, range columns, ORDER BY column.
function predicateShape(text) {
    const flat = text.replace(/\s+/g, ' ');
    const where = flat.match(/ WHERE (.+?)(?: ORDER BY | LIMIT |$)/)[1];
    const order = (flat.match(/ ORDER BY (\w+)/) || [])[1] || null;
    const eq = new Set(), range = new Set();
    for (const term of where.split(/ AND /)) {
        let m;
        if ((m = term.match(/^(\w+) = (?:\?|'[^']*')$/))) eq.add(m[1]);
        else if ((m = term.match(/^(\w+) (?:<|<=|>|>=) \?$/))) range.add(m[1]);
    }
    return { eq, range, order };
}

// What EXPLAIN would show for one index: the key parts it uses and whether the ORDER BY
// is read off the index (no filesort).
function accessPath(index, shape) {
    let used = 0;
    while (used < index.columns.length && shape.eq.has(index.columns[used])) used++;
    const next = index.columns[used];
    const rangeOnNext = next !== undefined && shape.range.has(next);
    return {
        key: index.name,
        keyParts: used + (rangeOnNext ? 1 : 0),
        allEqualitiesUsed: used === shape.eq.size,
        orderFromIndex: shape.order !== null && (next === shape.order || index.columns.slice(0, used).includes(shape.order)),
    };
}

// The index the optimizer picks: every equality used, then the most key parts, then no filesort.
function chosenKey(indexes, shape) {
    const paths = indexes.map(index => accessPath(index, shape))
        .filter(p => p.keyParts > 0)
        .sort((a, b) => (b.allEqualitiesUsed - a.allEqualitiesUsed) || (b.keyParts - a.keyParts) ||
            (b.orderFromIndex - a.orderFromIndex));
    return paths[0] || null;
}

async function capturedSql(method, args) {
    let seen = null;
    await Database.prototype[method].apply({ doQuery: async (text) => { seen = text; return []; } }, args);
    return seen;
}

function registerMigrationTests() {
    it('is manual and adds only the status, coin_pair, round_number index', function () {
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(lines).to.have.length(1);
        const add = lines[0].match(ADD);
        expect(add, 'valid plain-index ALTER: ' + lines[0]).not.to.equal(null);
        expect([add[1], add[2]]).to.deep.equal(['price_snapshots', 'idx_status_pair_round']);
        expect(keyColumns(add[3])).to.deep.equal(['status', 'coin_pair', 'round_number']);
    });

    it('adds the index exactly as src/sql declares it', function () {
        const add = lines[0].match(ADD);
        expect(declaredIndex(add[1], add[2])).to.deep.equal({ columns: keyColumns(add[3]), unique: false });
    });

    it('is baselined on a fresh hub and pending on a hub without the index', function () {
        const plan = planEndState(lines.map(line => line.replace(/;$/, '')));
        const fresh = freshSchemaRows();
        expect(unmetEndState(plan, schemaModel(fresh.columns, fresh.indexes))).to.deep.equal([]);
        const aged = fresh.indexes.filter(r => !(r.t === 'price_snapshots' && r.i === 'idx_status_pair_round'));
        expect(unmetEndState(plan, schemaModel(fresh.columns, aged)))
            .to.deep.equal(['price_snapshots index idx_status_pair_round is absent']);
    });
}

function registerAccessPathTests() {
    it('serves the last-finalized read with every key part and no filesort', async function () {
        const shape = predicateShape(await capturedSql('getLatestFinalizedPriceBelowRound', ['BTC/USD', 100]));
        expect([...shape.eq].sort()).to.deep.equal(['coin_pair', 'status']);
        expect([...shape.range]).to.deep.equal(['round_number']);
        expect(shape.order).to.equal('round_number');
        expect(chosenKey(priceSnapshotIndexes(), shape)).to.deep.equal({
            key: 'idx_status_pair_round', keyParts: 3, allEqualitiesUsed: true, orderFromIndex: true,
        });
    });

    it('serves the newest finalized row of a pair the same way', async function () {
        const shape = predicateShape(await capturedSql('getFinalizedPriceSnapshotByCoinPair', ['BTC/USD']));
        const chosen = chosenKey(priceSnapshotIndexes(), shape);
        expect(chosen.key).to.equal('idx_status_pair_round');
        expect(chosen.orderFromIndex).to.equal(true);
    });

    it('had no index pinning both status and coin_pair before this one', async function () {
        const shape = predicateShape(await capturedSql('getLatestFinalizedPriceBelowRound', ['BTC/USD', 100]));
        const others = priceSnapshotIndexes().filter(index => index.name !== 'idx_status_pair_round');
        expect(others.length).to.be.at.least(5);
        for (const index of others)
            expect(accessPath(index, shape).allEqualitiesUsed, index.name).to.equal(false);
    });
}

describe('price_snapshots status, pair and round index SQL migration', function () {
    registerMigrationTests();
    registerAccessPathTests();
});
