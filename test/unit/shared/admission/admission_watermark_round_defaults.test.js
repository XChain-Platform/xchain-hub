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

// The admission watermark's round-timeout fallbacks for the xdex, attest and anchor
// rails. Each is the published trail bound for its rail, so each must read the one
// shared definition its engine reads, never a local copy of the number.

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const WATERMARK_PATH = '../../../../src/peers/hub_db/admission_height_watermark.js';
const { AdmissionHeightWatermark } = require(WATERMARK_PATH);
const constants = require('../../../../src/constants.js');

const ENV_KEYS = ['XDEX_ROUND_TIMEOUT_MS', 'XDEX_ROUND_MAX_LIFETIME_MS', 'ATTESTATION_ROUND_TIMEOUT_MS',
                  'ANCHOR_ROUND_TIMEOUT_MS'];

// Build with none of the round knobs set anywhere, so every rail takes its default.
function withCleanEnv(fn) {
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); }
    finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

describe('admission height watermark: round-timeout defaults bind to the shared constants', function () {

    it('sizes each rail from its shared default with nothing configured', function () {
        let w = withCleanEnv(() => new AdmissionHeightWatermark({}));
        expect(w.roundWindows.xdex).to.equal(constants.DEFAULT_XDEX_ROUND_TIMEOUT_MS * 4);
        expect(w.roundWindows.attest).to.equal(constants.DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS);
        expect(w.roundWindows.anchor).to.equal(constants.DEFAULT_ANCHOR_ROUND_TIMEOUT_MS);
    });

    it('follows a retuned shared default on every rail rather than a local copy', function () {
        // Distinct stand-ins per rail prove each fallback reads its own constant.
        const { AdmissionHeightWatermark: Stubbed } = proxyquire(WATERMARK_PATH, {
            '../../constants.js': {
                DEFAULT_XDEX_ROUND_TIMEOUT_MS:        11111,
                DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS: 22222,
                DEFAULT_ANCHOR_ROUND_TIMEOUT_MS:      33333,
            },
        });
        let w = withCleanEnv(() => new Stubbed({}));
        expect(w.roundWindows.xdex).to.equal(11111 * 4);
        expect(w.roundWindows.attest).to.equal(22222);
        expect(w.roundWindows.anchor).to.equal(33333);
    });

    it('matches the anchor engine default read from the same constant', function () {
        const StateAnchorPublisher = require('../../../../src/anchor/publisher.js');
        let pub = withCleanEnv(() => new StateAnchorPublisher({ db: {}, p2pConfig: { DOGE_ADDRESS: 'Dpub1' } }));
        let w = withCleanEnv(() => new AdmissionHeightWatermark({}));
        expect(pub.roundTimeoutMs).to.equal(w.roundWindows.anchor);
    });
});
