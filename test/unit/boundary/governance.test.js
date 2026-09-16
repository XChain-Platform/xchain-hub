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

const sinon        = require('sinon');
const { expect }   = require('chai');
const Governance   = require('../../../src/validators/governance');
const { createMockHub }            = require('../../helpers/mockHub');
const { VALIDATORS_3, makeValidator } = require('../../helpers/fixtures');

let hub, pm, identity, gov;
function makeProposal(id) {
    return { proposal_id: id, parameter: 'SOME_PARAM', current_value: '100', proposed_value: '120' };
}
function makeVotes(approveCount, rejectCount) {
    // Assign each vote to a distinct CURRENT-set member so the
    // membership-filtered legacy tally (GOV-TALLY-DENOM-1) counts it.
    // Falls back to synthetic pubkeys when the set is empty (single-node
    // case, where the tally counts every recorded vote).
    let members = gov.validatorSet.map(v => String(v.pubkey).toLowerCase());
    let pk = i => (i < members.length ? members[i] : 'pub' + i);
    let votes = [];
    let idx = 0;
    for (let i = 0; i < approveCount; i++) votes.push({ voter_pubkey: pk(idx++), vote: 'approve' });
    for (let i = 0; i < rejectCount; i++) votes.push({ voter_pubkey: pk(idx++), vote: 'reject' });
    return votes;
}
async function tallyAndGetStatus(votes) {
    hub.db.doQuery
        .onFirstCall().resolves(votes)   // SELECT votes
        .onSecondCall().resolves([]);      // UPDATE proposal
    let proposal = makeProposal('prop-test');
    await gov.tallyProposal(proposal);
    // Second call is the UPDATE - first arg of args array is the SQL args array
    let updateArgs = hub.db.doQuery.secondCall.args[1];
    return updateArgs[0]; // newStatus is first bind param
}
function setupPropose(lastFailedVotingEnd) {
    hub.db.doQuery
        .onFirstCall().resolves([])                                    // no active voting proposal
        .onSecondCall().resolves([{ voting_end: lastFailedVotingEnd }]) // last failed proposal
        .onThirdCall().resolves([]);                                    // INSERT (if reached)
}

describe('Boundary: Governance', registerBoundaryGovernance);

function registerBoundaryGovernance() {
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
    // validateChangeBounds - normal parameters (MAX_INCREASE=50%, MAX_DECREASE=33%)
    describe('validateChangeBounds - normal parameters', registerValidateChangeBoundsNormalParameters);
    // validateChangeBounds - slashing parameters (MAX_SLASH_INCREASE=25%, MAX_SLASH_DECREASE=20%)
    describe('validateChangeBounds - slashing parameters', registerValidateChangeBoundsSlashingParameters);
    // validateChangeBounds - skip conditions
    describe('validateChangeBounds - skip conditions', registerValidateChangeBoundsSkipConditions);
    // tallyProposal - quorum and approval boundary cases
    //
    // Formula: quorum = totalVotes >= ceil(validatorCount / 2)
    //          passed = quorumMet && approvals >= ceil(validatorCount * 2 / 3)
    //          validatorCount = Math.max(validatorSet.length, 1)
    //
    // For each test:
    //   doQuery call 1 → returns votes array
    //   doQuery call 2 → UPDATE (resolves with [])
    //   We inspect the first argument of the UPDATE call to check status.
    describe('tallyProposal - quorum and approval boundary cases', registerTallyProposalQuorumAndApprovalBoundaryCases);
    // propose() - cooldown boundary conditions
    //
    // COOLDOWN_DAYS = 14. propose() checks the last failed proposal's
    // voting_end; if Date.now() < votingEnd + 14 days, it throws.
    describe('propose() - cooldown boundary', registerProposeCooldownBoundary);
}

function registerValidateChangeBoundsNormalParameters() {
    it('exactly 50% increase (100→150) - should NOT throw', testExactly50Increase100150ShouldNOTThrow);
    it('50.1% increase (100→150.1) - should throw', test501Increase1001501ShouldThrow);
    it('exactly 33% decrease (100→67) - should NOT throw', testExactly33Decrease10067ShouldNOTThrow);
    it('33.1% decrease (100→66.9) - should throw', test331Decrease100669ShouldThrow);
}
function testExactly50Increase100150ShouldNOTThrow() {
    expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '150')).to.not.throw();
}
function test501Increase1001501ShouldThrow() {
    expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '150.1')).to.throw(/exceeds maximum/);
}
function testExactly33Decrease10067ShouldNOTThrow() {
    // changeRatio = (67-100)/100 = -0.33, equals -MAX_DECREASE so not strictly less
    expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '67')).to.not.throw();
}
function test331Decrease100669ShouldThrow() {
    // changeRatio = (66.9-100)/100 = -0.331
    expect(() => gov.validateChangeBounds('SOME_PARAM', '100', '66.9')).to.throw(/exceeds maximum/);
}

