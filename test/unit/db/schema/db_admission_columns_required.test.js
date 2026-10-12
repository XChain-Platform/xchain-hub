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

// The mirrored admission columns are part of the advertised hub schema, so a failed
// ALTER on one stops startup; the hub-only anchor reward column stays best-effort.

const sinon = require('sinon');
const { expect } = require('chai');

const Database = require('../../../../src/db');

const MIRRORED = {
    cross_chain_matches:   ['btc', 'ltc', 'doge'],
    cross_chain_calls:     ['btc', 'ltc', 'doge'],
    bridge_transfers:      ['btc', 'ltc', 'doge'],
    policy_snapshots:      ['btc', 'ltc', 'doge'],
    price_snapshots:       ['btc', 'ltc', 'doge'],
    list_snapshots:        ['btc', 'ltc', 'doge'],
    attestation_responses: ['btc'],
};
const COLUMN_DEF = 'BIGINT UNSIGNED DEFAULT NULL';

describe('admission column migration requiredness', function () {
    afterEach(function () { sinon.restore(); });

    it('requires every mirrored admission column and oracle_prices.admit_block', async function () {
        const db = Object.create(Database.prototype);
        db.migrateAddNullableColumn = sinon.stub().resolves();
        await db.migrateAdmissionColumns();
        for (const table of Object.keys(MIRRORED)) {
            for (const chain of MIRRORED[table]) {
                expect(db.migrateAddNullableColumn.calledWithExactly(table, 'admit_block_' + chain, COLUMN_DEF, true),
                    table + '.admit_block_' + chain).to.equal(true);
            }
        }
        expect(db.migrateAddNullableColumn.calledWithExactly('oracle_prices', 'admit_block', COLUMN_DEF, true)).to.equal(true);
    });

    it('keeps the hub-only anchor reward admission column best-effort', async function () {
        const db = Object.create(Database.prototype);
        db.migrateAddNullableColumn = sinon.stub().resolves();
        await db.migrateAdmissionColumns();
        expect(db.migrateAddNullableColumn.calledWithExactly(
            'anchor_reward_attestations', 'admit_block_btc', COLUMN_DEF, false)).to.equal(true);
    });

    it('rejects when the ALTER for a mirrored admission column fails', async function () {
        const alterError = new Error('fixture ALTER denied');
        const connection = { query: sinon.stub(), release: sinon.stub().resolves() };
        connection.query.callsFake(async (sql, args) => {
            if (/information_schema/.test(sql)) return [{ c: 'id' }];
            if (/ALTER TABLE `price_snapshots` ADD COLUMN `admit_block_btc`/.test(sql)) throw alterError;
            return [];
        });
        const db = Object.create(Database.prototype);
        db.dbName = 'fixture_hub';
        db.getConnection = sinon.stub().resolves(connection);

        let failure = null;
        try { await db.migrateAdmissionColumns(); } catch (error) { failure = error; }
        expect(failure, 'a mirrored admission ALTER failure must stop startup').to.equal(alterError);
    });

    it('continues past a failed ALTER on the hub-only anchor reward column', async function () {
        const connection = { query: sinon.stub(), release: sinon.stub().resolves() };
        connection.query.callsFake(async (sql) => {
            if (/information_schema/.test(sql)) return [{ c: 'id' }];
            if (/ALTER TABLE `anchor_reward_attestations`/.test(sql)) throw new Error('fixture ALTER denied');
            return [];
        });
        const db = Object.create(Database.prototype);
        db.dbName = 'fixture_hub';
        db.getConnection = sinon.stub().resolves(connection);

        await db.migrateAdmissionColumns();
        const alters = connection.query.getCalls().map(c => c.args[0]).filter(s => /ALTER TABLE/.test(s));
        expect(alters.some(s => /`list_snapshots` ADD COLUMN `meta_hash`/.test(s))).to.equal(true);
    });
});
