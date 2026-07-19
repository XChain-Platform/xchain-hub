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
const constants  = require('../../src/constants');

// #1299: PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are federation-uniform oracle
// band constants that must have a single source of truth (constants.js). This is
// the hub-local conformance guard against the "re-introduced literal" drift vector:
// a future consumer (or a refactor) that hardcodes 0.05 or 1e10 instead of importing
// the constant would drift undetected. The full cross-repo byte-identical twin (a
// canonical entry in xchain-documentation/protocol/constants.js plus an
// xchain-e2e-test parity assertion, mirroring XCALL_MAX_HOPS) is a coordinated
// multi-repo addition; this test locks the hub side.
describe('oracle band constants conformance (#1299)', () => {

    it('PRICE_MAX has its pinned value', () => {
        expect(constants.PRICE_MAX).to.equal(10_000_000_000);
    });

    it('ORACLE_DEVIATION_THRESHOLD has its pinned value', () => {
        expect(constants.ORACLE_DEVIATION_THRESHOLD).to.equal(0.05);
    });

    // api.js sources the SLASH_DEVIATION_THRESHOLD default from
    // ORACLE_DEVIATION_THRESHOLD rather than re-declaring the 0.05 literal, so the
    // default string must equal the constant's string form. Guards against the two
    // drifting apart if either is edited in isolation.
    it('api.js default binds to the constant (String(ORACLE_DEVIATION_THRESHOLD) === "0.05")', () => {
        expect(String(constants.ORACLE_DEVIATION_THRESHOLD)).to.equal('0.05');
    });

    // #2490: ORACLE_MAX_CHANGE_PER_ROUND is a frozen 0.25 literal whose comment
    // (constants.js) documents the invariant that it is kept at 5x
    // ORACLE_DEVIATION_THRESHOLD so a clamped aggregate always passes the follower
    // propose-gate's historical band (OracleConsensus derives that band live as
    // 5 x ORACLE_DEVIATION_THRESHOLD). OracleConsensus.test.js already asserts the
    // one-sided `<= 5x` bound (the liveness-breaking direction). Pin strict equality
    // here so raise-direction drift of either constant, coordinated across tests and
    // docs, cannot silently strand the clamp above (or below) the band multiplier.
    it('ORACLE_MAX_CHANGE_PER_ROUND equals 5x ORACLE_DEVIATION_THRESHOLD (documented coupling)', () => {
        expect(constants.ORACLE_MAX_CHANGE_PER_ROUND).to.equal(5 * constants.ORACLE_DEVIATION_THRESHOLD);
    });
});
