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

// The end state a dated migration leaves, and when a live schema already holds
// it. The last block is the fresh-install contract: every committed file's end
// state holds on the schema the src/sql CREATE TABLE files build, so a fresh hub
// baselines them all and runs no migration statement.

const { expect } = require('chai');
const { planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');
const files = require('../../../../src/db/schema/sql_migration_files.js');
const { freshSchemaRows, SQL_DIR } = require('../../../helpers/fresh_schema_model.js');
const path = require('path');

const MIGRATIONS = path.join(SQL_DIR, 'migrations');

const col = (t, c, dt, ct, cs, len) => ({ t, c, dt, ct: ct || dt, cs: cs || null, len: len == null ? null : len });
const idx = (t, i, cols, unique) => cols.map(c => ({ t, i, c, nu: unique ? 0 : 1 }));
const unmet = (statements, columns, indexes) => unmetEndState(planEndState(statements), schemaModel(columns, indexes || []));

function registerColumnTests() {
    describe('column statements', function () {
        it('a DATETIME restate holds only once the live type is datetime', function () {
            const stmt = ['ALTER TABLE `validators` MODIFY `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP'];
            expect(unmet(stmt, [col('validators', 'created_at', 'datetime')])).to.deep.equal([]);
            expect(unmet(stmt, [col('validators', 'created_at', 'timestamp')])).to.deep.equal(['validators.created_at is timestamp, not datetime']);
        });

        it('an ENUM restate holds only when every value is live', function () {
            const stmt = ["ALTER TABLE `validator_capabilities` MODIFY `capability` ENUM('price','full_node') NOT NULL"];
            expect(unmet(stmt, [col('validator_capabilities', 'capability', 'enum', "enum('price','full_node')")])).to.deep.equal([]);
            expect(unmet(stmt, [col('validator_capabilities', 'capability', 'enum', "enum('price')")]))
                .to.deep.equal(['validator_capabilities.capability lacks ENUM value full_node']);
        });

        it('a charset restate holds only on the target charset', function () {
            const stmt = ['ALTER TABLE `attestation_responses` MODIFY `meta` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci'];
            expect(unmet(stmt, [col('attestation_responses', 'meta', 'text', 'text', 'utf8mb4')])).to.deep.equal([]);
            expect(unmet(stmt, [col('attestation_responses', 'meta', 'text', 'text', 'utf8mb3')]))
                .to.deep.equal(['attestation_responses.meta is utf8mb3, not utf8mb4']);
        });

        it('a length widen holds at or above the target width', function () {
            const stmt = ['ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL'];
            expect(unmet(stmt, [col('oracle_prices', 'tick', 'varchar', 'varchar(255)', 'utf8mb4', 255)])).to.deep.equal([]);
            expect(unmet(stmt, [col('oracle_prices', 'tick', 'varchar', 'varchar(50)', 'utf8mb4', 50)]))
                .to.deep.equal(['oracle_prices.tick holds 50 characters, not 250']);
        });

        it('an ADD COLUMN IF NOT EXISTS holds once the column exists, whatever its definition', function () {
            const stmt = ['ALTER TABLE `list_snapshots` ADD COLUMN IF NOT EXISTS `meta_hash` CHAR(64) NULL'];
            expect(unmet(stmt, [col('list_snapshots', 'meta_hash', 'char', 'char(64)', null, 64)])).to.deep.equal([]);
            expect(unmet(stmt, [col('list_snapshots', 'id', 'bigint')])).to.deep.equal(['list_snapshots.meta_hash is absent']);
        });
    });
}

function registerIndexTests() {
    describe('index statements', function () {
        it('ADD INDEX IF NOT EXISTS holds on the name alone', function () {
            const stmt = ['ALTER TABLE `validator_rewards` ADD INDEX IF NOT EXISTS `idx_batch_seq` (batch_seq)'];
            expect(unmet(stmt, [], idx('validator_rewards', 'idx_batch_seq', ['other']))).to.deep.equal([]);
            expect(unmet(stmt, [], [])).to.deep.equal(['validator_rewards index idx_batch_seq is absent']);
        });

        it('a retired index holds only once it is gone', function () {
            const stmt = ['ALTER TABLE `state_checkpoints` DROP INDEX IF EXISTS `checkpoint_seq`'];
            expect(unmet(stmt, [], [])).to.deep.equal([]);
            expect(unmet(stmt, [], idx('state_checkpoints', 'checkpoint_seq', ['checkpoint_seq'])))
                .to.deep.equal(['state_checkpoints index checkpoint_seq is still present']);
        });

        it('a widen (temporary key, drop, re-add, drop) holds only on the wide key with no temporary key left', function () {
            const stmts = [
                'ALTER TABLE `capability_snapshots` ADD UNIQUE KEY IF NOT EXISTS `uq_cap_snap_widening` (snapshot_block, capability, signing_pubkey, source)',
                'ALTER TABLE `capability_snapshots` DROP INDEX IF EXISTS `uq_cap_snap`',
                'ALTER TABLE `capability_snapshots` ADD UNIQUE KEY IF NOT EXISTS `uq_cap_snap` (snapshot_block, capability, signing_pubkey, source)',
                'ALTER TABLE `capability_snapshots` DROP INDEX IF EXISTS `uq_cap_snap_widening`'
            ];
            const wide = idx('capability_snapshots', 'uq_cap_snap', ['snapshot_block', 'capability', 'signing_pubkey', 'source'], true);
            const narrow = idx('capability_snapshots', 'uq_cap_snap', ['snapshot_block', 'capability', 'signing_pubkey'], true);
            const temp = idx('capability_snapshots', 'uq_cap_snap_widening', ['snapshot_block', 'capability', 'signing_pubkey', 'source'], true);
            expect(unmet(stmts, [], wide)).to.deep.equal([]);
            expect(unmet(stmts, [], narrow)).to.have.lengthOf(1);
            expect(unmet(stmts, [], narrow.concat(temp))).to.have.lengthOf(2);
        });

        it('a unique key must be live as unique', function () {
            const stmt = ['ALTER TABLE `oracle_submissions` ADD UNIQUE KEY IF NOT EXISTS `uq_submission` (round_number, coin_pair, validator_pubkey)'];
            expect(unmet(stmt, [], idx('oracle_submissions', 'uq_submission', ['round_number'], false)))
                .to.deep.equal(['oracle_submissions index uq_submission is not unique']);
        });

        it('a primary key re-key holds only on the new key columns', function () {
            const stmt = ['ALTER TABLE `price_ingest_watermarks` DROP PRIMARY KEY, ADD PRIMARY KEY (network, source_chain)'];
            expect(unmet(stmt, [], idx('price_ingest_watermarks', 'PRIMARY', ['network', 'source_chain'], true))).to.deep.equal([]);
            expect(unmet(stmt, [], idx('price_ingest_watermarks', 'PRIMARY', ['source_chain'], true)))
                .to.deep.equal(['price_ingest_watermarks index primary covers (source_chain), not (network, source_chain)']);
        });
    });
}

function registerPlanTests() {
    describe('what a plan can stand for', function () {
        it('row-level DELETE and UPDATE steps carry no end state of their own', function () {
            const plan = planEndState(['DELETE t1 FROM t t1 INNER JOIN t t2 WHERE t1.id > t2.id', 'UPDATE t SET a = 1']);
            expect(plan.unknown).to.deep.equal([]);
            expect(unmetEndState(plan, schemaModel([], []))).to.deep.equal(['the file states no schema end state']);
        });

        it('any statement it cannot read keeps the file from ever being baselined', function () {
            const plan = planEndState(["SET @hub_network = ''", 'ALTER TABLE `t` ADD INDEX IF NOT EXISTS `i` (a)']);
            expect(unmetEndState(plan, schemaModel([], idx('t', 'i', ['a'])))[0]).to.match(/^unrecognized statement: SET/);
        });
    });
}

function registerFreshInstallTests() {
    describe('a fresh install, built from the src/sql CREATE TABLE files', function () {
        const rows = freshSchemaRows();
        const model = schemaModel(rows.columns, rows.indexes);
        const names = files.listDatedMigrations(MIGRATIONS);

        it('has dated migrations to check', function () {
            expect(names.length).to.be.at.least(8);
        });

        for (const name of names) {
            if (files.isRunbook(files.readMigration(MIGRATIONS, name))) {
                it('is a runbook, so a blanket run never baselines or applies ' + name, function () {
                    expect(files.isRunbook(files.readMigration(MIGRATIONS, name))).to.equal(true);
                });
                continue;
            }
            it('already holds the end state of ' + name + ', so it is baselined with no statement run', function () {
                const plan = planEndState(files.splitMigrationStatements(files.readMigration(MIGRATIONS, name)));
                expect(unmetEndState(plan, model)).to.deep.equal([]);
            });
        }
    });
}

describe('dated migration end state', function () {
    registerColumnTests();
    registerIndexTests();
    registerPlanTests();
    registerFreshInstallTests();
});
