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

// start() / stop()
describe('Governance', function () {
    installSuiteHooks1();
describe('P2P message handlers', function () {
it('handleVote DROPS a validly-signed vote whose proposal window has closed (GOV-LATEVOTE-1)', async function () {
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            // The proposal is still 'voting' but voting_end has already elapsed: the honest
            // vote() path refuses this; the gossip path must too, or a post-close vote is tallied.
            hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
                .resolves([{ voting_end: new Date(Date.now() - 1000) }]);
            let sig = idn.sign(Governance.voteSigningPayload('gov:P:1', 'approve', kp.pubkeyHex, 1000));
            await gov.handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT INTO governance_votes/)),
                'no vote row inserted for a closed proposal').to.be.false;
        });
it('handleVote DROPS a validly-signed vote for a proposal this hub never recorded (GOV-LATEVOTE-1)', async function () {
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/)).resolves([]);
            let sig = idn.sign(Governance.voteSigningPayload('gov:GHOST:1', 'approve', kp.pubkeyHex, 1000));
            await gov.handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:GHOST:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.calledWithMatch(sinon.match(/INSERT INTO governance_votes/)),
                'no vote row inserted with no local proposal').to.be.false;
        });
it('handleVote REJECTS a vote whose voterPubkey is not a registered validator (C-1 vote-stuffing guard)', function () {
            // Valid signature, but the pubkey is a fabricated non-member: the exact
            // primitive a Byzantine validator would use to stuff N invented voters.
            let kp  = ValidatorIdentity.generate();
            let idn = new ValidatorIdentity(kp.privkeyHex);
            let sig = idn.sign(Governance.voteSigningPayload('gov:P:1', 'approve', kp.pubkeyHex, 1000));
            gov.handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: sig, seq: 1000 }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });
it('handleVote REJECTS a registered validator vote with a forged signature', function () {
            let kp = ValidatorIdentity.generate();
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            gov.handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex, signature: 'deadbeef' }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });
});
});

