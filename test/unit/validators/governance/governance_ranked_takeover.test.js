'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const Governance = require('../../../../src/validators/governance');
const { rankedElectorate } = require('../../../../src/validators/governance/takeover_rank.js');
const governanceRules = require('../../../../src/validators/governance/rules.js');
const { BTC_BLOCK_MS } = governanceRules;
const { createMockHub } = require('../../../helpers/mockHub');

const STEP_MS = (governanceRules.GOV_TAKEOVER_STEP_BLOCKS || 6) * BTC_BLOCK_MS;
const PROPOSAL_ID = 'gov:RANKED:1';
const ELECTORATE = [
    { pubkey: '01'.repeat(32), addr: 'validator-a' },
    { pubkey: '02'.repeat(32), addr: 'validator-b' },
    { pubkey: '03'.repeat(32), addr: 'validator-c' },
    { pubkey: '04'.repeat(32), addr: 'validator-d' }
];

let hub, gov, snapshot, ranked, votingEnd;

function setUp() {
    hub = createMockHub();
    gov = new Governance(hub);
    gov.setValidatorSet(ELECTORATE);
    snapshot = JSON.stringify(gov.buildValidatorSnapshot());
    let locked = gov.parseSnapshot(snapshot);
    let leader = gov.getProposalLeader(PROPOSAL_ID, locked);
    ranked = rankedElectorate(locked, leader.addr);
    votingEnd = Date.UTC(2026, 9, 1);
    hub._peerManager.validatorPubkeys = new Map(ELECTORATE.map(v => [v.addr, v.pubkey]));
}

function tearDown() {
    if (gov._tallyTimer) clearInterval(gov._tallyTimer);
    sinon.restore();
}

function proposal() {
    return {
        proposal_id: PROPOSAL_ID,
        parameter: 'RANKED_PARAM',
        voting_end: new Date(votingEnd),
        validator_snapshot: snapshot
    };
}

function enableFailover() {
    gov.isTallyFailoverActive = sinon.stub().returns(true);
}

async function staysIdleWithInactiveGate() {
    hub._peerManager.validatorAddr = ranked[1].addr;
    hub.db.doQuery.resolves([proposal()]);
    let tally = sinon.stub(gov, 'tallyProposal').resolves();
    sinon.stub(Date, 'now').returns(votingEnd + STEP_MS * 10);

    await gov.checkExpiredProposals();

    expect(tally.called).to.equal(false);
}

async function staysIdleBeforeRankWindow() {
    enableFailover();
    hub._peerManager.validatorAddr = ranked[1].addr;
    hub.db.doQuery.resolves([proposal()]);
    let tally = sinon.stub(gov, 'tallyProposal').resolves();
    sinon.stub(Date, 'now').returns(votingEnd + STEP_MS - 1);

    await gov.checkExpiredProposals();

    expect(tally.called).to.equal(false);
}

async function talliesAtExactRankBoundary() {
    enableFailover();
    hub._peerManager.validatorAddr = ranked[1].addr;
    hub.db.doQuery.onCall(0).resolves([proposal()]);
    hub.db.doQuery.onCall(1).resolves([]);
    hub.db.doQuery.onCall(2).resolves({ affectedRows: 1 });
    let tally = sinon.spy(gov, 'tallyProposal');
    sinon.stub(Date, 'now').returns(votingEnd + STEP_MS);

    await gov.checkExpiredProposals();

    expect(tally.calledOnceWithExactly(sinon.match({ proposal_id: PROPOSAL_ID }))).to.equal(true);
    expect(hub._peerManager.broadcast.calledOnceWith(
        'GOV_RESULT', sinon.match({ proposalId: PROPOSAL_ID, status: 'failed' })
    )).to.equal(true);
}

function usesLockedElectorate() {
    enableFailover();
    gov.setValidatorSet([{ pubkey: 'ff'.repeat(32), addr: 'replacement-validator' }]);

    expect(gov.isProposalTallySenderEntitled(
        proposal(), ranked[1].addr, votingEnd + STEP_MS
    )).to.equal(true);
}

async function rejectsResultBeforeRankWindow() {
    enableFailover();
    sinon.stub(Date, 'now').returns(votingEnd + STEP_MS - 1);
    hub.db.doQuery.onFirstCall().resolves([{
        voting_end: new Date(votingEnd), validator_snapshot: snapshot
    }]);

    await gov.handleResult({
        sender: ranked[1].addr,
        data: { proposalId: PROPOSAL_ID, status: 'failed', votes: [] }
    });

    expect(hub.db.doQuery.callCount).to.equal(1);
}

async function acceptsResultAtRankWindow() {
    enableFailover();
    sinon.stub(Date, 'now').returns(votingEnd + STEP_MS);
    hub.db.doQuery.onCall(0).resolves([{
        voting_end: new Date(votingEnd), validator_snapshot: snapshot
    }]);
    hub.db.doQuery.onCall(1).resolves([]);
    hub.db.doQuery.onCall(2).resolves({ affectedRows: 1 });

    await gov.handleResult({
        sender: ranked[1].addr,
        data: { proposalId: PROPOSAL_ID, status: 'failed', votes: [] }
    });

    expect(hub.db.doQuery.callCount).to.equal(3);
    expect(hub.db.doQuery.getCall(2).args[1]).to.deep.equal(['failed', PROPOSAL_ID]);
}

async function rejectsResultBeforeLaterRankWindow() {
    enableFailover();
    sinon.stub(Date, 'now').returns(votingEnd + STEP_MS);
    hub.db.doQuery.onFirstCall().resolves([{
        voting_end: new Date(votingEnd), validator_snapshot: snapshot
    }]);

    await gov.handleResult({
        sender: ranked[2].addr,
        data: { proposalId: PROPOSAL_ID, status: 'failed', votes: [] }
    });

    expect(hub.db.doQuery.callCount).to.equal(1);
}

async function rejectsUnknownSenderBeforeRead() {
    enableFailover();

    await gov.handleResult({
        sender: 'unknown-validator',
        data: { proposalId: PROPOSAL_ID, status: 'failed', votes: [] }
    });

    expect(hub.db.doQuery.called).to.equal(false);
}

describe('governance ranked tally takeover', function () {
    beforeEach(setUp);
    afterEach(tearDown);

    it('keeps a lower-ranked validator idle while the failover gate is inactive', staysIdleWithInactiveGate);
    it('keeps rank one idle until its takeover window opens', staysIdleBeforeRankWindow);
    it('lets rank one tally at its exact takeover boundary', talliesAtExactRankBoundary);
    it('uses the locked electorate after the live validator set changes', usesLockedElectorate);
    it('rejects a rank-one result one millisecond before its window', rejectsResultBeforeRankWindow);
    it('accepts a rank-one result at its exact window', acceptsResultAtRankWindow);
    it('rejects a registered validator before its own later rank window', rejectsResultBeforeLaterRankWindow);
    it('rejects an unknown takeover sender before reading the proposal', rejectsUnknownSenderBeforeRead);
});
