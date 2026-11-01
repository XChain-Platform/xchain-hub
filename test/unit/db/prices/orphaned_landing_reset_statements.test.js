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

// The orphaned PRICE batch landing reset (rounds this hub finalized itself that a retracted
// batch landing stamped) as statements: a source-chain range read for the retracted batch
// windows, then literal round_number bounds for the self-finalized rows. The old form joined
// price_snapshots to itself ON a round range computed per row from JSON, which no index can
// serve, so on a table of a few hundred thousand rows it read the table squared and every
// retraction retry hit the server statement limit.

const { expect } = require('chai');
const Database = require('../../../../src/db');
const { freshSchemaRows } = require('../../../helpers/fresh_schema_model.js');

const BATCH = (first, last) => JSON.stringify({ batch: { first_round: first, last_round: last } });
const SELF = '[{"sig":"x"}]';

function fixture() {
    return [
        // Retracted batch rows on DOGE: action 40..50, generation 7 or below.
        { round_number: 100, source_chain: 'DOGE', source_action_index: 41, push_generation: 7, batch_block_time: 5000, consensus_proof: BATCH(100, 105) },
        { round_number: 103, source_chain: 'DOGE', source_action_index: 41, push_generation: 7, batch_block_time: 5000, consensus_proof: BATCH(100, 105) },
        { round_number: 200, source_chain: 'DOGE', source_action_index: 44, push_generation: 6, batch_block_time: 0, consensus_proof: BATCH(200, 205) },
        // Batch rows the retraction does not name: another chain, later action, newer generation.
        { round_number: 300, source_chain: 'BTC', source_action_index: 42, push_generation: 7, batch_block_time: 6000, consensus_proof: BATCH(300, 305) },
        { round_number: 400, source_chain: 'DOGE', source_action_index: 60, push_generation: 7, batch_block_time: 7000, consensus_proof: BATCH(400, 405) },
        { round_number: 500, source_chain: 'DOGE', source_action_index: 45, push_generation: 9, batch_block_time: 8000, consensus_proof: BATCH(500, 505) },
        // Self-finalized rows.
        { round_number: 101, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 5000, consensus_proof: SELF },
        { round_number: 104, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 5000, consensus_proof: SELF },
        { round_number: 102, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 4999, consensus_proof: SELF },
        { round_number: 106, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 5000, consensus_proof: SELF },
        { round_number: 201, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 0, consensus_proof: SELF },
        { round_number: 301, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 6000, consensus_proof: SELF },
        { round_number: 401, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 7000, consensus_proof: SELF },
        { round_number: 501, source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 8000, consensus_proof: SELF }
    ];
}

const isBatch = row => row.consensus_proof.startsWith('{"batch":');

// Answers the two statement shapes this path issues against fixture rows, binding only the
// placeholders the SQL text carries, and records each statement for the shape assertions.
function fakeDb(rows) {
    const seen = [];
    return { seen, rows, async doQuery(sql, args) {
        seen.push([sql, args]);
        if (/JOIN/i.test(sql)) throw new Error('self-join issued: ' + sql);
        if (sql.startsWith('SELECT DISTINCT batch_block_time')) {
            const bounded = sql.includes('source_action_index <= ?');
            const fenced = sql.includes('push_generation <= ?');
            const [chain, from] = args;
            const to = bounded ? args[2] : Infinity;
            const gen = fenced ? args[bounded ? 3 : 2] : Infinity;
            return rows.filter(r => isBatch(r) && r.source_chain === chain && r.source_action_index >= from &&
                r.source_action_index <= to && r.push_generation <= gen && r.batch_block_time > 0)
                .map(r => { const b = JSON.parse(r.consensus_proof).batch;
                    return { batch_block_time: r.batch_block_time, first_round: b.first_round, last_round: b.last_round }; });
        }
        const windows = [];
        for (let i = 0; i < args.length; i += 3) windows.push(args.slice(i, i + 3));
        const hit = rows.filter(r => r.source_action_index === null && !isBatch(r) &&
            windows.some(([first, last, t]) => r.round_number >= first && r.round_number <= last && r.batch_block_time === t));
        if (sql.startsWith('UPDATE')) { for (const r of hit) r.batch_block_time = 0; return { affectedRows: hit.length }; }
        return hit.map(r => ({ round_number: r.round_number }));
    } };
}

function indexColumns(name) {
    return freshSchemaRows().indexes.filter(r => r.t === 'price_snapshots' && r.i === name).map(r => r.c.toLowerCase());
}

