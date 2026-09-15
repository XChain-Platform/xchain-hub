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

let hub, gov, kps, valset, snapshotJson;

// Sign through the production payload builder so any drift between these bytes
// and the source fails the replay tests instead of hiding behind a local copy.
// seq defaults to a fixed positive value, and replay cases pass it explicitly.
function signedVote(kp, proposalId, vote, seq = 1000) {
        let sig = kp.priv.sign(Governance.voteSigningPayload(proposalId, vote, kp.pubkey, seq));
        return { voterPubkey: kp.pubkey, vote, signature: sig, seq };
    }

function installSuiteHooks2() {
    // Three real-keyed validators make votes carry verifiable Ed25519 signatures
    // and make getProposalLeader resolve to a known address.
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
}

// Snapshot-locked electorate and follower local re-tally.
// Snapshot build and validation helpers.
// The compatibility tally re-filters its numerator by current membership.
describe('Governance: R2-M2 snapshot-lock + R2-H2 re-tally', function () {
    installSuiteHooks2();
it('buildValidatorSnapshot returns a pubkey-sorted {pubkey,addr} array', function () {
        let snap = gov.buildValidatorSnapshot();
        expect(snap).to.have.length(3);
        expect(snap.map(e => e.pubkey)).to.deep.equal(valset.map(v => v.pubkey).sort());
    });
it('parseSnapshot rejects malformed / oversized / duplicate-pubkey snapshots', function () {
        expect(gov.parseSnapshot(null)).to.equal(null);
        expect(gov.parseSnapshot('not json')).to.equal(null);
        expect(gov.parseSnapshot('[]')).to.equal(null);
        expect(gov.parseSnapshot(JSON.stringify([{ pubkey: 'aa' }, { pubkey: 'aa' }]))).to.equal(null);
        expect(gov.parseSnapshot(JSON.stringify([{ addr: 'x' }]))).to.equal(null); // no pubkey
    });
it('snapshotMatchesLocalSet is exact-set: rejects a self-only shrink and a superset', function () {
        let full = gov.parseSnapshot(snapshotJson);
        expect(gov.snapshotMatchesLocalSet(full)).to.equal(true);
        let selfOnly = [{ pubkey: kps[0].pubkey, addr: 'x' }];
        expect(gov.snapshotMatchesLocalSet(selfOnly)).to.equal(false);
        let superset = full.concat([{ pubkey: 'ff'.repeat(32), addr: 'y' }]);
        expect(gov.snapshotMatchesLocalSet(superset)).to.equal(false);
    });
it('computeTally (legacy, null electorate) excludes votes from validators no longer in the set (GOV-TALLY-DENOM-1)', function () {
        // A vote from a current member (kps[0]) and one from a departed validator
        // (not in the live set) are both recorded. The compatibility path must count only
        // the current member so the numerator matches the current-set denominator;
        // otherwise an ex-member's stale vote inflates approvals against a
        // denominator that excludes them.
        let departed = 'cd'.repeat(32);
        let votes = [
            { voter_pubkey: kps[0].pubkey, vote: 'approve' },
            { voter_pubkey: departed,      vote: 'approve' }
        ];
        let tally = gov.computeTally(votes, null);
        expect(tally.approvals).to.equal(1);
        expect(tally.totalVotes).to.equal(1);
        expect(tally.validatorCount).to.equal(3);
    });
// proposerPubkey must bind to the sender.
it('_handlePropose drops a proposal whose proposerPubkey does not bind to the sender (GOV-PROPOSER-SPOOF-1)', async function () {
        // The first validator address is registered to kps[0], but the proposal attributes itself to
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
});

describe('Governance: R2-M2 snapshot-lock + R2-H2 re-tally', function () {
    installSuiteHooks2();
// The tally uses the locked denominator and is immune to set churn.
it('tallyProposal counts against the LOCKED snapshot, not a churned live set', async function () {
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
        await gov.tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P', validator_snapshot: snapshotJson });

        let update = hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).getCall(0);
        expect(update.args[1][0], 'passed against the locked denominator').to.equal('passed');
        expect(finalized).to.not.be.null;
    });
it('tallyProposal broadcasts GOV_RESULT with authenticated vote evidence', async function () {
        hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote.*FROM governance_votes/))
            .resolves([{ voter_pubkey: kps[0].pubkey, vote: 'approve', signature: 'ab' }]);
        hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });
        await gov.tallyProposal({ proposal_id: 'gov:P:1', parameter: 'P', validator_snapshot: snapshotJson });
        let bc = hub._peerManager.broadcast.getCalls().find(c => c.args[0] === 'GOV_RESULT');
        expect(bc, 'GOV_RESULT broadcast').to.exist;
        expect(bc.args[1].votes).to.be.an('array').with.length(1);
        expect(bc.args[1].votes[0]).to.include({ voterPubkey: kps[0].pubkey, vote: 'approve' });
    });
// A follower re-tallies locally and never trusts the wire status.
it('_handleResult APPLIES local FAILED over a leader forged "passed" with zero approvals', async function () {
        let leader = gov.getProposalLeader('gov:P:1');
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
});

