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

// GOV-VOTE-REPLAY-1: a governance vote must not be replayable.
//
// Before this fix the signed payload was a pure function of
// (proposalId, vote, voter), so a captured (payload, signature) pair stayed
// valid forever. governance_votes is keyed on (proposal_id, voter_pubkey) and
// the sink was a plain last-write-wins upsert, so anyone who had seen a
// validator's earlier "approve" gossip could re-broadcast it after that
// validator switched to "reject" and silently reinstate the superseded choice.
// handleVote authenticates the vote by its own signature, so the replayed copy
// verified perfectly: nothing in the payload said WHEN it was cast.
//
// The fix puts a monotonic `seq` inside the signed bytes and only accepts a
// strictly greater seq per (proposal_id, voter_pubkey).
//
// WHAT THIS FILE CAN AND CANNOT PROVE. The monotonic comparison itself is one
// atomic SQL statement (deliberately, so concurrent gossip copies cannot race a
// read-compare-write), and a sinon-stubbed db can only show the statement SHAPE.
// The comparison's EFFECT is proven against a real MariaDB in
// test/integration/governance/voteSeqMonotonic.integration.test.js. These unit
// tests cover the half that is pure JS: the signed bytes, the seq binding, and
// the refusal paths.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const Governance = require('../../../../src/validators/governance');
const ValidatorIdentity = require('../../../../src/validators/identity');
const {
  createMockHub
} = require('../../../helpers/mockHub');
const {
  VALIDATORS_3
} = require('../../../helpers/fixtures');
const PROPOSAL = 'gov:MIN_STAKE:1';
let governanceGOVVOTEREPLAYSuite1Hub, governanceGOVVOTEREPLAYSuite1Gov, governanceGOVVOTEREPLAYSuite1Kp, governanceGOVVOTEREPLAYSuite1Idn;
function governanceGOVVOTEREPLAYSuite1Inbound(vote, seq, signWithSeq) {
  // signWithSeq lets a test sign over one seq and send another, which is
  // exactly what a payload-stripping attacker would attempt.
  let signed = signWithSeq === undefined ? seq : signWithSeq;
  return {
    sender: 'peer',
    type: 'GOV_VOTE',
    data: {
      proposalId: PROPOSAL,
      vote,
      voterPubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
      seq,
      signature: governanceGOVVOTEREPLAYSuite1Idn.sign(Governance.voteSigningPayload(PROPOSAL, vote, governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex, signed))
    }
  };
}
function governanceGOVVOTEREPLAYSuite1UpsertCalls() {
  return governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.getCalls().filter(c => /INSERT INTO governance_votes/.test(String(c.args[0])));
}

