'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon        = require('sinon');
const { expect }   = require('chai');
const Governance   = require('../../src/Governance');
const { createMockHub }   = require('../helpers/mockHub');
const { VALIDATORS_3 }    = require('../helpers/fixtures');

describe('Regression: Governance', function () {

    let hub, pm, identity, gov;

    beforeEach(function () {
        hub      = createMockHub();
        pm       = hub._peerManager;
        identity = hub._identity;
        identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        gov = new Governance(hub);
        gov.setValidatorSet(VALIDATORS_3);
    });

    afterEach(function () {
        if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // REG-GOV-001: Proposal lifecycle
    // -----------------------------------------------------------------

    describe('REG-GOV-001: Proposal lifecycle PROPOSE → VOTING → TALLY', function () {
        it('creates proposal and broadcasts GOV_PROPOSE @regression-p1', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])   // active check
                .onSecondCall().resolves([])   // cooldown check
                .onThirdCall().resolves();     // INSERT

            let result = await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '900000', 'Increase round time');
            expect(result.proposalId).to.include('gov:ORACLE_ROUND_INTERVAL:');
            expect(result.status).to.equal('voting');
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_PROPOSE');
        });

        it('throws when proposer is not a validator @regression-p1', async function () {
            identity.getPubkeyHex.returns('ff'.repeat(32));
            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });

        it('throws when active proposal exists @regression-p1', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]);
            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Active proposal already exists');
            }
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-002: Vote collection
    // -----------------------------------------------------------------

    describe('REG-GOV-002: Vote collection via GOV_VOTE', function () {
        it('records vote and broadcasts @regression-p1', async function () {
            hub.db.doQuery.onFirstCall().resolves([{
                proposal_id: 'gov:P:1', status: 'voting',
                voting_end: new Date(Date.now() + 86400000)
            }]);
            hub.db.doQuery.onSecondCall().resolves();

            let result = await gov.vote('gov:P:1', 'approve');
            expect(result.vote).to.equal('approve');
            expect(result.voter).to.equal(VALIDATORS_3[0].pubkey);
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_VOTE');
        });

        it('rejects invalid vote choice @regression-p1', async function () {
            try {
                await gov.vote('gov:P:1', 'maybe');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('approve');
            }
        });

        it('rejects vote when voting period ended @regression-p1', async function () {
            hub.db.doQuery.resolves([{
                proposal_id: 'gov:P:1', status: 'voting',
                voting_end: new Date(Date.now() - 1000)
            }]);
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('ended');
            }
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-003: Tally requires 2/3+ approval AND 50% quorum
    // -----------------------------------------------------------------

    describe('REG-GOV-003: Tally 2/3+ approval and 50% quorum', function () {
        it('passes with 2/3 approval and full quorum @regression-p0', async function () {
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[1].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[2].pubkey, vote: 'reject' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            let emitted = null;
            gov.on('proposal:finalized', (d) => { emitted = d; });

            await gov._tallyProposal({
                proposal_id: 'gov:P:1', parameter: 'P',
                current_value: '100', proposed_value: '120'
            });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('passed');
            expect(emitted).to.not.be.null;
        });

        it('fails with less than 2/3 approval @regression-p0', async function () {
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[1].pubkey, vote: 'reject' },
                { voter_pubkey: VALIDATORS_3[2].pubkey, vote: 'reject' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('failed');
        });

        it('fails when quorum not met (<50% participation) @regression-p0', async function () {
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('failed');
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-004: Parameter change bounds ±50% increase, ±33% decrease
    // -----------------------------------------------------------------

    describe('REG-GOV-004: Parameter change bounds (normal)', function () {
        it('allows 50% increase @regression-p0', function () {
            expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '150')).to.not.throw();
        });

        it('rejects 51% increase @regression-p0', function () {
            expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '151')).to.throw(/exceeds maximum/);
        });

        it('allows 33% decrease @regression-p0', function () {
            expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '67')).to.not.throw();
        });

        it('rejects 34% decrease @regression-p0', function () {
            expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '66')).to.throw(/exceeds maximum/);
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-005: Slashing param bounds ±25% increase, ±20% decrease
    // -----------------------------------------------------------------

    describe('REG-GOV-005: Slashing parameter bounds', function () {
        it('allows 25% increase for SLASH_DEVIATION_THRESHOLD @regression-p1', function () {
            expect(() => gov._validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.0625')).to.not.throw();
        });

        it('rejects 26% increase for SLASH_DEVIATION_THRESHOLD @regression-p1', function () {
            expect(() => gov._validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.063')).to.throw(/exceeds maximum/);
        });

        it('allows 20% decrease for SLASH_MISSED_ROUNDS_THRESHOLD @regression-p1', function () {
            expect(() => gov._validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', '24')).to.not.throw();
        });

        it('rejects 21% decrease for SLASH_MISSED_ROUNDS_THRESHOLD @regression-p1', function () {
            expect(() => gov._validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', '23')).to.throw(/exceeds maximum/);
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-006: 14-day cooldown on rejected parameters
    // -----------------------------------------------------------------

    describe('REG-GOV-006: 14-day cooldown after rejection', function () {
        it('throws when cooldown has not expired @regression-p1', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])
                .onSecondCall().resolves([{ voting_end: new Date() }]);

            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Cooldown');
            }
        });

        it('allows proposal when cooldown expired @regression-p1', async function () {
            let oldDate = new Date(Date.now() - 15 * 86400000);
            hub.db.doQuery
                .onFirstCall().resolves([])
                .onSecondCall().resolves([{ voting_end: oldDate }])
                .onThirdCall().resolves();

            let result = await gov.propose('P', '100', '120');
            expect(result.status).to.equal('voting');
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-007: Approved parameter applied
    // -----------------------------------------------------------------

    describe('REG-GOV-007: Tally broadcasts GOV_RESULT', function () {
        it('broadcasts result after tally @regression-p1', async function () {
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[1].pubkey, vote: 'approve' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_RESULT');
        });
    });

    // -----------------------------------------------------------------
    // REG-GOV-008: Edge cases
    // -----------------------------------------------------------------

    describe('REG-GOV-008: Edge cases', function () {
        it('skips validation for non-numeric values @regression-p2', function () {
            expect(() => gov._validateChangeBounds('P', 'abc', 'def')).to.not.throw();
        });

        it('skips validation when current value is 0 @regression-p2', function () {
            expect(() => gov._validateChangeBounds('P', '0', '100')).to.not.throw();
        });

        it('throws when no identity configured @regression-p2', async function () {
            hub.getIdentity.returns({ getPubkeyHex: () => null });
            let gov2 = new Governance(hub);
            gov2.setValidatorSet(VALIDATORS_3);

            try {
                await gov2.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('No validator identity');
            }
        });
    });

    // -----------------------------------------------------------------
    // P2P message handlers
    // -----------------------------------------------------------------

    describe('P2P message handlers', function () {
        it('_handlePropose stores proposal locally @regression-p2', function () {
            gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    rationale: 'test', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('INSERT IGNORE');
        });

        it('_handleVote stores vote locally @regression-p2', function () {
            gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: 'abc', signature: 'sig' }
            });
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('ignores messages with missing fields @regression-p2', function () {
            gov._handlePropose({ sender: 'peer', data: {} });
            gov._handleVote({ sender: 'peer', data: {} });
            gov._handleResult({ sender: 'peer', data: {} });
            expect(hub.db.doQuery.called).to.be.false;
        });
    });

    // Query methods
    describe('Query methods', function () {
        it('getProposals filters by status @regression-p2', async function () {
            hub.db.doQuery.resolves([]);
            await gov.getProposals('voting');
            expect(hub.db.doQuery.getCall(0).args[0]).to.include("status = ?");
        });

        it('getProposal returns proposal with votes @regression-p2', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ proposal_id: 'gov:P:1' }]);
            hub.db.doQuery.onSecondCall().resolves([{ voter_pubkey: 'abc', vote: 'approve' }]);

            let result = await gov.getProposal('gov:P:1');
            expect(result.proposal.proposal_id).to.equal('gov:P:1');
            expect(result.votes).to.have.lengthOf(1);
        });

        it('getProposal returns null when not found @regression-p2', async function () {
            hub.db.doQuery.resolves([]);
            let result = await gov.getProposal('gov:X:1');
            expect(result).to.be.null;
        });
    });
});
