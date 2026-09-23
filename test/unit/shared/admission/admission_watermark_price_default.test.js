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
// The admission watermark's price rail window: the configured oracle round cadence
// when set, and the one shared DEFAULT_ORACLE_ROUND_INTERVAL_MS every other oracle
// cadence fallback reads when it is not.

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const WATERMARK_PATH = '../../../../src/peers/hub_db/admission_height_watermark.js';
const { AdmissionHeightWatermark } = require(WATERMARK_PATH);
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS } = require('../../../../src/constants.js');

const ENV_KEYS = ['ORACLE_ROUND_INTERVAL', 'ADMISSION_ORACLE_INGEST_WINDOW_MS'];

// Build with the oracle knobs absent from the environment, so config alone decides.
function withCleanEnv(fn) {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); }
    finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

describe('admission height watermark: the price rail window default', function () {

    it('sizes the price window from a configured ORACLE_ROUND_INTERVAL', function () {
        let w = withCleanEnv(() => new AdmissionHeightWatermark({ ORACLE_ROUND_INTERVAL: 200000 }));
        expect(w.roundTerminalMs('price_snapshots')).to.equal(200000);
    });

    it('falls back to the shared oracle round default when ORACLE_ROUND_INTERVAL is unset', function () {
        let w = withCleanEnv(() => new AdmissionHeightWatermark({}));
        expect(w.roundTerminalMs('price_snapshots')).to.equal(DEFAULT_ORACLE_ROUND_INTERVAL_MS);
    });

    it('follows a retuned shared default rather than a local copy of it', function () {
        // A distinct stand-in default proves the fallback reads constants.js, not a literal.
        const { AdmissionHeightWatermark: Stubbed } = proxyquire(WATERMARK_PATH, {
            '../../constants.js': { DEFAULT_ORACLE_ROUND_INTERVAL_MS: 123457 },
        });
        let w = withCleanEnv(() => new Stubbed({ ADMISSION_ORACLE_INGEST_WINDOW_MS: 200000 }));
        expect(w.roundTerminalMs('price_snapshots')).to.equal(123457);
        expect(w.roundTerminalMs('oracle_prices')).to.equal(200000);
    });
});
