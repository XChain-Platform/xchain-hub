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
const { makeProposeTimeHarness } = require('./helpers/propose_time_harness');

const EPOCH_START = 1704067200000;
const ROUND_INTERVAL = 10 * 60 * 1000;
const ROUND = 12;
const NOW_MS = EPOCH_START + ROUND * ROUND_INTERVAL + 60 * 1000;
const NOMINAL_TIME = Math.floor((EPOCH_START + ROUND * ROUND_INTERVAL) / 1000);

describe('OracleConsensus follower PROPOSE time harness', function () {
    let harness;

    beforeEach(function () {
        harness = makeProposeTimeHarness({
            network:       'mainnet',
            round:         ROUND,
            epochStart:    EPOCH_START,
            roundInterval: ROUND_INTERVAL,
            nowMs:         NOW_MS
        });
    });

    afterEach(function () {
        harness.restore();
    });

    it('carries a supplied time into a pending follower round', async function () {
        let result = await harness.deliver({ btcBlockTime: NOMINAL_TIME });

        expect(result.reachedSnapshot).to.equal(true);
        expect(result.pendingTime).to.equal(NOMINAL_TIME);
    });

    it('drops a bad digest before reading the capability snapshot', async function () {
        let result = await harness.deliver({ btcBlockTime: NOMINAL_TIME, badDigest: true });

        expect(result.reachedSnapshot).to.equal(false);
        expect(result.pendingTime).to.equal(null);
    });

    it('uses the follower clock when the PROPOSE omits its time', async function () {
        let result = await harness.deliver({ omitTime: true });

        expect(result.reachedSnapshot).to.equal(true);
        expect(result.pendingTime).to.equal(Math.floor(NOW_MS / 1000));
    });
});
