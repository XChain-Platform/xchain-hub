'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: the price_snapshots dispute must compare the reorg
// timestamp (milliseconds) against block_timestamp (Unix seconds) in the same
// unit, or it silently matches zero rows and the rollback is a no-op.

const sinon      = require('sinon');
const { expect } = require('chai');
const ReorgHandler = require('../../src/ReorgHandler');
const { createMockHub } = require('../helpers/mockHub');

describe('ReorgHandler price-snapshot dispute unit (stress-sweep 2026-07-08)', function () {

    let hub, rh;

    beforeEach(function () {
        hub = createMockHub();
        rh = new ReorgHandler(hub);
    });

    afterEach(function () { sinon.restore(); });

    it('disputes price_snapshots comparing the ms timestamp divided to seconds', async function () {
        let tsMs = 1_700_000_000_000; // milliseconds
        await rh._executeRollback('BTC', 800000, tsMs, 'reorg-x', 3, '[]');

        // getCall(1) is the price_snapshots UPDATE.
        let disputeCall = hub.db.doQuery.getCall(1);
        expect(disputeCall.args[0]).to.include("status = 'disputed'");
        // Must convert the bound ms value to seconds (block_timestamp is seconds).
        expect(disputeCall.args[0]).to.match(/block_timestamp\s*>\s*\?\s*\/\s*1000/);
        expect(disputeCall.args[1]).to.deep.equal([tsMs]);
    });

    it('a seconds column would actually be crossed by the converted bound (sanity)', function () {
        // block_timestamp (seconds) ~1.7e9; reorg ts (ms) ~1.7e12; ts/1000 ~1.7e9.
        let blockTsSeconds = 1_700_000_500;      // a snapshot 500s after the reorg boundary
        let reorgMs        = 1_700_000_000_000;  // boundary in ms
        expect(blockTsSeconds > reorgMs).to.equal(false);        // the OLD (buggy) comparison
        expect(blockTsSeconds > reorgMs / 1000).to.equal(true);  // the FIXED comparison
    });
});
