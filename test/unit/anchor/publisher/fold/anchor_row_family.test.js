/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ANCHOR publisher - folded row family predicates
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    isArchiveAnchorRow,
    isCheckpointAnchorRow
} = require('../../../../../src/anchor/publisher/fold/anchor_row_family.js');

describe('anchor row family predicates', function () {
    it('classifies a v0 chain row as checkpoint only', function () {
        const row = { version: 0, chain: 'BTC', match_batch_seq: null };
        expect(isCheckpointAnchorRow(row)).to.equal(true);
        expect(isArchiveAnchorRow(row)).to.equal(false);
    });

    it('classifies a v1 archive head as archive only', function () {
        const row = { version: 1, chain: null, match_batch_seq: 42 };
        expect(isArchiveAnchorRow(row)).to.equal(true);
        expect(isCheckpointAnchorRow(row)).to.equal(false);
    });

    it('excludes a v2 chunk from both families', function () {
        const row = { version: 2, chain: null, match_batch_seq: 42 };
        expect(isArchiveAnchorRow(row)).to.equal(false);
        expect(isCheckpointAnchorRow(row)).to.equal(false);
    });

    it('classifies a folded v3 chain row as checkpoint only', function () {
        const row = { version: 3, chain: 'DOGE', match_batch_seq: null };
        expect(isCheckpointAnchorRow(row)).to.equal(true);
        expect(isArchiveAnchorRow(row)).to.equal(false);
    });

    it('classifies a folded v3 archive row as archive only', function () {
        const row = { version: 3, chain: null, match_batch_seq: 42, section_index: 3 };
        expect(isArchiveAnchorRow(row)).to.equal(true);
        expect(isCheckpointAnchorRow(row)).to.equal(false);
    });

    it('excludes a chunk whose version is the string 2', function () {
        const row = { version: '2', chain: null, match_batch_seq: 42 };
        expect(isArchiveAnchorRow(row)).to.equal(false);
    });

    it('does not classify an undefined batch sequence as archive', function () {
        const row = { version: 1, chain: null, match_batch_seq: undefined };
        expect(isArchiveAnchorRow(row)).to.equal(false);
    });
});
