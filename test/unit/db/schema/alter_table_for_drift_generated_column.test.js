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

// A boot reconciles a live table's missing plain columns from src/sql but leaves a
// generated column to a dated migration: adding a STORED one rebuilds the table, which
// a boot must not start under the runtime statement limit.

const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const { expect } = require('chai');

const SQL_DIR = path.resolve(__dirname, '../../../../src/sql');

function databaseWithSource(source) {
    const Database = proxyquire('../../../../src/db', {
        mariadb: { createPool: sinon.stub().returns({}), createConnection: sinon.stub().resolves({}) },
        fs: { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns(source) },
        path
    });
    return new Database('localhost', 3306, 'test_db', 'user', 'pass');
}

// A connection whose information_schema read returns `live` and whose every other query is recorded.
function connectionHolding(live) {
    const ran = [];
    return {
        ran,
        query: async (sql) => {
            if (/information_schema/.test(sql)) return live;
            ran.push(String(sql));
            return [];
        }
    };
}

const liveRow = (name, nullable, type) => ({ COLUMN_NAME: name, IS_NULLABLE: nullable ? 'YES' : 'NO', COLUMN_TYPE: type || 'int' });

describe('alterTableForDrift and generated columns', function () {
    it('adds no ALTER to an aged price_snapshots that lacks archive_pending', async function () {
        const source = fs.readFileSync(path.join(SQL_DIR, 'price_snapshots.sql'), 'utf8');
        const db = databaseWithSource(source);
        const live = db.parseExpectedColumns(source).filter(c => c.name !== 'archive_pending')
            .map(c => liveRow(c.name, c.nullable));
        expect(live.length).to.be.greaterThan(20);
        const conn = connectionHolding(live);
        await db.alterTableForDrift('price_snapshots.sql', conn);
        expect(conn.ran).to.deep.equal([]);
    });

    it('declares archive_pending as a generated column the drift pass recognises', function () {
        const source = fs.readFileSync(path.join(SQL_DIR, 'price_snapshots.sql'), 'utf8');
        const cols = databaseWithSource(source).parseExpectedColumns(source);
        const hit = cols.find(c => c.name === 'archive_pending');
        expect(hit).to.be.an('object');
        expect(hit.definition.replace(/\s+/g, ' ')).to.equal(
            'archive_pending TINYINT(1) GENERATED ALWAYS AS (batch_seq IS NULL OR ' +
            'archived_status <> status OR archived_batch_block_time <> batch_block_time OR ' +
            'archived_proof_sha <> SHA2(consensus_proof, 256) OR ' +
            'NOT (archived_reference_block <=> reference_block) OR ' +
            'NOT (archived_source_action_index <=> source_action_index)) STORED'
        );
    });

    it('still adds a missing plain column beside a missing generated one', async function () {
        const source = 'CREATE TABLE t (id INT NOT NULL, extra VARCHAR(8) DEFAULT \'x\', '
            + 'gen TINYINT(1) GENERATED ALWAYS AS (id IS NULL) STORED);';
        const conn = connectionHolding([liveRow('id', false)]);
        await databaseWithSource(source).alterTableForDrift('t.sql', conn);
        expect(conn.ran).to.have.length(1);
        expect(conn.ran[0]).to.match(/ADD COLUMN extra VARCHAR\(8\)/);
    });

    it('never relaxes the nullability of a live generated column', async function () {
        const source = 'CREATE TABLE t (id INT NOT NULL, gen TINYINT(1) GENERATED ALWAYS AS (id IS NULL) STORED);';
        const conn = connectionHolding([liveRow('id', false), liveRow('gen', false, 'tinyint(1)')]);
        await databaseWithSource(source).alterTableForDrift('t.sql', conn);
        expect(conn.ran).to.deep.equal([]);
    });
});