describe('Governance: R2-M2 snapshot-lock + R2-H2 re-tally', function () {
    installSuiteHooks2();
it('_handleResult recovers a follower that missed GOV_VOTE gossip via signed evidence', async function () {
        let leader = gov.getProposalLeader('gov:P:1');
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
it('ingestResultVotes skips a vote from a non-member and one with a bad signature', async function () {
        let insert = hub.db.doQuery.withArgs(sinon.match(/INSERT INTO governance_votes/)).resolves();
        let outsider = ValidatorIdentity.generate();
        let outsiderPriv = new ValidatorIdentity(outsider.privkeyHex);
        let electorate = gov.parseSnapshot(snapshotJson);
        let bad = signedVote(kps[0], 'gov:P:1', 'approve'); bad.signature = 'ee'.repeat(64); // tampered
        let nonMember = { voterPubkey: outsider.pubkeyHex.toLowerCase(), vote: 'approve',
            signature: outsiderPriv.sign(JSON.stringify({ proposalId: 'gov:P:1', vote: 'approve', voter: outsider.pubkeyHex.toLowerCase() })) };
        let good = signedVote(kps[1], 'gov:P:1', 'approve');

        await gov.ingestResultVotes('gov:P:1', [bad, nonMember, good], electorate);
        expect(insert.callCount, 'only the one valid member vote is ingested').to.equal(1);
    });
it('_handleResult keeps wire-status behaviour for a legacy NULL-snapshot proposal', async function () {
        let leader = gov.getProposalLeader('gov:P:1');
        hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/))
            .resolves([{ voting_end: '2020-01-01T00:00:00Z', validator_snapshot: null }]);
        let update = hub.db.doQuery.withArgs(sinon.match(/UPDATE governance_proposals/)).resolves({ affectedRows: 1 });
        hub.db.doQuery.withArgs(sinon.match(/SELECT parameter, current_value/))
            .resolves([{ parameter: 'P', current_value: '1', proposed_value: '2', activation_block: null }]);

        await gov._handleResult({ sender: leader.addr, data: { proposalId: 'gov:P:1', status: 'passed' } });
        // No re-tally SELECT of votes happened on the compatibility path, and the wire status applied.
        expect(hub.db.doQuery.withArgs(sinon.match(/SELECT voter_pubkey, vote FROM governance_votes/)).called).to.equal(false);
        expect(update.getCall(0).args[1][0]).to.equal('passed');
    });
// Proposal and follower gating preserve the locked electorate.
it('propose() persists a validator_snapshot column and broadcasts the snapshot', async function () {
        hub._identity.getPubkeyHex.returns(kps[0].pubkey);
        hub.db.doQuery.onFirstCall().resolves([]).onSecondCall().resolves([]).onThirdCall().resolves();
        await gov.propose('SOME_PARAM', '100', '150', 'why');
        let insert = hub.db.doQuery.getCalls().find(c => /INSERT INTO governance_proposals/.test(c.args[0]));
        expect(insert.args[0]).to.include('validator_snapshot');
        let bc = hub._peerManager.broadcast.getCalls().find(c => c.args[0] === 'GOV_PROPOSE');
        expect(bc.args[1].validatorSnapshot).to.be.an('array').with.length(3);
    });
});

describe('Governance: R2-M2 snapshot-lock + R2-H2 re-tally', function () {
    installSuiteHooks2();
it('_handlePropose persists NULL snapshot below activation even if the wire snapshot is absent', async function () {
        // regtest network default is off here (hub.network undefined -> gate OFF).
        // Map the sender to the declared proposer key so the binding guard treats
        // this as a legitimately attributed proposal.
        hub._peerManager.validatorPubkeys = new Map([['peer', kps[0].pubkey]]);
        let insert = hub.db.doQuery.withArgs(sinon.match(/INSERT IGNORE INTO governance_proposals/)).resolves();
        gov._handlePropose({ sender: 'peer', data: {
            proposalId: 'gov:P:1', parameter: 'SOME_PARAM', currentValue: '100', proposedValue: '150', proposerPubkey: kps[0].pubkey } });
        await new Promise(r => setImmediate(r));
        expect(insert.callCount).to.equal(1);
        expect(insert.getCall(0).args[1][7], 'activation_block NULL').to.equal(null);
        expect(insert.getCall(0).args[1][8], 'validator_snapshot NULL (absent, gate off)').to.equal(null);
    });
it('isSnapshotLockActive gates on network + observed BTC height', function () {
        expect(gov.isSnapshotLockActive(), 'no network -> off').to.equal(false);
        hub.network = 'regtest';
        hub._latestBlockIndex = 5;
        expect(gov.isSnapshotLockActive(), 'regtest activates at 0').to.equal(true);
        hub.network = 'mainnet';
        hub._latestBlockIndex = 962999;
        expect(gov.isSnapshotLockActive(), 'mainnet below 963000 -> off').to.equal(false);
        hub._latestBlockIndex = 963000;
        expect(gov.isSnapshotLockActive(), 'mainnet at 963000 -> on').to.equal(true);
        hub._latestBlockIndex = null;
        expect(gov.isSnapshotLockActive(), 'mainnet no observed tip -> off').to.equal(false);
    });
});
