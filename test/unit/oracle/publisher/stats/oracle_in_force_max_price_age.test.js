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
//
// The status snapshot reports the price-age bound the hub enforces now. The
// refresh must start from cadenceStats() alone, because a caller that reads only
// that block never reaches batchRailStats().

const { expect } = require('chai');

const stats = require('../../../../../src/oracle/publisher/stats.js');

function makePublisher(lookup) {
    return Object.assign({
        hub:                      { oracleMaxAgeSecondsInForce: lookup },
        roundIntervalMs:          60000,
        batchGraceMs:             0,
        batchLandingReserveMs:    0,
        batchWindowRoundsCeiling: 60,
        oracleMaxPriceAgeMs:      7200000,
        oracleHourlyMaxPriceAgeMs: 3600000,
        spendGuard:               { stats: () => ({}) }
    }, stats);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('oracle publisher in-force max price age', () => {
    it('reports the hub value in both fields once the refresh settles', async () => {
        let publisher = makePublisher(async () => 5400);
        publisher.cadenceStats();
        await settle();
        let reported = publisher.cadenceStats();
        expect(reported.oracleInForceMaxPriceAgeSeconds).to.equal(5400);
        expect(reported.oracleMaxPriceAgeSeconds).to.equal(5400);
    });

    it('reports null for the in-force bound when the lookup rejects', async () => {
        let publisher = makePublisher(async () => { throw new Error('hub down'); });
        publisher.cadenceStats();
        await settle();
        let reported = publisher.cadenceStats();
        expect(reported.oracleInForceMaxPriceAgeSeconds).to.equal(null);
        expect(reported.oracleMaxPriceAgeSeconds).to.equal(7200);
    });

    it('reports null for the in-force bound when the lookup resolves null', async () => {
        let publisher = makePublisher(async () => null);
        publisher.cadenceStats();
        await settle();
        expect(publisher.cadenceStats().oracleInForceMaxPriceAgeSeconds).to.equal(null);
    });

    it('drops a known value when a later lookup fails', async () => {
        let calls = 0;
        let publisher = makePublisher(async () => {
            if (++calls === 1) return 5400;
            throw new Error('hub down');
        });
        publisher.cadenceStats();
        await settle();
        publisher.cadenceStats();
        await settle();
        expect(publisher.cadenceStats().oracleInForceMaxPriceAgeSeconds).to.equal(null);
    });
});
