'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: Consensus._handleViewChange must not rewind the
// view (monotonicity) and must not create a pendingViewChanges bucket for an
// out-of-window (too-far-ahead) view number.

const sinon      = require('sinon');
const { expect } = require('chai');
const Consensus  = require('../../src/Consensus');
const { createMockHub } = require('../helpers/mockHub');
const { pubkeyForTestSender } = require('../helpers/fixtures');

describe('Consensus view-change guard (stress-sweep 2026-07-08)', function () {

    let hub, consensus;

    beforeEach(function () {
        hub = createMockHub();
        consensus = new Consensus(hub);
        consensus.view = 3;
    });

    afterEach(function () { sinon.restore(); });

    function vc(view, seq) {
        consensus._handleViewChange({ sender: 'ws://peer:10001', sig_pubkey: pubkeyForTestSender('ws://peer:10001'), data: { view, seq: seq || 1 } });
    }

    it('ignores a VIEW_CHANGE for a view <= the current view (no rewind, no bucket)', function () {
        vc(2);
        expect(consensus.pendingViewChanges.has(2)).to.equal(false);
        expect(consensus.view).to.equal(3);
    });

    it('accepts a VIEW_CHANGE equal to the current view (votes for the target this node initiated)', function () {
        vc(3);
        expect(consensus.pendingViewChanges.has(3)).to.equal(true);
    });

    it('ignores a VIEW_CHANGE beyond the forward-skew window (no unbounded buckets)', function () {
        vc(3 + 101); // MAX_VIEW_SKEW is 100
        expect(consensus.pendingViewChanges.has(104)).to.equal(false);
    });

    it('accepts an in-window forward VIEW_CHANGE (creates a bucket)', function () {
        vc(4);
        expect(consensus.pendingViewChanges.has(4)).to.equal(true);
    });

    it('a flood of ever-increasing view numbers cannot grow pendingViewChanges without bound', function () {
        for (let v = 0; v < 5000; v++) vc(3 + 1000 + v); // all far beyond the skew window
        expect(consensus.pendingViewChanges.size).to.equal(0);
    });
});