function registerValidateChangeBoundsSlashingParameters() {
    it('SLASH_DEVIATION_THRESHOLD: exactly 25% increase - should NOT throw', testSLASHDEVIATIONTHRESHOLDExactly25IncreaseShouldNOTThrow);
    it('SLASH_DEVIATION_THRESHOLD: 25.1% increase - should throw', testSLASHDEVIATIONTHRESHOLD251IncreaseShouldThrow);
    it('SLASH_MISSED_ROUNDS_THRESHOLD: exactly 20% decrease - should NOT throw', testSLASHMISSEDROUNDSTHRESHOLDExactly20DecreaseShouldNOTThrow);
    it('SLASH_MISSED_ROUNDS_THRESHOLD: 20.1% decrease - should throw', testSLASHMISSEDROUNDSTHRESHOLD201DecreaseShouldThrow);
}
function testSLASHDEVIATIONTHRESHOLDExactly25IncreaseShouldNOTThrow() {
    expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '100', '125')).to.not.throw();
}
function testSLASHDEVIATIONTHRESHOLD251IncreaseShouldThrow() {
    expect(() => gov.validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '100', '125.1')).to.throw(/exceeds maximum/);
}
function testSLASHMISSEDROUNDSTHRESHOLDExactly20DecreaseShouldNOTThrow() {
    // changeRatio = (80-100)/100 = -0.20
    expect(() => gov.validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '100', '80')).to.not.throw();
}
function testSLASHMISSEDROUNDSTHRESHOLD201DecreaseShouldThrow() {
    // changeRatio = (79.9-100)/100 = -0.201
    expect(() => gov.validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '100', '79.9')).to.throw(/exceeds maximum/);
}

function registerValidateChangeBoundsSkipConditions() {
    it('currentValue="0" - skips validation (no throw)', testCurrentValue0SkipsValidationNoThrow);
    it('non-numeric values ("abc","def") - skips validation (no throw)', testNonNumericValuesAbcDefSkipsValidationNoThrow);
    it('negative current value - ratio inverts direction (increase from -100 to -50 is 50%)', testNegativeCurrentValueRatioInvertsDirectionIncreaseFrom100To50Is);
    it('very small values: 0.001→0.0015 (50% increase) - boundary math with floats', testVerySmallValues00010001550IncreaseBoundaryMathWith);
}
function testCurrentValue0SkipsValidationNoThrow() {
    // Division by zero guard: current === 0 → return early
    expect(() => gov.validateChangeBounds('SOME_PARAM', '0', '999')).to.not.throw();
}
function testNonNumericValuesAbcDefSkipsValidationNoThrow() {
    expect(() => gov.validateChangeBounds('SOME_PARAM', 'abc', 'def')).to.not.throw();
}
function testNegativeCurrentValueRatioInvertsDirectionIncreaseFrom100To50Is() {
    // changeRatio = (-50 - -100) / -100 = 50 / -100 = -0.50 → treated as decrease
    // -0.50 < -0.33 so this should throw for normal params
    expect(() => gov.validateChangeBounds('SOME_PARAM', '-100', '-50')).to.throw(/exceeds maximum/);
}
function testVerySmallValues00010001550IncreaseBoundaryMathWith() {
    // changeRatio = (0.0015 - 0.001) / 0.001 = 0.5 exactly
    expect(() => gov.validateChangeBounds('SOME_PARAM', '0.001', '0.0015')).to.not.throw();
}

