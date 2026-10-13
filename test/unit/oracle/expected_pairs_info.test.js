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

// getSubmissionsInfo: expectedPairs / expectedPairsRound, with derived pairs
// dropped while the xchain price gate is shut for the live round.

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../../helpers/mockHub');
const { DERIVED_PAIRS } = require('../../../src/constants.js');

const INTERVAL_MS = 60000;
const CURRENT = 51688;

let OracleRound = null;

async function infoWithGate(open) {
    let hub = createMockHub({
        p2pConfig: {
            ORACLE_EPOCH_START: Date.now() - CURRENT * INTERVAL_MS,
            ORACLE_ROUND_INTERVAL: String(INTERVAL_MS),
            ORACLE_SUBMISSION_WINDOW: '30000'
        }
    });
    hub.db.doQuery = sinon.stub().resolves([]);
    let round = new OracleRound(hub);
    round.xchainPriceGateOpen = () => open;
    return { info: await round.getSubmissionsInfo(), round };
}

describe('oracle diagnostics: expectedPairs', function () {
    before(function () {
        this.timeout(30000);
        OracleRound = proxyquire('../../../src/oracle/round', {
            './price_fetcher': Object.assign(
                function () { return { fetchPrices: sinon.stub().resolves([]) }; },
                { getCoinPairs: () => ['BTC/USD', 'ETH/USD'] })
        });
    });
    afterEach(function () { sinon.restore(); });

    it('drops derived pairs while the gate is shut', async function () {
        let { info } = await infoWithGate(false);
        expect(info.expectedPairs).to.deep.equal(['BTC/USD', 'ETH/USD']);
    });

    it('keeps derived pairs once the gate is open', async function () {
        let { info } = await infoWithGate(true);
        expect(info.expectedPairs).to.include.members(['BTC/USD', 'ETH/USD', ...DERIVED_PAIRS]);
    });

    it('reports the round the list was computed for', async function () {
        let { info, round } = await infoWithGate(false);
        expect(info.expectedPairsRound).to.equal(round.currentRound);
    });
});
