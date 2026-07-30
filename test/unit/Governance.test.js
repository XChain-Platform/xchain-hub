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
const Governance   = require('../../src/Governance');
const ValidatorIdentity = require('../../src/ValidatorIdentity');
const { createMockHub }   = require('../helpers/mockHub');
const { VALIDATORS_3 }    = require('../helpers/fixtures');

describe('Governance', function () {

    let hub, pm, identity, gov;

    beforeEach(function () {
        hub      = createMockHub();
        pm       = hub._peerManager;
        identity = hub._identity;
        // Set the identity pubkey to match a validator
        identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        gov = new Governance(hub);
        gov.setValidatorSet(VALIDATORS_3);
    });

    afterEach(function () {
        if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _validateChangeBounds()
    // -----------------------------------------------------------------

    describe('_validateChangeBounds()', function () {

        describe('normal parameters', function () {
            it('allows 50% increase', function () {
                expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '150')).to.not.throw();
            });

            it('rejects 51% increase', function () {
                expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '151')).to.throw(/exceeds maximum/);
            });

            it('allows 33% decrease', function () {
                expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '67')).to.not.throw();
            });

            it('rejects 34% decrease', function () {
                expect(() => gov._validateChangeBounds('SOME_PARAM', '100', '66')).to.throw(/exceeds maximum/);
            });

            it('allows exact boundary increase (50%)', function () {
                expect(() => gov._validateChangeBounds('P', '200', '300')).to.not.throw();
            });

            it('allows exact boundary decrease (33%)', function () {
                // 100 → 67 is -33%. 100 * 0.33 = 33, so 67 is exactly -33%
                expect(() => gov._validateChangeBounds('P', '100', '67')).to.not.throw();
            });
        });

        describe('slashing parameters', function () {
            it('allows 25% increase for SLASH_DEVIATION_THRESHOLD', function () {
                expect(() => gov._validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.0625')).to.not.throw();
            });

            it('rejects 26% increase for SLASH_DEVIATION_THRESHOLD', function () {
                expect(() => gov._validateChangeBounds('SLASH_DEVIATION_THRESHOLD', '0.05', '0.063')).to.throw(/exceeds maximum/);
            });

            it('allows 20% decrease for SLASH_MISSED_ROUNDS_THRESHOLD', function () {
                expect(() => gov._validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', '24')).to.not.throw();
            });

            it('rejects 21% decrease for SLASH_MISSED_ROUNDS_THRESHOLD', function () {
                expect(() => gov._validateChangeBounds('SLASH_MISSED_ROUNDS_THRESHOLD', '30', '23')).to.throw(/exceeds maximum/);
            });
        });

        describe('edge cases', function () {
            it('skips validation for non-numeric values', function () {
                expect(() => gov._validateChangeBounds('P', 'abc', 'def')).to.not.throw();
            });

            it('skips validation when current value is 0', function () {
                expect(() => gov._validateChangeBounds('P', '0', '100')).to.not.throw();
            });

            it('treats null / undefined values as non-numeric and skips', function () {
                expect(() => gov._validateChangeBounds('P', null, '100')).to.not.throw();
                expect(() => gov._validateChangeBounds('P', '100', undefined)).to.not.throw();
            });

            it('parses an explicit + sign', function () {
                expect(() => gov._validateChangeBounds('P', '+100', '+120')).to.not.throw();
            });

            it('parses a leading-dot fraction (empty integer part)', function () {
                expect(() => gov._validateChangeBounds('P', '.5', '.6')).to.not.throw();
            });

            it('enforces bounds when the current value is negative', function () {
                // C=-100: a move to -160 is a 60% magnitude increase → exceeds.
                expect(() => gov._validateChangeBounds('P', '-100', '-160')).to.throw(/exceeds maximum/);
                // A small move stays within bounds.
                expect(() => gov._validateChangeBounds('P', '-100', '-120')).to.not.throw();
            });
        });
    });

    // -----------------------------------------------------------------
    // propose()
    // -----------------------------------------------------------------

    describe('propose()', function () {

        it('creates a proposal and broadcasts', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])   // active check
                .onSecondCall().resolves([])   // cooldown check
                .onThirdCall().resolves();     // INSERT

            let result = await gov.propose('ORACLE_ROUND_INTERVAL', '600000', '900000', 'Increase round time');
            expect(result.proposalId).to.include('gov:ORACLE_ROUND_INTERVAL:');
            expect(result.status).to.equal('voting');
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_PROPOSE');
            // Non-capability parameters carry no activation block.
            expect(result.activationBlock).to.equal(null);
            expect(pm.broadcast.getCall(0).args[1].activationBlock).to.equal(null);
        });

        // ── Block-anchored activation (#3703 / #3685) ─────────────────────────
        // CAPABILITY_*_MIN_STAKE governance is pinned off pre-launch (#4352), so the
        // activation-computation path is exercised here via ATTESTATION_PROVIDER:* params,
        // which are also block-anchored (#3685) and NOT pinned.
        it('computes a block-anchored activation for a block-anchored proposal', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]).onThirdCall().resolves();
            hub._latestBlockIndex = 500;
            gov.votingPeriod = 604800000; // 7 days → ceil(/600000) = 1008 blocks
            let result = await gov.propose('ATTESTATION_PROVIDER:llm', '10000', '12000');
            // 500 (latest) + 1008 (voting period in blocks) + 50 (safety buffer)
            expect(result.activationBlock).to.equal(1558);
            let payload = pm.broadcast.getCall(0).args[1];
            expect(payload.activationBlock).to.equal(1558);
        });

        it('rejects an explicit activation block that is too soon', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = 500;
            gov.votingPeriod = 604800000;
            try {
                await gov.propose('ATTESTATION_PROVIDER:llm', '10000', '12000', null, 600);
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('too soon');
            }
        });

        it('throws when anchoring a block-anchored change with no observed block height', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = null;
            try {
                await gov.propose('ATTESTATION_PROVIDER:llm', '10000', '12000');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('no observed block height');
            }
        });

        // ── Pre-launch MIN_STAKE governance pin (#4352) ───────────────────────
        it('refuses to create a CAPABILITY_*_MIN_STAKE proposal (pinned pre-launch)', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = 500;
            try {
                await gov.propose('CAPABILITY_PRICE_MIN_STAKE', '10000', '11000');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('disabled pre-launch');
            }
            // No proposal row was inserted (the INSERT is the 3rd doQuery; only the 2 pre-checks ran).
            expect(pm.broadcast.called).to.equal(false);
        });

        it('throws when no identity configured', async function () {
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

        it('throws when proposer is not a validator', async function () {
            identity.getPubkeyHex.returns('ff'.repeat(32)); // Not in validator set
            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });

        it('throws when active proposal exists for same parameter', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]); // active proposal found

            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Active proposal already exists');
            }
        });

        it('throws when cooldown has not expired', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])  // no active
                .onSecondCall().resolves([{ voting_end: new Date() }]); // recent rejection

            try {
                await gov.propose('P', '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Cooldown');
            }
        });

        it('allows proposal when cooldown has expired', async function () {
            let oldDate = new Date(Date.now() - 15 * 86400000); // 15 days ago
            hub.db.doQuery
                .onFirstCall().resolves([])
                .onSecondCall().resolves([{ voting_end: oldDate }])
                .onThirdCall().resolves();

            let result = await gov.propose('P', '100', '120');
            expect(result.status).to.equal('voting');
        });

        it('throws when change bounds are violated', async function () {
            hub.db.doQuery
                .onFirstCall().resolves([])
                .onSecondCall().resolves([]);

            try {
                await gov.propose('P', '100', '200'); // 100% increase
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('exceeds maximum');
            }
        });

        it('rejects a parameter name longer than 255 characters', async function () {
            try {
                await gov.propose('P'.repeat(256), '1', '2');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('255');
            }
        });

        it('rejects a rationale longer than 2000 characters', async function () {
            try {
                await gov.propose('P', '1', '2', 'x'.repeat(2001));
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('2000');
            }
        });
    });

    // -----------------------------------------------------------------
    // vote()
    // -----------------------------------------------------------------

    describe('vote()', function () {

        it('records a vote and broadcasts', async function () {
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

        it('throws on invalid vote choice', async function () {
            try {
                await gov.vote('gov:P:1', 'maybe');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('approve');
            }
        });

        it('throws when proposal not found', async function () {
            hub.db.doQuery.resolves([]);
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not found');
            }
        });

        it('throws when voting period has ended', async function () {
            hub.db.doQuery.resolves([{
                proposal_id: 'gov:P:1', status: 'voting',
                voting_end: new Date(Date.now() - 1000) // already ended
            }]);
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('ended');
            }
        });

        it('throws when no validator identity is configured', async function () {
            hub.getIdentity.returns({ getPubkeyHex: () => null });
            let gov2 = new Governance(hub);
            gov2.setValidatorSet(VALIDATORS_3);
            try {
                await gov2.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('No validator identity');
            }
        });

        it('throws when the voter is not an active validator', async function () {
            identity.getPubkeyHex.returns('ff'.repeat(32)); // not in the set
            try {
                await gov.vote('gov:P:1', 'approve');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('not an active validator');
            }
        });
    });

    // -----------------------------------------------------------------
    // _handleResult(): followers must apply a passed proposal too
    // -----------------------------------------------------------------

    describe('_handleResult()', function () {

        // Authenticated GOV_RESULT comes only from the proposal's deterministic tally
        // leader, after voting_end. Call order is now: SELECT voting_end → UPDATE → SELECT row.
        const PAST = '2020-01-01T00:00:00Z';                  // voting_end already elapsed
        const leaderAddr = () => gov._getProposalLeader('gov:P:1').addr;

        it('emits proposal:finalized on a passed status transition (affectedRows > 0)', async function () {
            hub.db.doQuery.onCall(0).resolves([{ voting_end: PAST }]);    // SELECT voting_end
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });       // UPDATE: voting → passed
            hub.db.doQuery.onCall(2).resolves([                           // SELECT proposal row
                { parameter: 'CAPABILITY_PRICE_MIN_STAKE', current_value: '100', proposed_value: '200' }
            ]);
            let emitted = null;
            gov.on('proposal:finalized', (d) => { emitted = d; });

            await gov._handleResult({ sender: leaderAddr(), data: { proposalId: 'gov:P:1', status: 'passed' } });

            expect(emitted).to.not.be.null;
            expect(emitted.proposalId).to.equal('gov:P:1');
            expect(emitted.parameter).to.equal('CAPABILITY_PRICE_MIN_STAKE');
            expect(emitted.oldValue).to.equal('100');
            expect(emitted.newValue).to.equal('200');
        });

        it('does NOT emit when already finalized (affectedRows = 0, tally-leader loopback)', async function () {
            hub.db.doQuery.onCall(0).resolves([{ voting_end: PAST }]);
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 0 });
            let emitted = false;
            gov.on('proposal:finalized', () => { emitted = true; });
            await gov._handleResult({ sender: leaderAddr(), data: { proposalId: 'gov:P:1', status: 'passed' } });
            expect(emitted).to.be.false;
        });

        it('does NOT emit for a failed proposal', async function () {
            hub.db.doQuery.onCall(0).resolves([{ voting_end: PAST }]);
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });
            let emitted = false;
            gov.on('proposal:finalized', () => { emitted = true; });
            await gov._handleResult({ sender: leaderAddr(), data: { proposalId: 'gov:P:1', status: 'failed' } });
            expect(emitted).to.be.false;
        });

        // --- authentication (the #3704 fix): only the tally leader, only after voting_end ---

        it('DROPS a result from a non-leader validator (no DB write, no split-brain)', async function () {
            let notLeader = VALIDATORS_3.find(v => v.addr !== leaderAddr()).addr;
            let emitted = false;
            gov.on('proposal:finalized', () => { emitted = true; });
            await gov._handleResult({ sender: notLeader, data: { proposalId: 'gov:P:1', status: 'passed' } });
            expect(hub.db.doQuery.called).to.be.false;   // never reaches the voting_end SELECT / UPDATE
            expect(emitted).to.be.false;
        });

        it('DROPS a result that arrives before voting_end (spurious early finalize)', async function () {
            hub.db.doQuery.onCall(0).resolves([{ voting_end: '2999-01-01T00:00:00Z' }]); // not yet ended
            let emitted = false;
            gov.on('proposal:finalized', () => { emitted = true; });
            await gov._handleResult({ sender: leaderAddr(), data: { proposalId: 'gov:P:1', status: 'passed' } });
            expect(hub.db.doQuery.callCount).to.equal(1);  // only the voting_end SELECT; no UPDATE
            expect(emitted).to.be.false;
        });

        it('DROPS a result for a proposal this hub never saw (no local row)', async function () {
            hub.db.doQuery.onCall(0).resolves([]);          // no proposal row
            await gov._handleResult({ sender: leaderAddr(), data: { proposalId: 'gov:P:1', status: 'passed' } });
            expect(hub.db.doQuery.callCount).to.equal(1);   // SELECT only, no UPDATE
        });
    });

    // -----------------------------------------------------------------
    // _tallyProposal()
    // -----------------------------------------------------------------

    describe('_tallyProposal()', function () {

        it('passes with 2/3+ approval and quorum met', async function () {
            gov.setValidatorSet(VALIDATORS_3);

            // 3 validators, 2 approve, 1 rejects → 2/3 approve, 100% participation
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[1].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[2].pubkey, vote: 'reject' }
            ]);
            hub.db.doQuery.onSecondCall().resolves({ affectedRows: 1 }); // UPDATE (status transition landed)

            let emitted = null;
            gov.on('proposal:finalized', (d) => { emitted = d; });

            await gov._tallyProposal({
                proposal_id: 'gov:P:1', parameter: 'P',
                current_value: '100', proposed_value: '120'
            });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('passed');
            expect(emitted).to.not.be.null;
            expect(emitted.proposalId).to.equal('gov:P:1');
        });

        it('fails with less than 2/3 approval', async function () {
            gov.setValidatorSet(VALIDATORS_3);

            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[1].pubkey, vote: 'reject' },
                { voter_pubkey: VALIDATORS_3[2].pubkey, vote: 'reject' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            let emitted = false;
            gov.on('proposal:finalized', () => { emitted = true; });

            await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('failed');
            expect(emitted).to.be.false;
        });

        it('fails when quorum not met (less than 50% participation)', async function () {
            gov.setValidatorSet(VALIDATORS_3);

            // Only 1 of 3 voted, below 50% quorum
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('failed');
        });

        it('broadcasts GOV_RESULT after tally', async function () {
            gov.setValidatorSet(VALIDATORS_3);
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' },
                { voter_pubkey: VALIDATORS_3[1].pubkey, vote: 'approve' }
            ]);
            hub.db.doQuery.onSecondCall().resolves({ affectedRows: 1 });

            await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_RESULT');
        });
    });

    // -----------------------------------------------------------------
    // Query methods
    // -----------------------------------------------------------------

    describe('getProposals()', function () {
        it('queries with status filter', async function () {
            hub.db.doQuery.resolves([]);
            await gov.getProposals('voting');
            expect(hub.db.doQuery.getCall(0).args[0]).to.include("status = ?");
        });

        it('queries without status filter', async function () {
            hub.db.doQuery.resolves([]);
            await gov.getProposals();
            expect(hub.db.doQuery.getCall(0).args[0]).to.not.include("status = ?");
        });
    });

    describe('getProposal()', function () {
        it('returns proposal with votes', async function () {
            hub.db.doQuery.onFirstCall().resolves([{ proposal_id: 'gov:P:1' }]);
            hub.db.doQuery.onSecondCall().resolves([{ voter_pubkey: 'abc', vote: 'approve' }]);

            let result = await gov.getProposal('gov:P:1');
            expect(result.proposal.proposal_id).to.equal('gov:P:1');
            expect(result.votes).to.have.lengthOf(1);
        });

        it('returns null when not found', async function () {
            hub.db.doQuery.resolves([]);
            let result = await gov.getProposal('gov:X:1');
            expect(result).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // P2P message handlers
    // -----------------------------------------------------------------

    describe('P2P message handlers', function () {
        it('_handlePropose stores proposal locally', async function () {
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    rationale: 'test', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT IGNORE/))).to.be.true;
        });

        it('_handlePropose IGNORES a far-future wire votingEnd and recomputes voting_end locally (GOV-VOTINGEND-FORGE-1)', async function () {
            // A single Byzantine validator sets votingEnd to year 3000: if trusted, the row's
            // voting_end never reaches NOW(), so it is never tallied, never leaves 'voting', and
            // propose() then refuses every honest proposal for 'P' forever (permanent censorship).
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    rationale: 'censor', proposerPubkey: 'abc',
                    votingEnd: '3000-01-01T00:00:00Z'
                }
            });
            let insert = hub.db.doQuery.getCalls().find(c => /INSERT IGNORE/.test(c.args[0]));
            expect(insert, 'INSERT IGNORE issued').to.not.be.undefined;
            let persistedVotingEnd = new Date(insert.args[1][6]).getTime();
            let expected = Date.now() + gov.votingPeriod;
            // Locally recomputed to ~now + votingPeriod, NOT the year-3000 wire value.
            expect(Math.abs(persistedVotingEnd - expected)).to.be.lessThan(10000);
        });

        it('_handlePropose DROPS an inbound CAPABILITY_*_MIN_STAKE proposal (pinned #4352)', function () {
            gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:CAPABILITY_PRICE_MIN_STAKE:1', parameter: 'CAPABILITY_PRICE_MIN_STAKE',
                    currentValue: '10000', proposedValue: '25000',
                    rationale: 'raise', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString(), activationBlock: 1000
                }
            });
            // No INSERT issued: this hub never records or votes on a pinned MIN_STAKE proposal.
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('_handlePropose DROPS an inbound out-of-bounds numeric proposal (change-bounds guard)', function () {
            // 100 -> 200 is +100%, over the +50% MAX_INCREASE. propose() rejects it
            // locally; a Byzantine peer that skips propose() and broadcasts the raw
            // GOV_PROPOSE must not get every hub to record and vote on it.
            gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '200',
                    rationale: 'drain', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('_handlePropose persists an inbound non-numeric proposal (bounds guard is a no-op there)', async function () {
            // The bounds check only applies to numeric parameters; a non-numeric
            // change must still be recorded so it can be voted on.
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:MODE:1', parameter: 'MODE',
                    currentValue: 'fast', proposedValue: 'slow',
                    rationale: 'switch', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT IGNORE/))).to.be.true;
        });

        it('_handlePropose DROPS an inbound proposal for a parameter still in re-proposal cooldown (#12)', async function () {
            // A Byzantine validator skips propose() (which enforces the cooldown) and
            // broadcasts a raw GOV_PROPOSE for a parameter whose last proposal FAILED
            // 1 day ago (cooldown is 14 days). The follower must re-enforce the cooldown
            // and never record it, matching the leader-side propose() guard.
            hub.db.doQuery.withArgs(sinon.match(/status = 'failed'/))
                .resolves([{ voting_end: new Date(Date.now() - 86400000) }]); // 1 day ago
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    rationale: 're-spam', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT IGNORE/)),
                'no proposal recorded while parameter is in cooldown').to.be.false;
        });

        it('_handlePropose ADMITS an inbound proposal once the re-proposal cooldown has expired (#12)', async function () {
            // Last failure was 15 days ago (> 14-day cooldown): the proposal is admitted.
            hub.db.doQuery.withArgs(sinon.match(/status = 'failed'/))
                .resolves([{ voting_end: new Date(Date.now() - 15 * 86400000) }]);
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    rationale: 'legit re-propose', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT IGNORE/)),
                'proposal recorded after cooldown expiry').to.be.true;
        });

        it('_handlePropose proceeds (fail-open) when the cooldown re-check DB read errors (#12)', async function () {
            // A transient DB error on the cooldown SELECT must not drop an otherwise
            // valid honest proposal; fail open and still record it.
            hub.db.doQuery.withArgs(sinon.match(/status = 'failed'/)).rejects(new Error('db down'));
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    rationale: 'legit', proposerPubkey: 'abc',
                    votingEnd: new Date().toISOString()
                }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT IGNORE/)),
                'proposal recorded despite cooldown-read failure').to.be.true;
        });

        it('_handleVote persists a registered validator vote with a valid signature (proposal still open)', async function () {
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            // Proposal-open lookup (GOV-LATEVOTE-1 guard) resolves to a future voting_end.
            hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
                .resolves([{ voting_end: new Date(Date.now() + 86400000) }]);
            let sig = idn.sign(Governance.voteSigningPayload('gov:P:1', 'approve', kp.pubkeyHex, 1000));
            await gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT INTO governance_votes/)),
                'the vote row is inserted').to.be.true;
        });

        it('_handleVote DROPS a validly-signed vote whose proposal window has closed (GOV-LATEVOTE-1)', async function () {
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            // The proposal is still 'voting' but voting_end has already elapsed: the honest
            // vote() path refuses this; the gossip path must too, or a post-close vote is tallied.
            hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
                .resolves([{ voting_end: new Date(Date.now() - 1000) }]);
            let sig = idn.sign(Governance.voteSigningPayload('gov:P:1', 'approve', kp.pubkeyHex, 1000));
            await gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT INTO governance_votes/)),
                'no vote row inserted for a closed proposal').to.be.false;
        });

        it('_handleVote DROPS a validly-signed vote for a proposal this hub never recorded (GOV-LATEVOTE-1)', async function () {
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/)).resolves([]);
            let sig = idn.sign(Governance.voteSigningPayload('gov:GHOST:1', 'approve', kp.pubkeyHex, 1000));
            await gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:GHOST:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT INTO governance_votes/)),
                'no vote row inserted with no local proposal').to.be.false;
        });

        it('_handleVote REJECTS a vote whose voterPubkey is not a registered validator (C-1 vote-stuffing guard)', function () {
            // Valid signature, but the pubkey is a fabricated non-member: the exact
            // primitive a Byzantine validator would use to stuff N invented voters.
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            let sig = idn.sign(Governance.voteSigningPayload('gov:P:1', 'approve', kp.pubkeyHex, 1000));
            gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('_handleVote REJECTS a registered validator vote with a forged signature', function () {
            let kp = ValidatorIdentity.generate();
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: 'deadbeef' }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('_handlePropose defaults a missing proposerPubkey and rationale to empty strings', async function () {
            await gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    votingEnd: new Date().toISOString()
                }
            });
            let insert = hub.db.doQuery.getCalls().find(c => /INSERT IGNORE/.test(c.args[0]));
            expect(insert, 'INSERT IGNORE issued').to.not.be.undefined;
            let args = insert.args[1];
            expect(args[1]).to.equal(''); // proposer_pubkey
            expect(args[5]).to.equal(''); // rationale
        });

        it('_handleVote REJECTS an unsigned vote (no signature to authenticate the voter)', function () {
            let kp = ValidatorIdentity.generate();
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('_handleResult updates proposal status (from the tally leader, post voting_end)', async function () {
            hub.db.doQuery.onCall(0).resolves([{ voting_end: '2020-01-01T00:00:00Z' }]); // SELECT voting_end
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });                       // UPDATE
            await gov._handleResult({
                sender: gov._getProposalLeader('gov:P:1').addr, type: 'GOV_RESULT',
                data: { proposalId: 'gov:P:1', status: 'passed' }
            });
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('voting_end');
            expect(hub.db.doQuery.getCall(1).args[0]).to.include('UPDATE');
        });

        it('ignores messages with missing fields', function () {
            gov._handlePropose({ sender: 'peer', data: {} });
            gov._handleVote({ sender: 'peer', data: {} });
            gov._handleResult({ sender: 'peer', data: {} });
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('_handleMessage routes each governance message type and ignores unknown', function () {
            let p = sinon.spy(gov, '_handlePropose');
            let v = sinon.spy(gov, '_handleVote');
            let r = sinon.spy(gov, '_handleResult');
            gov._handleMessage({ type: 'GOV_PROPOSE', data: {} });
            gov._handleMessage({ type: 'GOV_VOTE', data: {} });
            gov._handleMessage({ type: 'GOV_RESULT', data: {} });
            expect(() => gov._handleMessage({ type: 'NOPE', data: {} })).to.not.throw();
            expect(p.calledOnce).to.be.true;
            expect(v.calledOnce).to.be.true;
            expect(r.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------

    describe('start() / stop()', function () {
        it('start() subscribes and schedules the tally timer; stop() tears both down', async function () {
            let clock = sinon.useFakeTimers();
            gov.tallyInterval = 1000;
            let spy = sinon.spy(gov, '_checkExpiredProposals');
            await gov.start();
            expect(pm.listenerCount('message')).to.equal(1);
            expect(gov._tallyTimer).to.not.equal(null);

            clock.tick(1001);
            expect(spy.called).to.be.true;

            await gov.stop();
            expect(gov._messageHandler).to.equal(null);
            expect(gov._tallyTimer).to.equal(null);
            expect(pm.listenerCount('message')).to.equal(0);
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // Tally leadership
    // -----------------------------------------------------------------

    describe('tally leadership', function () {
        it('_getProposalLeader returns null for an empty validator set', function () {
            gov.setValidatorSet([]);
            expect(gov._getProposalLeader('gov:P:1')).to.be.null;
        });

        it('_getProposalLeader is deterministic and drawn from the validator set', function () {
            gov.setValidatorSet(VALIDATORS_3);
            let l1 = gov._getProposalLeader('gov:P:1');
            let l2 = gov._getProposalLeader('gov:P:1');
            expect(l1).to.equal(l2);
            expect(VALIDATORS_3).to.include(l1);
        });

        it('_isTallyLeader is true in standalone mode (no validator set)', function () {
            gov.setValidatorSet([]);
            expect(gov._isTallyLeader('gov:P:1')).to.be.true;
        });

        it('_isTallyLeader is true when this node is the designated leader', function () {
            gov.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = gov._getProposalLeader('gov:P:1').addr;
            expect(gov._isTallyLeader('gov:P:1')).to.be.true;
        });

        it('_isTallyLeader is false when another node is the leader', function () {
            gov.setValidatorSet(VALIDATORS_3);
            let leader = gov._getProposalLeader('gov:P:1');
            let other = VALIDATORS_3.find(v => v.addr !== leader.addr);
            pm.validatorAddr = other.addr;
            expect(gov._isTallyLeader('gov:P:1')).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _checkExpiredProposals()
    // -----------------------------------------------------------------

    describe('_checkExpiredProposals()', function () {
        it('tallies an expired proposal when this node leads it', async function () {
            gov.setValidatorSet([]); // standalone → always leader
            hub.db.doQuery.onFirstCall().resolves([
                { proposal_id: 'gov:P:1', parameter: 'P', current_value: '100', proposed_value: '120' }
            ]);
            let tally = sinon.stub(gov, '_tallyProposal').resolves();
            await gov._checkExpiredProposals();
            expect(tally.calledOnce).to.be.true;
            expect(tally.getCall(0).args[0].proposal_id).to.equal('gov:P:1');
        });

        it('skips proposals led by another node', async function () {
            gov.setValidatorSet(VALIDATORS_3);
            let leader = gov._getProposalLeader('gov:P:1');
            pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
            hub.db.doQuery.onFirstCall().resolves([{ proposal_id: 'gov:P:1' }]);
            let tally = sinon.stub(gov, '_tallyProposal').resolves();
            await gov._checkExpiredProposals();
            expect(tally.called).to.be.false;
        });

        it('logs and returns without crashing when the SELECT throws', async function () {
            hub.db.doQuery.onFirstCall().rejects(new Error('schema drift'));
            let tally = sinon.stub(gov, '_tallyProposal').resolves();
            await gov._checkExpiredProposals(); // must not throw
            expect(tally.called).to.be.false;
        });

        it('continues past a proposal whose tally throws', async function () {
            gov.setValidatorSet([]); // always leader
            hub.db.doQuery.onFirstCall().resolves([
                { proposal_id: 'gov:A' }, { proposal_id: 'gov:B' }
            ]);
            let tally = sinon.stub(gov, '_tallyProposal');
            tally.onFirstCall().rejects(new Error('boom'));
            tally.onSecondCall().resolves();
            await gov._checkExpiredProposals();
            expect(tally.callCount).to.equal(2); // did not abort after the first error
        });
    });
});

// -----------------------------------------------------------------
// R2-M2 (snapshot-locked electorate) + R2-H2 (follower local re-tally)
// -----------------------------------------------------------------
describe('Governance: R2-M2 snapshot-lock + R2-H2 re-tally', function () {

    let hub, gov, kps, valset, snapshotJson;

    // Three real-keyed validators so votes carry verifiable ed25519 signatures
    // and _getProposalLeader resolves to a known addr.
    beforeEach(function () {
        hub = createMockHub();
        kps = [0, 1, 2].map(() => {
            let kp = ValidatorIdentity.generate();
            return { priv: new ValidatorIdentity(kp.privkeyHex), pubkey: kp.pubkeyHex.toLowerCase() };
        });
        valset = kps.map((k, i) => ({ pubkey: k.pubkey, addr: 'ws://v' + i + ':1' }));
        gov = new Governance(hub);
        gov.setValidatorSet(valset);
        snapshotJson = JSON.stringify(
            valset.map(v => ({ pubkey: v.pubkey, addr: v.addr }))
                  .sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1))
        );
    });
    afterEach(function () {
        if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        sinon.restore();
    });

    // GOV-VOTE-REPLAY-1: sign through the PRODUCTION payload builder so drift
    // between the bytes signed here and in src/ fails these tests instead of
    // hiding behind a locally rebuilt copy. seq defaults to a fixed positive
    // value; the replay tests pass it explicitly.
    function signedVote(kp, proposalId, vote, seq = 1000) {
        let sig = kp.priv.sign(Governance.voteSigningPayload(proposalId, vote, kp.pubkey, seq));
        return { voterPubkey: kp.pubkey, vote, signature: sig, seq };
    }

    // ---- R2-M2 snapshot build/validate helpers ----

    it('_buildValidatorSnapshot returns a pubkey-sorted {pubkey,addr} array', function () {
        let snap = gov._buildValidatorSnapshot();
        expect(snap).to.have.length(3);
        expect(snap.map(e => e.pubkey)).to.deep.equal(valset.map(v => v.pubkey).sort());
    });

    it('_parseSnapshot rejects malformed / oversized / duplicate-pubkey snapshots', function () {
        expect(gov._parseSnapshot(null)).to.equal(null);
        expect(gov._parseSnapshot('not json')).to.equal(null);
        expect(gov._parseSnapshot('[]')).to.equal(null);
        expect(gov._parseSnapshot(JSON.stringify([{ pubkey: 'aa' }, { pubkey: 'aa' }]))).to.equal(null);
        expect(gov._parseSnapshot(JSON.stringify([{ addr: 'x' }]))).to.equal(null); // no pubkey
    });

    it('_snapshotMatchesLocalSet is exact-set: rejects a self-only shrink and a superset', function () {
        let full = gov._parseSnapshot(snapshotJson);
        expect(gov._snapshotMatchesLocalSet(full)).to.equal(true);
        let selfOnly = [{ pubkey: kps[0].pubkey, addr: 'x' }];
        expect(gov._snapshotMatchesLocalSet(selfOnly)).to.equal(false);
        let superset = full.concat([{ pubkey: 'ff'.repeat(32), addr: 'y' }]);
        expect(gov._snapshotMatchesLocalSet(superset)).to.equal(false);
    });

    // ---- GOV-TALLY-DENOM-1: legacy tally re-filters the numerator by membership ----

    it('_computeTally (legacy, null electorate) excludes votes from validators no longer in the set (GOV-TALLY-DENOM-1)', function () {
        // A vote from a current member (kps[0]) and one from a departed validator
        // (not in the live set) are both recorded. The legacy path must count only
        // the current member so the numerator matches the current-set denominator;
        // otherwise an ex-member's stale vote inflates approvals against a
        // denominator that no longer includes them.
        let departed = 'cd'.repeat(32);
        let votes = [
            { voter_pubkey: kps[0].pubkey, vote: 'approve' },
            { voter_pubkey: departed,      vote: 'approve' }
        ];
        let tally = gov._computeTally(votes, null);
        expect(tally.approvals).to.equal(1);
        expect(tally.totalVotes).to.equal(1);
        expect(tally.validatorCount).to.equal(3);
    });

    // ---- GOV-PROPOSER-SPOOF-1: proposerPubkey must bind to the sender ----

    it('_handlePropose drops a proposal whose proposerPubkey does not bind to the sender (GOV-PROPOSER-SPOOF-1)', async function () {
        // ws://v0:1 is registered to kps[0], but the proposal attributes itself to
        // kps[1] (attribution spoof). An authoritative registry drops it.
        hub._peerManager.validatorPubkeys = new Map(valset.map(v => [v.addr, v.pubkey]));
        let insert = hub.db.doQuery.withArgs(sinon.match(/INSERT IGNORE INTO governance_proposals/)).resolves();
        gov._handlePropose({ sender: 'ws://v0:1', data: {
            proposalId: 'gov:P:9', parameter: 'SOME_PARAM', currentValue: '100', proposedValue: '150',
            proposerPubkey: kps[1].pubkey } });
        await new Promise(r => setImmediate(r));
        expect(insert.callCount).to.equal(0);
    });

    it('_handlePropose records a proposal correctly attributed to its sender (GOV-PROPOSER-SPOOF-1 negative)', async function () {
        hub._peerManager.validatorPubkeys = new Map(valset.map(v => [v.addr, v.pubkey]));
        let insert = hub.db.doQuery.withArgs(sinon.match(/INSERT IGNORE INTO governance_proposals/)).resolves();
        gov._handlePropose({ sender: 'ws://v0:1', data: {
            proposalId: 'gov:P:10', parameter: 'SOME_PARAM', currentValue: '100', proposedValue: '150',
            proposerPubkey: kps[0].pubkey } });
        await new Promise(r => setImmediate(r));
        expect(insert.callCount).to.equal(1);
    });

    // ---- R2-M2 tally uses the locked denominator, immune to set churn ----

    it('_tallyProposal counts against the LOCKED snapshot, not a churned live set', async function () {
        // 2 of 3 snapshot members approve -> quorum(2) + approval(2) met -> passed.
        let votes = [
            { voter_pubkey: kps[0].pubkey, vote: 'approve' },
            { voter_pubkey: kps[1].pubkey, vote: 'approve' }
        ];
        hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote.*FROM governance_votes/))
            .resolves(votes);
        hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });

        // Live set CHURNS to 9 validators after the proposal was created; a live-set
        // tally would now need ceil(9*2/3)=6 approvals and FAIL. The snapshot (3) passes.
        gov.setValidatorSet(Array.from({ length: 9 }, (_, i) => ({ pubkey: String(i).repeat(64).slice(0, 64), addr: 'x' + i })));

        let finalized = null;
        gov.on('proposal:finalized', d => { finalized = d; });
        await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P', validator_snapshot: snapshotJson });

        let update = hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).getCall(0);
        expect(update.args[1][0], 'passed against the locked denominator').to.equal('passed');
        expect(finalized).to.not.be.null;
    });

    it('_tallyProposal broadcasts GOV_RESULT with authenticated vote evidence', async function () {
        hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote.*FROM governance_votes/))
            .resolves([{ voter_pubkey: kps[0].pubkey, vote: 'approve', signature: 'ab' }]);
        hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });
        await gov._tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P', validator_snapshot: snapshotJson });
        let bc = hub._peerManager.broadcast.getCalls().find(c => c.args[0] === 'GOV_RESULT');
        expect(bc, 'GOV_RESULT broadcast').to.exist;
        expect(bc.args[1].votes).to.be.an('array').with.length(1);
        expect(bc.args[1].votes[0]).to.include({ voterPubkey: kps[0].pubkey, vote: 'approve' });
    });

    // ---- R2-H2: follower re-tallies, never trusts the wire status ----

    it('_handleResult APPLIES local FAILED over a leader forged "passed" with zero approvals', async function () {
        let leader = gov._getProposalLeader('gov:P:1');
        hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
            .resolves([{ voting_end: '2020-01-01T00:00:00Z', validator_snapshot: snapshotJson }]);
        // No stored votes locally, and the forged result carries none.
        hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote FROM governance_votes/)).resolves([]);
        let update = hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });

        let emitted = false;
        gov.on('proposal:finalized', () => { emitted = true; });
        await gov._handleResult({ sender: leader.addr, data: { proposalId: 'gov:P:1', status: 'passed', votes: [] } });

        expect(update.getCall(0).args[1][0], 'local re-tally overrides the forged status').to.equal('failed');
        expect(emitted, 'a forged pass must not finalize').to.equal(false);
    });

    it('_handleResult recovers a follower that missed GOV_VOTE gossip via signed evidence', async function () {
        let leader = gov._getProposalLeader('gov:P:1');
        hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
            .resolves([{ voting_end: '2020-01-01T00:00:00Z', validator_snapshot: snapshotJson }]);
        // Local store is EMPTY until the evidence is ingested; after ingest the
        // re-tally SELECT sees the two approvals the evidence carried.
        hub.db.doQuery.withArgs(sinon.match(/INSERT INTO governance_votes/)).resolves();
        hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote FROM governance_votes/))
            .resolves([{ voter_pubkey: kps[0].pubkey, vote: 'approve' }, { voter_pubkey: kps[1].pubkey, vote: 'approve' }]);
        hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });
        hub.db.doQuery.withArgs(sinon.match(/SELECT parameter, current_value/))
            .resolves([{ parameter: 'P', current_value: '1', proposed_value: '2', activation_block: null }]);

        let emitted = null;
        gov.on('proposal:finalized', d => { emitted = d; });
        let evidence = [signedVote(kps[0], 'gov:P:1', 'approve'), signedVote(kps[1], 'gov:P:1', 'approve')];
        await gov._handleResult({ sender: leader.addr, data: { proposalId: 'gov:P:1', status: 'passed', votes: evidence } });

        // Both signed votes were ingested, then the local re-tally passed and emitted.
        expect(hub.db.doQuery.withArgs(sinon.match(/INSERT INTO governance_votes/)).callCount).to.equal(2);
        expect(emitted, 'legit pass finalizes after evidence recovery').to.not.be.null;
    });

    it('_ingestResultVotes skips a vote from a non-member and one with a bad signature', async function () {
        let insert = hub.db.doQuery.withArgs(sinon.match(/INSERT INTO governance_votes/)).resolves();
        let outsider = ValidatorIdentity.generate();
        let outsiderPriv = new ValidatorIdentity(outsider.privkeyHex);
        let electorate = gov._parseSnapshot(snapshotJson);
        let bad = signedVote(kps[0], 'gov:P:1', 'approve'); bad.signature = 'ee'.repeat(64); // tampered
        let nonMember = { voterPubkey: outsider.pubkeyHex.toLowerCase(), vote: 'approve',
            signature: outsiderPriv.sign(JSON.stringify({ proposalId: 'gov:P:1', vote: 'approve', voter: outsider.pubkeyHex.toLowerCase() })) };
        let good = signedVote(kps[1], 'gov:P:1', 'approve');

        await gov._ingestResultVotes('gov:P:1', [bad, nonMember, good], electorate);
        expect(insert.callCount, 'only the one valid member vote is ingested').to.equal(1);
    });

    it('_handleResult keeps wire-status behaviour for a legacy NULL-snapshot proposal', async function () {
        let leader = gov._getProposalLeader('gov:P:1');
        hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
            .resolves([{ voting_end: '2020-01-01T00:00:00Z', validator_snapshot: null }]);
        let update = hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });
        hub.db.doQuery.withArgs(sinon.match(/SELECT parameter, current_value/))
            .resolves([{ parameter: 'P', current_value: '1', proposed_value: '2', activation_block: null }]);

        await gov._handleResult({ sender: leader.addr, data: { proposalId: 'gov:P:1', status: 'passed' } });
        // No re-tally SELECT of votes happened (legacy path), and the wire status applied.
        expect(hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote FROM governance_votes/)).called).to.equal(false);
        expect(update.getCall(0).args[1][0]).to.equal('passed');
    });

    // ---- R2-M2 propose()/follower gating ----

    it('propose() persists a validator_snapshot column and broadcasts the snapshot', async function () {
        hub._identity.getPubkeyHex.returns(kps[0].pubkey);
        hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]).onThirdCall().resolves();
        await gov.propose('SOME_PARAM', '100', '150', 'why');
        let insert = hub.db.doQuery.getCalls().find(c => /INSERT INTO governance_proposals/.test(c.args[0]));
        expect(insert.args[0]).to.include('validator_snapshot');
        let bc = hub._peerManager.broadcast.getCalls().find(c => c.args[0] === 'GOV_PROPOSE');
        expect(bc.args[1].validatorSnapshot).to.be.an('array').with.length(3);
    });

    it('_handlePropose persists NULL snapshot below activation even if the wire snapshot is absent', async function () {
        // regtest network default is off here (hub.network undefined -> gate OFF).
        // Map the sender to the declared proposer key so the proposer-binding guard
        // (GOV-PROPOSER-SPOOF-1) treats this as a legitimately-attributed proposal.
        hub._peerManager.validatorPubkeys = new Map([['peer', kps[0].pubkey]]);
        let insert = hub.db.doQuery.withArgs(sinon.match(/INSERT IGNORE INTO governance_proposals/)).resolves();
        gov._handlePropose({ sender: 'peer', data: {
            proposalId: 'gov:P:1', parameter: 'SOME_PARAM', currentValue: '100', proposedValue: '150', proposerPubkey: kps[0].pubkey } });
        await new Promise(r => setImmediate(r));
        expect(insert.callCount).to.equal(1);
        expect(insert.getCall(0).args[1][7], 'activation_block NULL').to.equal(null);
        expect(insert.getCall(0).args[1][8], 'validator_snapshot NULL (absent, gate off)').to.equal(null);
    });

    it('_isSnapshotLockActive gates on network + observed BTC height', function () {
        expect(gov._isSnapshotLockActive(), 'no network -> off').to.equal(false);
        hub.network = 'regtest';
        hub._latestBlockIndex = 5;
        expect(gov._isSnapshotLockActive(), 'regtest activates at 0').to.equal(true);
        hub.network = 'mainnet';
        hub._latestBlockIndex = 969499;
        expect(gov._isSnapshotLockActive(), 'mainnet below 969500 -> off').to.equal(false);
        hub._latestBlockIndex = 969500;
        expect(gov._isSnapshotLockActive(), 'mainnet at 969500 -> on').to.equal(true);
        hub._latestBlockIndex = null;
        expect(gov._isSnapshotLockActive(), 'mainnet no observed tip -> off').to.equal(false);
    });
});
