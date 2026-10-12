'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    capListRows, sortedListRows, listIdsOf, listCapabilityWants
} = require('../../../../../../src/anchor/publisher/archive/list/list_rows_select.js');

describe('archive list row selection', () => {
    it('caps nine rows at eight and reports the cap', () => {
        let found = Array.from({ length: 9 }, (_, i) => i + 1);

        expect(capListRows(found, 8)).to.deep.equal({ rows: found.slice(0, 8), capped: true });
    });

    it('does not report a cap for exactly eight rows', () => {
        let found = Array.from({ length: 8 }, (_, i) => i + 1);

        expect(capListRows(found, 8)).to.deep.equal({ rows: found, capped: false });
        expect(capListRows(undefined, 8)).to.deep.equal({ rows: [], capped: false });
    });

    it('sorts a copy by string snapshot id without mutating the input', () => {
        let rows = [
            { snapshot_id: 'b', snapshot_block: '7' },
            { snapshot_id: 'a', snapshot_block: 5 }
        ];
        let before = rows.slice();

        expect(sortedListRows(rows).map(row => row.snapshot_id)).to.deep.equal(['a', 'b']);
        expect(rows).to.deep.equal(before);
    });

    it('projects snapshot ids in the given order', () => {
        let rows = [{ snapshot_id: 12 }, { snapshot_id: '3' }];

        expect(listIdsOf(rows)).to.deep.equal([{ snapshot_id: '12' }, { snapshot_id: '3' }]);
    });

    it('projects cross-chain capability wants in the given order', () => {
        let rows = [{ snapshot_block: '7' }, { snapshot_block: 5 }];

        expect(listCapabilityWants(rows)).to.deep.equal([
            { block: 7, capability: 'cross_chain' },
            { block: 5, capability: 'cross_chain' }
        ]);
    });
});
