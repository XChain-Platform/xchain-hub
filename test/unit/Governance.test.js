'use strict';

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
            gov.on('proposal:passed', (d) => { emitted = d; });

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
            gov.on('proposal:passed', () => { emitted = true; });

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

        it('_handleResult updates proposal status', function () {
            gov._handleResult({
                sender: 'peer', type: 'GOV_RESULT',
                data: { proposalId: 'gov:P:1', status: 'passed' }
            });
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('UPDATE');
        });

        it('ignores messages with missing fields', function () {
            gov._handlePropose({ sender: 'peer', data: {} });
            gov._handleVote({ sender: 'peer', data: {} });
            gov._handleResult({ sender: 'peer', data: {} });
            expect(hub.db.doQuery.called).to.be.false;
        });
    });
});
