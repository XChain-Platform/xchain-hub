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

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const SQL_DIR = path.join(__dirname, '..', '..', '..', '..', 'src', 'sql');
const TABLE_COLUMNS = {
    consensus_state:      ['updated_at'],
    cross_chain_calls:     ['created_at'],
    cross_chain_matches:   ['created_at'],
    governance_proposals:  ['applied_at', 'created_at'],
    governance_votes:      ['created_at'],
    p2p_peers:             ['last_seen_at', 'created_at', 'updated_at'],
    policy_snapshots:      ['created_at'],
    reorg_attestations:    ['created_at', 'updated_at']
};

function uncommentedSql(table) {
    return fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8')
        .split('\n')
        .map(line => line.replace(/--.*$/, '').trim())
        .join('\n');
}

describe('consensus, cross-chain and governance DDL datetime columns', function () {
    for (let [table, columns] of Object.entries(TABLE_COLUMNS)) {
        let sql = uncommentedSql(table);

        it(table + '.sql has no TIMESTAMP column declarations', function () {
            expect(sql).to.not.match(/^[a-z_][a-z0-9_]*\s+TIMESTAMP\b/im);
        });

        it(table + '.sql declares the required DATETIME columns', function () {
            for (let column of columns)
                expect(sql).to.match(new RegExp('^' + column + '\\s+DATETIME\\b', 'im'));
        });
    }
});