describe('orphaned PRICE batch landing reset statements', function () {
    it('returns only self-finalized rounds inside a retracted window that carry its clock', async function () {
        const db = fakeDb(fixture());
        const rows = await Database.prototype.findSelfFinalizedRoundsForBatchRetraction.call(db, 'DOGE', 40, 50, 7, true, true);
        expect(rows.map(r => r.round_number).sort()).to.deep.equal([101, 104]);
    });

    it('resets exactly those rows and leaves every other clock untouched', async function () {
        const db = fakeDb(fixture());
        const before = new Map(db.rows.map(r => [r.round_number, r.batch_block_time]));
        const result = await Database.prototype.resetSelfFinalizedBatchBlockTimeForRetraction.call(db, 'DOGE', 40, 50, 7, true, true);
        expect(result.affectedRows).to.equal(2);
        for (const r of db.rows) {
            const expected = [101, 104].includes(r.round_number) ? 0 : before.get(r.round_number);
            expect(r.batch_block_time, 'round ' + r.round_number).to.equal(expected);
        }
    });

    it('widens to an open-ended unfenced retraction without crossing source chains', async function () {
        const db = fakeDb(fixture());
        const rows = await Database.prototype.findSelfFinalizedRoundsForBatchRetraction.call(db, 'DOGE', 40, 50, 7, false, false);
        expect(rows.map(r => r.round_number).sort()).to.deep.equal([101, 104, 401, 501]);
        expect(db.seen[0][1]).to.deep.equal(['DOGE', 40]);
    });
});

describe('orphaned PRICE batch landing reset statement shape', function () {
    it('issues no self-join and no JSON outside the landing read select list', async function () {
        const db = fakeDb(fixture());
        await Database.prototype.findSelfFinalizedRoundsForBatchRetraction.call(db, 'DOGE', 40, 50, 7, true, true);
        await Database.prototype.resetSelfFinalizedBatchBlockTimeForRetraction.call(db, 'DOGE', 40, 50, 7, true, true);
        for (const [sql] of db.seen) {
            expect(sql).not.to.match(/JOIN|price_snapshots AS /i);
            const where = sql.slice(sql.indexOf(' WHERE '));
            expect(where, sql).not.to.match(/JSON_/);
        }
        // Windows are literal parameters: duplicates collapse and a zero clock is never a window.
        expect(db.seen[1][1]).to.deep.equal([100, 105, 5000]);
    });

    it('pins the landing read to the source-chain action index and the window read to round_number', async function () {
        const db = fakeDb(fixture());
        await Database.prototype.findSelfFinalizedRoundsForBatchRetraction.call(db, 'DOGE', 40, 50, 7, true, true);
        const landingWhere = db.seen[0][0].split(' WHERE ')[1];
        const lead = indexColumns('idx_source_chain_action');
        expect(lead.slice(0, 2)).to.deep.equal(['source_chain', 'source_action_index']);
        expect(landingWhere).to.match(/^source_chain = \? AND source_action_index >= \?/);
        expect(indexColumns('idx_round_pair')[0]).to.equal('round_number');
        expect(db.seen[1][0]).to.include('(round_number BETWEEN ? AND ? AND batch_block_time = ?)');
    });

    it('bounds each statement and skips malformed windows', async function () {
        const windows = [];
        for (let i = 0; i < 501; i++) windows.push({ batch_block_time: 9000 + i, first_round: 10 * i, last_round: 10 * i + 5 });
        windows.push({ batch_block_time: 1, first_round: null, last_round: 4 }, { batch_block_time: 1, first_round: 9, last_round: 3 });
        const seen = [];
        const db = { async doQuery(sql, args) { seen.push([sql, args]); return seen.length === 1 ? windows : { affectedRows: 0 }; } };
        await Database.prototype.resetSelfFinalizedBatchBlockTimeForRetraction.call(db, 'DOGE', 0, 9, 1, true, true);
        expect(seen).to.have.length(3);
        expect(seen[1][1]).to.have.length(500 * 3);
        expect(seen[2][1]).to.deep.equal([5000, 5005, 9500]);
    });

    it('issues nothing past the landing read when the retraction names no stamped batch', async function () {
        const seen = [];
        const db = { async doQuery(sql, args) { seen.push([sql, args]); return []; } };
        expect(await Database.prototype.findSelfFinalizedRoundsForBatchRetraction.call(db, 'DOGE', 1, 2, 3, true, true)).to.deep.equal([]);
        expect(await Database.prototype.resetSelfFinalizedBatchBlockTimeForRetraction.call(db, 'DOGE', 1, 2, 3, true, true)).to.deep.equal({ affectedRows: 0 });
        expect(seen).to.have.length(2);
    });
});
