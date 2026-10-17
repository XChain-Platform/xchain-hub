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
 ********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const snapshots = require('../../../src/db/snapshots');

const SQL_FILE = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'snapshot_checkpoints.sql');

function recordingDb(result) {
    const calls = [];
    return Object.assign({
        calls,
        async doQuery(sql, args) {
            calls.push({ sql, args });
            return typeof result === 'function' ? result(calls.length) : result;
        }
    }, snapshots);
}

describe('snapshot checkpoints hub table', function () {
    it('declares the checkpoint columns and unique chain height key', function () {
        const sql = fs.readFileSync(SQL_FILE, 'utf8');
        expect(sql).to.match(/id\s+BIGINT\s+NOT NULL\s+AUTO_INCREMENT/);
        expect(sql).to.match(/state_root_version\s+INT\s+NOT NULL/);
        expect(sql).to.match(/validator_signatures\s+MEDIUMTEXT\s+NOT NULL/);
        expect(sql).to.match(/UNIQUE KEY uq_snap_ckpt\s*\(chain, network, block_index\)/);
    });

    it('inserts idempotently and reports whether a row was written', async function () {
        const db = recordingDb(call => ({ affectedRows: call === 1 ? 1 : 0 }));
        const cp = {
            chain: 'BTC',
            network: 'regtest',
            block_index: 994,
            block_hash: 'a'.repeat(64),
            state_root: 'b'.repeat(64),
            state_root_version: 1,
            validator_signatures: '[]'
        };

        expect(await db.insertSnapshotCheckpoint(cp)).to.equal(true);
        expect(await db.insertSnapshotCheckpoint(cp)).to.equal(false);
        expect(db.calls[0].sql).to.equal(
            'INSERT IGNORE INTO snapshot_checkpoints ' +
            '(chain, network, block_index, block_hash, state_root, state_root_version, validator_signatures) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)');
        expect(db.calls[0].args).to.deep.equal([
            'BTC', 'regtest', 994, cp.block_hash, cp.state_root, 1, '[]'
        ]);
    });

    it('reads one checkpoint by chain, network, and block index', async function () {
        const checkpoint = { chain: 'BTC', network: 'regtest', block_index: 994 };
        const db = recordingDb([checkpoint]);

        expect(await db.getSnapshotCheckpoint('BTC', 'regtest', 994)).to.equal(checkpoint);
        expect(db.calls[0].sql).to.match(
            /WHERE chain = \? AND network = \? AND block_index = \? LIMIT 1$/);
        expect(db.calls[0].args).to.deep.equal(['BTC', 'regtest', 994]);
    });

    it('lists ascending distinct due blocks and caps the parameterized limit', async function () {
        const due = [{ snapshot_block: 1000 }, { snapshot_block: 1100 }];
        const db = recordingDb(due);

        expect(await db.listUncheckpointedSnapshotBlocks('regtest', 1000, 6, 250)).to.equal(due);
        expect(db.calls[0].sql).to.match(/^SELECT DISTINCT cs\.snapshot_block/);
        expect(db.calls[0].sql).to.include('INNER JOIN configs network_scope');
        expect(db.calls[0].sql).to.include('network_scope.network = ?');
        expect(db.calls[0].sql).to.include('network_scope.param_value = cs.btc_chain_id');
        expect(db.calls[0].sql).to.include('cs.snapshot_block >= ?');
        expect(db.calls[0].sql).to.include('NOT EXISTS');
        expect(db.calls[0].sql).to.include('sc.block_index = cs.snapshot_block - ?');
        expect(db.calls[0].sql).to.match(/ORDER BY cs\.snapshot_block ASC LIMIT \?$/);
        expect(db.calls[0].args).to.deep.equal(['regtest', 1000, 'BTC', 'regtest', 6, 100]);
    });
});
