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
const Governance   = require('../../../../src/validators/governance');
const ValidatorIdentity = require('../../../../src/validators/identity');
const { createMockHub }   = require('../../../helpers/mockHub');
const { VALIDATORS_3 }    = require('../../../helpers/fixtures');

let hub, pm, identity, gov;

function installSuiteHooks1() {
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
}

const PAST = '2020-01-01T00:00:00Z';

const leaderAddr = () => gov.getProposalLeader('gov:P:1').addr;

// _handleResult(): followers must apply a passed proposal too.
// Authenticated GOV_RESULT comes only from the proposal's deterministic tally
// leader, after voting_end. Call order is: SELECT voting_end, UPDATE, SELECT row.
describe('Governance', function () {
    installSuiteHooks1();
describe('_handleResult()', function () {
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
// Authentication permits only the tally leader and only after voting_end.
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
});

// tallyProposal()
describe('Governance', function () {
    installSuiteHooks1();
describe('tallyProposal()', function () {
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

            await gov.tallyProposal({
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

            await gov.tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[1][0]).to.equal('failed');
            expect(emitted).to.be.false;
        });
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('tallyProposal()', function () {
it('fails when quorum not met (less than 50% participation)', async function () {
            gov.setValidatorSet(VALIDATORS_3);

            // Only 1 of 3 voted, below 50% quorum
            hub.db.doQuery.onFirstCall().resolves([
                { voter_pubkey: VALIDATORS_3[0].pubkey, vote: 'approve' }
            ]);
            hub.db.doQuery.onSecondCall().resolves();

            await gov.tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

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

            await gov.tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P' });

            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_RESULT');
        });
});
// Query methods
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
});

// P2P message handlers
describe('Governance', function () {
    installSuiteHooks1();
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
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('P2P message handlers', function () {
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
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('P2P message handlers', function () {
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
it('handleVote persists a registered validator vote with a valid signature (proposal still open)', async function () {
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            // The proposal-open lookup guard resolves to a future voting_end.
            hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
                .resolves([{ voting_end: new Date(Date.now() + 86400000) }]);
            let sig = idn.sign(Governance.voteSigningPayload('gov:P:1', 'approve', kp.pubkeyHex, 1000));
            await gov.handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT INTO governance_votes/)),
                'the vote row is inserted').to.be.true;
        });
});
});
