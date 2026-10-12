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

const mirrorColumns = require('../../../../src/db/schema/mirror_columns.js');

const { BRIDGE_TRANSFER_COLUMNS, POLICY_SNAPSHOT_COLUMNS, LIST_SNAPSHOT_COLUMNS } = mirrorColumns;

const LISTS = {
    BRIDGE_TRANSFER_COLUMNS,
    POLICY_SNAPSHOT_COLUMNS,
    LIST_SNAPSHOT_COLUMNS,
};

const TAIL = ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge', 'btc_chain_id'];

describe('mirror_columns wire shape', () => {
    it('exports exactly the three column lists', () => {
        expect(Object.keys(mirrorColumns).sort()).to.deep.equal(Object.keys(LISTS).sort());
    });

    for (const [name, list] of Object.entries(LISTS)) {
        describe(name, () => {
            it('is an array of unique strings', () => {
                expect(list).to.be.an('array').that.is.not.empty;
                list.forEach(col => expect(col).to.be.a('string').that.is.not.empty);
                expect(new Set(list).size).to.equal(list.length);
            });

            it('ends with the admission map then btc_chain_id', () => {
                expect(list.slice(-TAIL.length)).to.deep.equal(TAIL);
                expect(list[list.length - 1]).to.equal('btc_chain_id');
            });
        });
    }

    it('bridge list carries the transfer wire columns and omits table-assigned ones', () => {
        expect(BRIDGE_TRANSFER_COLUMNS).to.include.members(['transfer_id', 'validator_signatures', 'push_generation']);
        for (const col of ['id', 'status', 'created_at']) {
            expect(BRIDGE_TRANSFER_COLUMNS).to.not.include(col);
        }
    });

    it('policy list carries the policy snapshot columns', () => {
        expect(POLICY_SNAPSHOT_COLUMNS).to.include.members([
            'snapshot_id', 'policy_hash', 'allow_list', 'block_list', 'sleeping',
        ]);
    });

    it('list snapshot carries its hashes and index and has no push_generation', () => {
        expect(LIST_SNAPSHOT_COLUMNS).to.include.members(['members_hash', 'meta_hash', 'home_list_index']);
        expect(LIST_SNAPSHOT_COLUMNS).to.not.include('push_generation');
    });
});
