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
// Slashing-parameter value shape: the change bounds refuse a non-decimal value, so an
// exponent or junk-suffix form cannot skip the ratio bound and a non-finite band never
// reaches a SlashDetector that refuses to construct on it.

const sinon      = require('sinon');
const { expect } = require('chai');
const Governance = require('../../../../src/validators/governance');
const { resolveDeviationThreshold } = require('../../../../src/validators/slash_detector/options.js');
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_3 }  = require('../../../helpers/fixtures');

const NON_DECIMAL_BANDS = ['abc', 'NaN', 'Infinity', '-Infinity', '', '5e-1', '5E-2', '0.9abc', '0x1'];

let gov;

function registerLocalGateTests() {
    it('refuses a non-decimal SLASH_DEVIATION_THRESHOLD proposal', function () {
        for (const v of NON_DECIMAL_BANDS)
            expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', v), v).to.throw(/plain decimal/);
    });

    it('refuses an exponent or junk-suffix SLASH_MISSED_ROUNDS_THRESHOLD proposal', function () {
        for (const v of ['3e1', '30abc'])
            expect(() => gov.validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', v), v).to.throw(/plain decimal/);
    });

    it('refuses a non-finite band at the floor when called on its own', function () {
        for (const v of ['abc', 'NaN', 'Infinity'])
            expect(() => gov.validateSlashBandFloor('SLASH_DEVIATION_THRESHOLD', v), v).to.throw(/not a valid number/);
    });

    it('bounds the echoed value in the refusal', function () {
        let junk = 'x'.repeat(10000);
        expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', junk))
            .to.throw().with.property('message').that.has.length.below(300);
    });

    it('still skips a non-decimal value for a non-slashing parameter', function () {
        expect(() => gov.validateChangeBounds('P', '0.05', '5e-1')).to.not.throw();
        expect(() => gov.validateChangeBounds('P', 'abc', 'def')).to.not.throw();
    });
}

function registerFollowerAndConsumerTests() {
    it('drops an inbound exponent-form band and keeps an in-bounds plain decimal', function () {
        expect(gov.inboundProposalBoundsHold('p1', 'SLASH_DEVIATION_THRESHOLD', '0.05', '5e-1')).to.equal(false);
        expect(gov.inboundProposalBoundsHold('p1', 'SLASH_DEVIATION_THRESHOLD', '0.05', '0.0625')).to.equal(true);
    });

    it('accepts only bands SlashDetector also constructs on', function () {
        for (const v of ['0.05', '0.0625', '0.06', 'abc', 'Infinity', 'NaN', '0.04', '0', '5e-1', '0.9abc']) {
            let accepted = true;
            try { gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', v); } catch (e) { accepted = false; }
            if (accepted) expect(() => resolveDeviationThreshold({ SLASH_DEVIATION_THRESHOLD: v }), v).to.not.throw();
        }
    });
}

describe('Governance: slashing-parameter value shape', function () {
    beforeEach(function () {
        let hub = createMockHub();
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        gov = new Governance(hub);
        gov.setValidatorSet(VALIDATORS_3);
    });
    afterEach(function () {
        if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        sinon.restore();
    });

    describe('the local change bounds', registerLocalGateTests);
    describe('the follower re-check and the consumer', registerFollowerAndConsumerTests);
});
