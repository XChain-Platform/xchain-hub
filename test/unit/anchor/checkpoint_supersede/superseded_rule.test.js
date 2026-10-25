'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The checkpoint reader derives supersession from append-only rows.

const { expect } = require('chai');
const {
    supersededBySeq,
    markSuperseded,
    isSupersedingRow,
} = require('../../../../src/anchor/checkpoint_engine/superseded_rule.js');

function row(checkpointSeq, blockIndex, supersedesFrom, overrides) {
    return {
        chain: 'LTC',
        network: 'testnet',
        checkpoint_seq: checkpointSeq,
        block_index: blockIndex,
        supersedes_from: supersedesFrom == null ? null : supersedesFrom,
        ...overrides,
    };
}

describe('anchor checkpoint superseded reader rule', function () {
    it('supersedes rows at and above the replacement floor but not below it', function () {
        let superseder = row(20, 120, 100);
        expect(supersededBySeq(row(10, 99), [superseder])).to.equal(null);
        expect(supersededBySeq(row(10, 100), [superseder])).to.equal(20);
        expect(supersededBySeq(row(10, 101), [superseder])).to.equal(20);
    });

    it('returns the lowest sequence when two later rows supersede the checkpoint', function () {
        let target = row(10, 100);
        expect(supersededBySeq(target, [row(40, 140, 80), row(30, 130, 90)]))
            .to.equal(30);
    });

    it('ignores superseders from another chain or network', function () {
        let target = row(10, 100);
        let candidates = [
            row(20, 120, 80, { chain: 'DOGE' }),
            row(30, 130, 80, { network: 'mainnet' }),
        ];
        expect(supersededBySeq(target, candidates)).to.equal(null);
    });

    it('ignores a superseding row whose sequence is not higher', function () {
        let target = row(20, 100);
        expect(supersededBySeq(target, [row(10, 120, 80), row(20, 130, 80)]))
            .to.equal(null);
    });

    it('compares driver-provided sequence and floor strings numerically', function () {
        let target = row('9', 100);
        let candidates = [row('11', 120, '90'), row('10', 110, '90')];
        expect(supersededBySeq(target, candidates)).to.equal(10);
    });

    it('marks shallow copies in input order without mutating the source rows', function () {
        let rows = [row(10, 100), row(20, 120, 90), row(30, 140)];
        let marked = markSuperseded(rows);

        expect(marked.map((entry) => entry.checkpoint_seq)).to.deep.equal([10, 20, 30]);
        expect(marked.map((entry) => entry.superseded_by_seq)).to.deep.equal([20, null, null]);
        expect(marked).to.not.equal(rows);
        marked.forEach((entry, index) => expect(entry).to.not.equal(rows[index]));
        rows.forEach((entry) => expect(entry).to.not.have.property('superseded_by_seq'));
    });

    it('identifies only rows with a non-null supersedes_from value', function () {
        expect(isSupersedingRow(row(20, 120, 0))).to.equal(true);
        expect(isSupersedingRow(row(10, 100))).to.equal(false);
    });
});
