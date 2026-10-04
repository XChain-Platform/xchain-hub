'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    nominalRoundSeconds,
    roundTimeMatches
} = require('../../../../../src/oracle/consensus/round_time');

describe('Oracle consensus round time', function () {
    const EPOCH_START_MS = 1700000000123;
    const ROUND_INTERVAL_MS = 15000;

    describe('nominalRoundSeconds', function () {
        it('calculates known round timestamps in whole seconds', function () {
            expect(nominalRoundSeconds(0, EPOCH_START_MS, ROUND_INTERVAL_MS)).to.equal(1700000000);
            expect(nominalRoundSeconds(2, EPOCH_START_MS, ROUND_INTERVAL_MS)).to.equal(1700000030);
        });

        it('returns null for a non-integer or negative round', function () {
            expect(nominalRoundSeconds(1.5, EPOCH_START_MS, ROUND_INTERVAL_MS)).to.equal(null);
            expect(nominalRoundSeconds(-1, EPOCH_START_MS, ROUND_INTERVAL_MS)).to.equal(null);
        });

        it('returns null for a non-positive interval', function () {
            expect(nominalRoundSeconds(1, EPOCH_START_MS, 0)).to.equal(null);
            expect(nominalRoundSeconds(1, EPOCH_START_MS, -1)).to.equal(null);
        });
    });

    describe('roundTimeMatches', function () {
        it('accepts a matching wire timestamp string', function () {
            expect(roundTimeMatches('1700000030', 2, EPOCH_START_MS, ROUND_INTERVAL_MS)).to.be.true;
        });

        it('refuses a wire timestamp that is off by one second', function () {
            expect(roundTimeMatches('1700000031', 2, EPOCH_START_MS, ROUND_INTERVAL_MS)).to.be.false;
        });
    });
});
