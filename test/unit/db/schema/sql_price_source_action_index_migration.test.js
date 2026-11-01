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

// The (source_chain, source_action_index, push_generation) index on price_snapshots: the
// dated migration an aged hub applies, the key src/sql declares for a fresh hub, and the
// access path the batch-retraction reads get from it. Without it those reads (rounds of a
// retracted PRICE batch, orphaned landing stamps) scan the wide table, hit the server
// statement limit and fail the retraction closed on every retry.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const Database = require('../../../../src/db');
const { declaredIndex, freshSchemaRows } = require('../../../helpers/fresh_schema_model.js');
const { keyColumns, planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');

const FILE = '2026-10-28-price-snapshots-source-chain-action-index.sql';
const NAME = 'idx_source_chain_action';
const COLUMNS = ['source_chain', 'source_action_index', 'push_generation'];
const sql = fs.readFileSync(path.resolve(__dirname, '../../../../src/sql/migrations', FILE), 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const ADD = /^ALTER TABLE `([^`]+)` ADD INDEX IF NOT EXISTS `([^`]+)` \((.+)\);$/;

function priceSnapshotIndexes() {
    const byName = new Map();
    for (const row of freshSchemaRows().indexes.filter(r => r.t === 'price_snapshots')) {
        if (!byName.has(row.i)) byName.set(row.i, []);
        byName.get(row.i).push(row.c.toLowerCase());
    }
    return [...byName].map(([name, columns]) => ({ name, columns }));
}

// Equality and range columns of a WHERE, restricted to the unaliased price_snapshots columns.
function predicateShape(where) {
    const eq = new Set(), range = new Set();
    for (const term of where.replace(/\s+/g, ' ').split(/ AND /)) {
        let m;
        if ((m = term.match(/^(?:\w+\.)?(\w+) = \?$/))) eq.add(m[1]);
        else if ((m = term.match(/^(?:\w+\.)?(\w+) (?:<|<=|>|>=) \?$/))) range.add(m[1]);
    }
    return { eq, range };
}

// Key parts EXPLAIN would use: leading equality columns, plus one range column.
function keyParts(index, shape) {
    let used = 0;
    while (used < index.columns.length && shape.eq.has(index.columns[used])) used++;
    return used + (used < index.columns.length && shape.range.has(index.columns[used]) ? 1 : 0);
}

async function capturedSql(method, args) {
    let seen = null;
    await Database.prototype[method].apply({ doQuery: async (text) => { seen = text; return []; } }, args);
    return seen;
}

describe('price_snapshots source chain and action index SQL migration', function () {
    it('is manual and adds only the source_chain, source_action_index, push_generation index', function () {
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(lines).to.have.length(1);
        const add = lines[0].match(ADD);
        expect(add, 'valid plain-index ALTER: ' + lines[0]).not.to.equal(null);
        expect([add[1], add[2]]).to.deep.equal(['price_snapshots', NAME]);
        expect(keyColumns(add[3])).to.deep.equal(COLUMNS);
    });

    it('adds the index exactly as src/sql declares it', function () {
        const add = lines[0].match(ADD);
        expect(declaredIndex(add[1], add[2])).to.deep.equal({ columns: COLUMNS, unique: false });
    });

    it('is baselined on a fresh hub and pending on a hub without the index', function () {
        const plan = planEndState(lines.map(line => line.replace(/;$/, '')));
        const fresh = freshSchemaRows();
        expect(unmetEndState(plan, schemaModel(fresh.columns, fresh.indexes))).to.deep.equal([]);
        const aged = fresh.indexes.filter(r => !(r.t === 'price_snapshots' && r.i === NAME));
        expect(unmetEndState(plan, schemaModel(fresh.columns, aged)))
            .to.deep.equal(['price_snapshots index ' + NAME + ' is absent']);
    });

    it('serves the retraction round lookup through source_chain and the action range', async function () {
        for (const [bounded, fenced] of [[true, true], [false, false], [true, false]]) {
            const text = await capturedSql('findBatchPriceSnapshotRoundsForRetraction', ['DOGE', 1, 9, 5, bounded, fenced]);
            const shape = predicateShape(text.match(/ WHERE (.+?) AND consensus_proof LIKE/)[1]);
            const best = Math.max(...priceSnapshotIndexes().map(i => keyParts(i, shape)));
            const idx = priceSnapshotIndexes().find(i => i.name === NAME);
            expect(keyParts(idx, shape), 'key parts of ' + NAME).to.be.at.least(2);
            expect(best).to.equal(keyParts(idx, shape));
        }
    });

    it('had no index leading on both source_chain and source_action_index before this one', function () {
        const others = priceSnapshotIndexes().filter(i => i.name !== NAME);
        for (const index of others)
            expect(index.columns.slice(0, 2), index.name).not.to.deep.equal(['source_chain', 'source_action_index']);
    });
});