// ---- the signed bytes -------------------------------------------------
function registerGovernanceGOVVOTEREPLAYSuite1Part1() {
  beforeEach(function () {
    governanceGOVVOTEREPLAYSuite1Hub = createMockHub();
    governanceGOVVOTEREPLAYSuite1Hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
    governanceGOVVOTEREPLAYSuite1Gov = new Governance(governanceGOVVOTEREPLAYSuite1Hub);
    governanceGOVVOTEREPLAYSuite1Kp = ValidatorIdentity.generate();
    governanceGOVVOTEREPLAYSuite1Idn = new ValidatorIdentity(governanceGOVVOTEREPLAYSuite1Kp.privkeyHex);
    governanceGOVVOTEREPLAYSuite1Gov.setValidatorSet([...VALIDATORS_3, {
      pubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
      addr: 'ws://voter:1'
    }]);
    // The GOV-LATEVOTE-1 guard needs an open proposal for the vote to survive.
    governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.withArgs(sinon.match(/SELECT voting_end.*FROM governance_proposals/)).resolves([{
      voting_end: new Date(Date.now() + 86400000)
    }]);
  });
  afterEach(function () {
    if (governanceGOVVOTEREPLAYSuite1Gov._tallyTimer) clearInterval(governanceGOVVOTEREPLAYSuite1Gov._tallyTimer);
    sinon.restore();
  });
  it('carries seq inside the signed payload, in a fixed key order', function () {
    expect(Governance.voteSigningPayload(PROPOSAL, 'approve', 'AB', 42)).to.equal('{"proposalId":"gov:MIN_STAKE:1","vote":"approve","voter":"AB","seq":42}');
  });
  it('binds the signature to seq: the same vote at a different seq will not verify', function () {
    let sig = governanceGOVVOTEREPLAYSuite1Idn.sign(Governance.voteSigningPayload(PROPOSAL, 'approve', governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex, 1000));
    expect(ValidatorIdentity.verify(Governance.voteSigningPayload(PROPOSAL, 'approve', governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex, 1000), sig, governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex), 'the seq it was signed at verifies').to.equal(true);
    expect(ValidatorIdentity.verify(Governance.voteSigningPayload(PROPOSAL, 'approve', governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex, 1001), sig, governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex), 'a bumped seq does NOT verify, so seq cannot be edited in flight').to.equal(false);
  });
  it('refuses a seq that is not a positive safe integer', function () {
    for (let bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, '1000', {}]) expect(Governance.normalizeVoteSeq(bad), String(bad)).to.equal(0);
    expect(Governance.normalizeVoteSeq(1)).to.equal(1);
    expect(Governance.normalizeVoteSeq(Number.MAX_SAFE_INTEGER)).to.equal(Number.MAX_SAFE_INTEGER);
  });

  // ---- the refusal paths ------------------------------------------------
}
function registerGovernanceGOVVOTEREPLAYSuite1Part2() {
  it('DROPS a validly-signed vote that carries no seq (older peer or a stripped replay)', async function () {
    let sig = governanceGOVVOTEREPLAYSuite1Idn.sign(JSON.stringify({
      proposalId: PROPOSAL,
      vote: 'approve',
      voter: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex
    }));
    await governanceGOVVOTEREPLAYSuite1Gov.handleVote({
      sender: 'peer',
      type: 'GOV_VOTE',
      data: {
        proposalId: PROPOSAL,
        vote: 'approve',
        voterPubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
        signature: sig
      }
    });
    expect(governanceGOVVOTEREPLAYSuite1UpsertCalls().length, 'nothing persisted for a seq-less vote').to.equal(0);
  });
  it('DROPS a vote whose seq was edited in flight (signed at one seq, sent at another)', async function () {
    await governanceGOVVOTEREPLAYSuite1Gov.handleVote(governanceGOVVOTEREPLAYSuite1Inbound('approve', 5000, 1000));
    expect(governanceGOVVOTEREPLAYSuite1UpsertCalls().length, 'signature no longer matches the rebuilt bytes').to.equal(0);
  });
  it('accepts a properly seq-stamped vote and persists it with its seq', async function () {
    await governanceGOVVOTEREPLAYSuite1Gov.handleVote(governanceGOVVOTEREPLAYSuite1Inbound('approve', 1000));
    let calls = governanceGOVVOTEREPLAYSuite1UpsertCalls();
    expect(calls.length, 'one persist').to.equal(1);
    expect(calls[0].args[1]).to.include(1000);
  });

  // ---- the guard reaches the sink --------------------------------------

  it('persists through a seq-conditional statement, not a bare last-write-wins upsert', async function () {
    await governanceGOVVOTEREPLAYSuite1Gov.handleVote(governanceGOVVOTEREPLAYSuite1Inbound('approve', 1000));
    let sql = String(governanceGOVVOTEREPLAYSuite1UpsertCalls()[0].args[0]).replace(/\s+/g, ' ');
    expect(sql, 'the overwrite is gated on a strictly greater seq').to.match(/vote\s*=\s*IF\(VALUES\(vote_seq\) > COALESCE\(vote_seq, 0\), VALUES\(vote\), vote\)/);
    expect(sql, 'the signature is gated by the same comparison').to.match(/signature\s*=\s*IF\(VALUES\(vote_seq\) > COALESCE\(vote_seq, 0\)/);
    expect(sql, 'the stored seq only ever moves up, so a late loser cannot lower the bar').to.match(/vote_seq\s*=\s*GREATEST\(COALESCE\(vote_seq, 0\), VALUES\(vote_seq\)\)/);
    // Vacuity guard: the assertions above must be describing the real statement.
    expect(sql).to.match(/^INSERT INTO governance_votes \(proposal_id, voter_pubkey, vote, signature, vote_seq\)/);
  });
  it('does the comparison in ONE statement (no read-compare-write TOCTOU on the gossip path)', async function () {
    await governanceGOVVOTEREPLAYSuite1Gov.handleVote(governanceGOVVOTEREPLAYSuite1Inbound('approve', 1000));
    let reads = governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.getCalls().filter(c => /SELECT vote_seq FROM governance_votes/.test(String(c.args[0])));
    expect(reads.length, 'handleVote must not read the stored seq before writing').to.equal(0);
  });

  // ---- vote(), the signer ----------------------------------------------
}
function registerGovernanceGOVVOTEREPLAYSuite1Part3() {
  it('vote() stamps a seq that strictly beats the seq already stored for this voter', async function () {
    // A stored seq far in the future: wall-clock alone would not beat it, and a
    // tie would be refused as non-increasing, stranding the voter.
    let stored = Date.now() + 5_000_000;
    governanceGOVVOTEREPLAYSuite1Hub._identity.getPubkeyHex.returns(governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex);
    governanceGOVVOTEREPLAYSuite1Gov = new Governance(governanceGOVVOTEREPLAYSuite1Hub);
    governanceGOVVOTEREPLAYSuite1Gov.setValidatorSet([{
      pubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
      addr: 'ws://voter:1'
    }]);
    governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.withArgs(sinon.match(/SELECT \* FROM governance_proposals/)).resolves([{
      proposal_id: PROPOSAL,
      voting_end: new Date(Date.now() + 86400000),
      validator_snapshot: null
    }]);
    governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.withArgs(sinon.match(/SELECT vote_seq FROM governance_votes/)).resolves([{
      vote_seq: stored
    }]);
    await governanceGOVVOTEREPLAYSuite1Gov.vote(PROPOSAL, 'reject');
    let broadcast = governanceGOVVOTEREPLAYSuite1Hub._peerManager.broadcast.getCalls().find(c => c.args[0] === 'GOV_VOTE');
    expect(broadcast, 'the vote was broadcast').to.exist;
    expect(broadcast.args[1].seq, 'seq strictly exceeds the stored one').to.be.greaterThan(stored);
    expect(broadcast.args[1].seq, 'and only by the minimum needed').to.equal(stored + 1);
  });
  it('vote() broadcasts the seq it signed, so peers can rebuild the bytes', async function () {
    governanceGOVVOTEREPLAYSuite1Hub._identity.getPubkeyHex.returns(governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex);
    governanceGOVVOTEREPLAYSuite1Hub._identity.sign.callsFake(p => governanceGOVVOTEREPLAYSuite1Idn.sign(p));
    governanceGOVVOTEREPLAYSuite1Gov = new Governance(governanceGOVVOTEREPLAYSuite1Hub);
    governanceGOVVOTEREPLAYSuite1Gov.setValidatorSet([{
      pubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
      addr: 'ws://voter:1'
    }]);
    governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.withArgs(sinon.match(/SELECT \* FROM governance_proposals/)).resolves([{
      proposal_id: PROPOSAL,
      voting_end: new Date(Date.now() + 86400000),
      validator_snapshot: null
    }]);
    governanceGOVVOTEREPLAYSuite1Hub.db.doQuery.withArgs(sinon.match(/SELECT vote_seq FROM governance_votes/)).resolves([]);
    await governanceGOVVOTEREPLAYSuite1Gov.vote(PROPOSAL, 'approve');
    let sent = governanceGOVVOTEREPLAYSuite1Hub._peerManager.broadcast.getCalls().find(c => c.args[0] === 'GOV_VOTE').args[1];
    expect(ValidatorIdentity.verify(Governance.voteSigningPayload(PROPOSAL, 'approve', governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex, sent.seq), sent.signature, governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex), 'a peer rebuilding the payload from the broadcast fields verifies it').to.equal(true);
  });

  // ---- GOV_RESULT evidence path ----------------------------------------
}
function registerGovernanceGOVVOTEREPLAYSuite1Part4() {
  it('ingestResultVotes skips evidence with no seq rather than defaulting it', async function () {
    let electorate = [{
      pubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex.toLowerCase()
    }];
    let sig = governanceGOVVOTEREPLAYSuite1Idn.sign(JSON.stringify({
      proposalId: PROPOSAL,
      vote: 'approve',
      voter: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex
    }));
    await governanceGOVVOTEREPLAYSuite1Gov.ingestResultVotes(PROPOSAL, [{
      voterPubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
      vote: 'approve',
      signature: sig
    }], electorate);
    expect(governanceGOVVOTEREPLAYSuite1UpsertCalls().length, 'a leader cannot launder a seq-less vote back in').to.equal(0);
  });
  it('ingestResultVotes accepts seq-stamped evidence', async function () {
    let electorate = [{
      pubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex.toLowerCase()
    }];
    let sig = governanceGOVVOTEREPLAYSuite1Idn.sign(Governance.voteSigningPayload(PROPOSAL, 'approve', governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex, 2000));
    await governanceGOVVOTEREPLAYSuite1Gov.ingestResultVotes(PROPOSAL, [{
      voterPubkey: governanceGOVVOTEREPLAYSuite1Kp.pubkeyHex,
      vote: 'approve',
      signature: sig,
      seq: 2000
    }], electorate);
    let calls = governanceGOVVOTEREPLAYSuite1UpsertCalls();
    expect(calls.length).to.equal(1);
    expect(calls[0].args[1]).to.include(2000);
  });
}
describe('Governance GOV-VOTE-REPLAY-1', function () {
  registerGovernanceGOVVOTEREPLAYSuite1Part1.call(this);
  registerGovernanceGOVVOTEREPLAYSuite1Part2.call(this);
  registerGovernanceGOVVOTEREPLAYSuite1Part3.call(this);
  registerGovernanceGOVVOTEREPLAYSuite1Part4.call(this);
});
