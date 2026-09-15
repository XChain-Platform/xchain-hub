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

const sinon          = require('sinon');
const { expect }     = require('chai');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3 } = require('../helpers/fixtures');

// =================================================================
// Governance: Voter authorization
// =================================================================
function voterAuthorizationSuite() {
        const Governance = require('../../src/validators/governance');

        let hub, gov;

        beforeEach(function () {
            hub = createMockHub();
            gov = new Governance(hub);
            gov.setValidatorSet(VALIDATORS_3);
        });

        afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        });

        it('vote() throws when voter is not an active validator', async function () {
            hub._identity.getPubkeyHex.returns('ff'.repeat(32));
            hub.db.doQuery.resolves([{
                proposal_id: 'p1', status: 'voting',
                voting_end: new Date(Date.now() + 86400000).toISOString()
            }]);
            try {
                await gov.vote('p1', 'approve');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });

        it('vote() succeeds when voter is a validator', async function () {
            hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
            hub.db.doQuery
                .onFirstCall().resolves([{
                    proposal_id: 'p1', status: 'voting',
                    voting_end: new Date(Date.now() + 86400000).toISOString()
                }])
                .onSecondCall().resolves([]);
            let result = await gov.vote('p1', 'approve');
            expect(result.vote).to.equal('approve');
        });
    }

// =================================================================
// Governance: Length limits
// =================================================================
function governanceLengthSuite() {
        const Governance = require('../../src/validators/governance');

        let hub, gov;

        beforeEach(function () {
            hub = createMockHub();
            gov = new Governance(hub);
            gov.setValidatorSet(VALIDATORS_3);
            hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        });

        afterEach(function () {
            if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        });

        it('propose() throws when parameter name > 255 chars', async function () {
            try {
                await gov.propose('x'.repeat(256), '1', '2', 'rationale');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('255');
            }
        });

        it('propose() throws when rationale > 2000 chars', async function () {
            hub.db.doQuery.resolves([]);
            try {
                await gov.propose('SOME_PARAM', '1', '2', 'x'.repeat(2001));
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('2000');
            }
        });

        it('propose() accepts parameter name at 255 chars', async function () {
            hub.db.doQuery.resolves([]);
            let result = await gov.propose('x'.repeat(255), '100', '110', 'reason');
            expect(result).to.have.property('proposalId');
        });
    }

// =================================================================
// RewardTracker: Participant validation
// =================================================================
function rewardParticipantSuite() {
        const RewardTracker = require('../../src/anchor/reward_tracker');

        let hub, rt;

        beforeEach(function () {
            hub = createMockHub();
            hub.p2pConfig = { ORACLE_REWARD_PER_ROUND: '10.00000000' };
            rt = new RewardTracker(hub);
        });

        it('skips invalid pubkey formats', async function () {
            let participants = ['not-hex', '00'.repeat(32), 'zz'.repeat(32)];
            await rt.distributeRewards(1, participants);
            // Only '00'.repeat(32) is valid 64-hex
            expect(hub.db.doQuery.callCount).to.equal(1);
            expect(hub.db.doQuery.getCall(0).args[1][0]).to.equal('00'.repeat(32));
        });

        it('returns early with no valid participants', async function () {
            await rt.distributeRewards(1, ['not-hex', 'short']);
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('throws for invalid reward amount', async function () {
            rt.rewardPerRound = 'NaN';
            try {
                await rt.distributeRewards(1, ['00'.repeat(32)]);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid reward amount');
            }
        });

        it('throws for negative reward amount', async function () {
            rt.rewardPerRound = '-5';
            try {
                await rt.distributeRewards(1, ['00'.repeat(32)]);
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid reward amount');
            }
        });
    }

// =================================================================
// SlashDetector: Input validation
// =================================================================
function slashInputSuite() {
        const SlashDetector = require('../../src/validators/slash_detector');

        let hub, sd;

        beforeEach(function () {
            hub = createMockHub();
            hub.p2pConfig = { SLASH_DEVIATION_THRESHOLD: '0.05', SLASH_MISSED_ROUNDS_THRESHOLD: '30' };
            sd = new SlashDetector(hub);
        });

        it('skips slash proposal for invalid pubkey format', async function () {
            await sd.recordSlashProposal('invalid', 'price_deviation', 1, '{}');
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('records slash proposal for valid pubkey format', async function () {
            await sd.recordSlashProposal('aa'.repeat(32), 'price_deviation', 1, '{}');
            expect(hub.db.doQuery.callCount).to.equal(1);
        });

        it('bounds deviation tracking array per validator', function () {
            let pubkey = 'bb'.repeat(32);
            // Fill with 1001 deviations (all recent, within 24h)
            let deviations = [];
            for (let i = 0; i < 1001; i++) {
                deviations.push({ round: i, timestamp: Date.now() });
            }
            sd.recentDeviations.set(pubkey, deviations);
            sd.trackDeviation(pubkey, 1002);
            expect(sd.recentDeviations.get(pubkey).length).to.be.at.most(1000);
        });
    }

function securityHardeningSuite() {
    afterEach(function () {
        sinon.restore();
    });
    describe('Governance: Voter authorization', voterAuthorizationSuite);
    describe('Governance: Length limits', governanceLengthSuite);
    describe('RewardTracker: Participant validation', rewardParticipantSuite);
    describe('SlashDetector: Input validation', slashInputSuite);
}

describe('Security Hardening', securityHardeningSuite);
