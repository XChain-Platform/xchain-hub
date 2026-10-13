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

// freshnessHydrateError: set when the startup freshness rehydrate fails, and
// emitted in the hub submissions info so zeroed stall counters can be told apart
// from a real clean slate.

const sinon = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMockHub } = require('../../helpers/mockHub');

const INTERVAL_MS = 60000;
const CURRENT = 51688;

describe('oracle freshness rehydrate error flag', function () {
    let OracleRound = null;

    before(function () {
        this.timeout(30000);
        OracleRound = proxyquire('../../../src/oracle/round', {
            './price_fetcher': function () { return { fetchPrices: sinon.stub().resolves([]) }; }
        });
    });
    afterEach(function () { sinon.restore(); });

    function build() {
        let hub = createMockHub({
            p2pConfig: {
                ORACLE_EPOCH_START: Date.now() - CURRENT * INTERVAL_MS,
                ORACLE_ROUND_INTERVAL: String(INTERVAL_MS),
                ORACLE_SUBMISSION_WINDOW: '30000'
            }
        });
        hub.db.doQuery = sinon.stub().resolves([]);
        return new OracleRound(hub);
    }

    it('is false in the info before any rehydrate runs', async function () {
        let info = await build().getSubmissionsInfo();
        expect(info.freshnessHydrateError).to.equal(false);
    });

    it('stays false when the rehydrate succeeds', async function () {
        let or = build();
        or.db.getPriceSnapshotByStatus = sinon.stub().resolves([{ round_number: 5, ms: 1000 }]);
        or.db.getPriceSnapshotsCountUnfinalizedAfterRound = sinon.stub().resolves([{ skipped: 2 }]);
        await or.hydrateFreshnessCounters();
        let info = await or.getSubmissionsInfo();
        expect(info.freshnessHydrateError).to.equal(false);
        expect(info.consecutiveSkippedRounds).to.equal(2);
    });

    it('is true in the info when the rehydrate fails, and the defaults stay', async function () {
        let or = build();
        or.db.getPriceSnapshotByStatus = sinon.stub().rejects(new Error('db down'));
        await or.hydrateFreshnessCounters();
        let info = await or.getSubmissionsInfo();
        expect(info.freshnessHydrateError).to.equal(true);
        expect(info.consecutiveSkippedRounds).to.equal(0);
        expect(info.lastSuccessfulRoundTime).to.equal(null);
    });

    it('clears after a later rehydrate succeeds', async function () {
        let or = build();
        or.db.getPriceSnapshotByStatus = sinon.stub();
        or.db.getPriceSnapshotByStatus.onFirstCall().rejects(new Error('db down'));
        or.db.getPriceSnapshotByStatus.onSecondCall().resolves([]);
        or.db.getPriceSnapshotsCountUnfinalizedAfterRound = sinon.stub().resolves([]);
        await or.hydrateFreshnessCounters();
        expect(or.freshnessHydrateError).to.equal(true);
        await or.hydrateFreshnessCounters();
        expect((await or.getSubmissionsInfo()).freshnessHydrateError).to.equal(false);
    });
});