// Tally leadership
describe('Governance', function () {
    installSuiteHooks1();
describe('P2P message handlers', function () {
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
it('handleVote REJECTS an unsigned vote (no signature to authenticate the voter)', function () {
            let kp = ValidatorIdentity.generate();
            gov.setValidatorSet([...VALIDATORS_3, { pubkey: kp.pubkeyHex, addr: 'ws://voter:1' }]);
            gov.handleVote({
                sender: 'peer', type: 'GOV_VOTE',
                data: { proposalId: 'gov:P:1', vote: 'approve', voterPubkey: kp.pubkeyHex }
            });
            expect(hub.db.doQuery.called).to.be.false;
        });
it('_handleResult updates proposal status (from the tally leader, post voting_end)', async function () {
            hub.db.doQuery.onCall(0).resolves([{ voting_end: '2020-01-01T00:00:00Z' }]); // SELECT voting_end
            hub.db.doQuery.onCall(1).resolves({ affectedRows: 1 });                       // UPDATE
            await gov._handleResult({
                sender: gov.getProposalLeader('gov:P:1').addr, type: 'GOV_RESULT',
                data: { proposalId: 'gov:P:1', status: 'passed' }
            });
            expect(hub.db.doQuery.called).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('voting_end');
            expect(hub.db.doQuery.getCall(1).args[0]).to.include('UPDATE');
        });
it('ignores messages with missing fields', function () {
            gov._handlePropose({ sender: 'peer', data: {} });
            gov.handleVote({ sender: 'peer', data: {} });
            gov._handleResult({ sender: 'peer', data: {} });
            expect(hub.db.doQuery.called).to.be.false;
        });
it('_handleMessage routes each governance message type and ignores unknown', function () {
            let p = sinon.spy(gov, '_handlePropose');
            let v = sinon.spy(gov, 'handleVote');
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
});

// checkExpiredProposals()
describe('Governance', function () {
    installSuiteHooks1();
describe('start() / stop()', function () {
it('start() subscribes and schedules the tally timer; stop() tears both down', async function () {
            let clock = sinon.useFakeTimers();
            gov.tallyInterval = 1000;
            let spy = sinon.spy(gov, 'checkExpiredProposals');
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
it('the tally timer catches a rejecting tick instead of dropping the promise', async function () {
            // The tick guards its two awaits but not the leader check between them, and
            // the hub registers no process.on('unhandledRejection'), so an uncaught tick
            // rejection would kill the process rather than log and re-arm.
            let clock = sinon.useFakeTimers();
            gov.tallyInterval = 1000;
            sinon.stub(gov, 'checkExpiredProposals').rejects(new Error('tally tick blew up'));
            let logged = sinon.stub(console, 'error');
            await gov.start();

            clock.tick(1001);
            // The .catch runs on the microtask queue, which fake timers do not drive.
            await Promise.resolve();
            await Promise.resolve();

            clock.restore();
            expect(logged.calledWithMatch('Governance tally tick error:')).to.equal(true);
        });
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('tally leadership', function () {
it('getProposalLeader returns null for an empty validator set', function () {
            gov.setValidatorSet([]);
            expect(gov.getProposalLeader('gov:P:1')).to.be.null;
        });
it('getProposalLeader is deterministic and drawn from the validator set', function () {
            gov.setValidatorSet(VALIDATORS_3);
            let l1 = gov.getProposalLeader('gov:P:1');
            let l2 = gov.getProposalLeader('gov:P:1');
            expect(l1).to.equal(l2);
            expect(VALIDATORS_3).to.include(l1);
        });
it('isTallyLeader is true in standalone mode (no validator set)', function () {
            gov.setValidatorSet([]);
            expect(gov.isTallyLeader('gov:P:1')).to.be.true;
        });
it('isTallyLeader is true when this node is the designated leader', function () {
            gov.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = gov.getProposalLeader('gov:P:1').addr;
            expect(gov.isTallyLeader('gov:P:1')).to.be.true;
        });
it('isTallyLeader is false when another node is the leader', function () {
            gov.setValidatorSet(VALIDATORS_3);
            let leader = gov.getProposalLeader('gov:P:1');
            let other = VALIDATORS_3.find(v => v.addr !== leader.addr);
            pm.validatorAddr = other.addr;
            expect(gov.isTallyLeader('gov:P:1')).to.be.false;
        });
});
});

describe('Governance', function () {
    installSuiteHooks1();
describe('checkExpiredProposals()', function () {
it('tallies an expired proposal when this node leads it', async function () {
            gov.setValidatorSet([]); // standalone → always leader
            hub.db.doQuery.onFirstCall().resolves([
                { proposal_id: 'gov:P:1', parameter: 'P', current_value: '100', proposed_value: '120' }
            ]);
            let tally = sinon.stub(gov, 'tallyProposal').resolves();
            await gov.checkExpiredProposals();
            expect(tally.calledOnce).to.be.true;
            expect(tally.getCall(0).args[0].proposal_id).to.equal('gov:P:1');
        });
it('skips proposals led by another node', async function () {
            gov.setValidatorSet(VALIDATORS_3);
            let leader = gov.getProposalLeader('gov:P:1');
            pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
            hub.db.doQuery.onFirstCall().resolves([{ proposal_id: 'gov:P:1' }]);
            let tally = sinon.stub(gov, 'tallyProposal').resolves();
            await gov.checkExpiredProposals();
            expect(tally.called).to.be.false;
        });
it('logs and returns without crashing when the SELECT throws', async function () {
            hub.db.doQuery.onFirstCall().rejects(new Error('schema drift'));
            let tally = sinon.stub(gov, 'tallyProposal').resolves();
            await gov.checkExpiredProposals(); // must not throw
            expect(tally.called).to.be.false;
        });
it('continues past a proposal whose tally throws', async function () {
            gov.setValidatorSet([]); // always leader
            hub.db.doQuery.onFirstCall().resolves([
                { proposal_id: 'gov:A' }, { proposal_id: 'gov:B' }
            ]);
            let tally = sinon.stub(gov, 'tallyProposal');
            tally.onFirstCall().rejects(new Error('boom'));
            tally.onSecondCall().resolves();
            await gov.checkExpiredProposals();
            expect(tally.callCount).to.equal(2); // did not abort after the first error
        });
});
});
