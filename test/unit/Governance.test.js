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

        // ── Block-anchored MIN_STAKE activation (#3703) ───────────────────────
        it('computes a block-anchored activation for a capability MIN_STAKE proposal', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]).onThirdCall().resolves();
            hub._latestBlockIndex = 500;
            gov.votingPeriod = 604800000; // 7 days → ceil(/600000) = 1008 blocks
            let result = await gov.propose('CAPABILITY_PRICE_MIN_STAKE', '10000', '12000');
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
                await gov.propose('CAPABILITY_PRICE_MIN_STAKE', '10000', '12000', null, 600);
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('too soon');
            }
        });

        it('throws when anchoring a MIN_STAKE change with no observed block height', async function () {
            hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]);
            hub._latestBlockIndex = null;
            try {
                await gov.propose('CAPABILITY_PRICE_MIN_STAKE', '10000', '12000');
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('no observed block height');
            }
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
    // _handleResult() — followers must apply a passed proposal too
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

        it('does NOT emit when already finalized (affectedRows = 0 — tally-leader loopback)', async function () {
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
            hub.db.doQuery.onSecondCall().resolves(); // UPDATE

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

            // Only 1 of 3 voted — below 50% quorum
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
            hub.db.doQuery.onSecondCall().resolves();

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
        it('_handlePropose stores proposal locally', function () {
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

        it('_handleVote stores vote locally', function () {
            gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: 'abc', signature: 'sig' }
            });
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('_handlePropose defaults a missing proposerPubkey and rationale to empty strings', function () {
            gov._handlePropose({
                sender: 'peer', type: 'GOV_PROPOSE',
                data: {
                    proposalId: 'gov:P:1', parameter: 'P',
                    currentValue: '100', proposedValue: '120',
                    votingEnd: new Date().toISOString()
                }
            });
            let args = hub.db.doQuery.getCall(0).args[1];
            expect(args[1]).to.equal(''); // proposer_pubkey
            expect(args[5]).to.equal(''); // rationale
        });

        it('_handleVote defaults a missing signature to an empty string', function () {
            gov._handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: 'abc' }
            });
            let args = hub.db.doQuery.getCall(0).args[1];
            expect(args[3]).to.equal(''); // signature (insert)
            expect(args[5]).to.equal(''); // signature (on-duplicate update)
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
