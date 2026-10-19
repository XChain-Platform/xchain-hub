'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { pickDueSnapshot } = require('../../../../src/anchor/snapshot_checkpoint/due.js');

function view(overrides = {}) {
    return {
        inFlight: false,
        gateActive: snapshotBlock => snapshotBlock >= 100,
        blockOf: snapshotBlock => snapshotBlock - 6,
        btcTip: 1000,
        confirmations: 6,
        ...overrides
    };
}

function due(snapshotBlock) {
    return { snapshot_block: snapshotBlock, block_index: snapshotBlock - 6 };
}

describe('snapshot checkpoint due selection', function () {
    it('picks the oldest gate-active block from an unordered list', function () {
        expect(pickDueSnapshot([130, 110, 120], view())).to.deep.equal(due(110));
    });

    it('passes over a block below the gate', function () {
        expect(pickDueSnapshot([90, 105], view())).to.deep.equal(due(105));
    });

    it('coerces string and BigInt entries', function () {
        expect(pickDueSnapshot(['130', BigInt(120)], view())).to.deep.equal(due(120));
    });

    it('skips unusable entries without treating null as zero', function () {
        const entries = [-1, 1.5, 'x', null, undefined, Symbol('block'), 110];
        expect(pickDueSnapshot(entries, view({ gateActive: () => true }))).to.deep.equal(due(110));
    });

    it('returns null while a round is inFlight', function () {
        expect(pickDueSnapshot([110], view({ inFlight: true }))).to.equal(null);
    });

    it('returns null for an empty or non-array list', function () {
        expect(pickDueSnapshot([], view())).to.equal(null);
        expect(pickDueSnapshot(null, view())).to.equal(null);
    });

    it('returns null when no block is gate-active', function () {
        expect(pickDueSnapshot([50, 60], view())).to.equal(null);
    });

    it('accepts a tip exactly at the block plus confirmations', function () {
        expect(pickDueSnapshot([110], view({ btcTip: 110 }))).to.deep.equal(due(110));
    });

    it('coerces a string tip', function () {
        expect(pickDueSnapshot([110], view({ btcTip: '110' }))).to.deep.equal(due(110));
    });

    it('waits when the oldest block has a shallow tip', function () {
        expect(pickDueSnapshot([110, 120], view({ btcTip: 109 }))).to.equal(null);
    });

    it('returns null for an unusable block index', function () {
        expect(pickDueSnapshot([110], view({ blockOf: () => -1 }))).to.equal(null);
        expect(pickDueSnapshot([110], view({ blockOf: () => 1.5 }))).to.equal(null);
    });

    it('returns null when the tip is missing', function () {
        expect(pickDueSnapshot([110], view({ btcTip: undefined }))).to.equal(null);
    });
});