function registerTallyProposalQuorumAndApprovalBoundaryCases() {
    it('empty validator set → validatorCount=1, single approve passes (quorum=1, approval=1)', testEmptyValidatorSetValidatorCount1SingleApprovePassesQuorum1Approval1);
    it('3 validators, 2 approve → passes (ceil(3*2/3)=2, quorum ceil(3/2)=2 met)', test3Validators2ApprovePassesCeil3232QuorumCeil);
    it('3 validators, 1 approve + 2 reject → fails', test3Validators1Approve2RejectFails);
    it('3 validators, 1 approve only → fails (quorum not met: 1 < ceil(3/2)=2)', test3Validators1ApproveOnlyFailsQuorumNotMet1Ceil3);
    it('4 validators, 2 approve + 1 reject → fails (need ceil(4*2/3)=3 approvals)', test4Validators2Approve1RejectFailsNeedCeil423);
    it('4 validators, 3 approve → passes', test4Validators3ApprovePasses);
    it('1 validator, 1 approve → passes (quorum=ceil(1/2)=1, approval=ceil(1*2/3)=1)', test1Validator1ApprovePassesQuorumCeil121ApprovalCeil);
}
async function testEmptyValidatorSetValidatorCount1SingleApprovePassesQuorum1Approval1() {
    gov.setValidatorSet([]);
    let status = await tallyAndGetStatus(makeVotes(1, 0));
    expect(status).to.equal('passed');
}
async function test3Validators2ApprovePassesCeil3232QuorumCeil() {
    gov.setValidatorSet(VALIDATORS_3);
    let status = await tallyAndGetStatus(makeVotes(2, 0));
    expect(status).to.equal('passed');
}
async function test3Validators1Approve2RejectFails() {
    gov.setValidatorSet(VALIDATORS_3);
    let status = await tallyAndGetStatus(makeVotes(1, 2));
    expect(status).to.equal('failed');
}
async function test3Validators1ApproveOnlyFailsQuorumNotMet1Ceil3() {
    gov.setValidatorSet(VALIDATORS_3);
    let status = await tallyAndGetStatus(makeVotes(1, 0));
    expect(status).to.equal('failed');
}
async function test4Validators2Approve1RejectFailsNeedCeil423() {
    gov.setValidatorSet([makeValidator(1), makeValidator(2), makeValidator(3), makeValidator(4)]);
    let status = await tallyAndGetStatus(makeVotes(2, 1));
    expect(status).to.equal('failed');
}
async function test4Validators3ApprovePasses() {
    gov.setValidatorSet([makeValidator(1), makeValidator(2), makeValidator(3), makeValidator(4)]);
    let status = await tallyAndGetStatus(makeVotes(3, 0));
    expect(status).to.equal('passed');
}
async function test1Validator1ApprovePassesQuorumCeil121ApprovalCeil() {
    gov.setValidatorSet([makeValidator(1)]);
    let status = await tallyAndGetStatus(makeVotes(1, 0));
    expect(status).to.equal('passed');
}

function registerProposeCooldownBoundary() {
    it('cooldown exactly expired (14 days + 1 ms ago) - allowed (no throw)', testCooldownExactlyExpired14Days1MsAgoAllowedNoThrow);
    it('cooldown not yet expired (failed 13 days ago) - blocked (throws)', testCooldownNotYetExpiredFailed13DaysAgoBlockedThrows);
}
async function testCooldownExactlyExpired14Days1MsAgoAllowedNoThrow() {
    let cooldownMs = 14 * 24 * 60 * 60 * 1000;
    // voting_end was 14 days + 1 ms ago → cooldownEnd = voting_end + 14d = 1 ms ago → expired
    let votingEnd = new Date(Date.now() - cooldownMs - 1);
    setupPropose(votingEnd.toISOString());

    let threw = false;
    try {
        await gov.propose('SOME_PARAM', '100', '120', 'rationale');
    } catch (e) {
        threw = true;
    }
    expect(threw).to.equal(false);
}
async function testCooldownNotYetExpiredFailed13DaysAgoBlockedThrows() {
    let thirteenDaysMs = 13 * 24 * 60 * 60 * 1000;
    // voting_end was 13 days ago → cooldownEnd = voting_end + 14d = 1 day from now → not expired
    let votingEnd = new Date(Date.now() - thirteenDaysMs);
    hub.db.doQuery
        .onFirstCall().resolves([])                                    // no active voting proposal
        .onSecondCall().resolves([{ voting_end: votingEnd.toISOString() }]); // last failed proposal

    let err = null;
    try {
        await gov.propose('SOME_PARAM', '100', '120', 'rationale');
    } catch (e) {
        err = e;
    }
    expect(err).to.be.an('error');
    expect(err.message).to.match(/Cooldown/);
}
