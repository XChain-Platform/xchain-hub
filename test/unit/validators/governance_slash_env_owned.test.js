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

const sinon      = require('sinon');
const { expect } = require('chai');
const Governance = require('../../../src/validators/governance');
const { createMockHub } = require('../../helpers/mockHub');
const { VALIDATORS_3 }  = require('../../helpers/fixtures');

describe('Governance: environment-owned slash thresholds', function () {
    let hub, gov;

    beforeEach(function () {
        hub = createMockHub();
        hub.getIdentity().getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        gov = new Governance(hub);
        gov.setValidatorSet(VALIDATORS_3);
    });

    afterEach(function () {
        sinon.restore();
    });

    for (const [parameter, currentValue, proposedValue] of [
        ['SLASH_DEVIATION_THRESHOLD', '0.05', '0.0625'],
        ['SLASH_MISSED_ROUNDS_THRESHOLD', '30', '24']
    ]) {
        it('refuses ' + parameter + ' because the env owns it', async function () {
            try {
                await gov.assertProposable(parameter, currentValue, proposedValue);
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include(parameter);
                expect(e.message).to.include('the env owns this parameter');
            }
        });
    }

    it('does not refuse slash penalty proposals', async function () {
        const parameter = 'SLASH_PENALTY:' + 'ab'.repeat(32) + ':' + 'cd'.repeat(32);
        const proposer = await gov.assertProposable(parameter, 'pending', 'suspend');

        expect(proposer).to.equal(VALIDATORS_3[0].pubkey);
    });
});
