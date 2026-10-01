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
const {
    LIST_SNAPSHOT_KEYS,
    POLICY_KEYS,
    ARCHIVE_MAX_LIST_ROWS
} = require('../../../../../src/anchor/publisher/constants.js');

describe('list snapshot archive constants', () => {
    it('pins the list snapshot key order', () => {
        expect(LIST_SNAPSHOT_KEYS).to.deep.equal([
            'id', 'snapshot_id', 'snapshot_block', 'network',
            'home_chain', 'home_list_index', 'list_type', 'seq', 'kind', 'origin_block',
            'members_hash', 'added', 'removed',
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
            'finalizing_view', 'validator_signatures', 'status'
        ]);
    });

    it('caps list snapshot archive rows', () => {
        expect(ARCHIVE_MAX_LIST_ROWS).to.equal(8);
    });

    it('leaves the policy snapshot key order unchanged', () => {
        expect(POLICY_KEYS).to.deep.equal([
            'id', 'snapshot_id', 'snapshot_block', 'network',
            'origin_chain', 'tick', 'policy_seq', 'origin_block', 'policy_hash',
            'allow_list', 'block_list', 'sleeping', 'effective_time',
            'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
            'finalizing_view', 'validator_signatures', 'status'
        ]);
    });
});
