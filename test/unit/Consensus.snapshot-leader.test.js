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
//
// CONSENSUS GUARD: config-PBFT leader election must read the same
// population the round's quorum was sized from. Everything below the quorum
// line is pinned to the block-locked capability snapshot
// (getQuorum(snapshot), proposal.validators, the weighted tally), but leader
// election used to index the LIVE validatorSet at three sites, so a hub whose
// local peer set had drifted from the block-locked staker set elected a
// different leader for the same seq and rejected the legitimate PRE_PREPARE.
//
// The operator ruled on 2026-08-11 that this lands as a PARTIAL fix: NEW_VIEW
// envelopes carry no block height and cannot lock a snapshot of their own, so
// _handleNewView pins only when this hub still holds the round's context and
// falls back to the live set otherwise. The last describe() block below is the
// executable record of that accepted residual window.

const sinon      = require('sinon');
const { expect } = require('chai');
const Consensus  = require('../../src/Consensus');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_4, makeValidator, makeFederationSnapshot } = require('../helpers/fixtures');

// The block-locked population: the four validators that were staked at the
// round's BTC block. Sorted member pubkeys are v1 < v2 < v3 < v4.
const SNAPSHOT_SET = VALIDATORS_4;
// The live P2P peer set AFTER registration churn added a fifth validator. The
// two rotations now disagree: for seq 5 view 0 the snapshot elects 5 % 4 = v2
// while the live set elects 5 % 5 = v1.
const DRIFTED_LIVE_SET = VALIDATORS_4.concat([makeValidator(5)]);
const SEQ  = 5;
const SNAPSHOT_LEADER = VALIDATORS_4[1];        // (5 + 0) % 4 = 1
const LIVE_SET_LEADER = DRIFTED_LIVE_SET[0];    // (5 + 0) % 5 = 0

function memberSetOf(validators) {
    return new Set(validators.map(v => v.pubkey.toLowerCase()));
}

describe('Consensus: snapshot-pinned leader election', function () {

    let hub, pm, consensus, snapshot;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        consensus = new Consensus(hub);
        snapshot = makeFederationSnapshot(SNAPSHOT_SET, 800000);
        hub.capabilitySnapshot = {
            getActiveValidatorSnapshot: sinon.stub().resolves(snapshot),
            getActiveWeightSnapshot:    sinon.stub().resolves(snapshot),
            getQuorum:                  sinon.stub().returns(3)
        };
        hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
        consensus.setValidatorSet(DRIFTED_LIVE_SET);
    });

    afterEach(function () {
        for (let [, prop] of consensus.pendingProposals) {
            if (prop && prop.timer) clearTimeout(prop.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // The election primitive
    // -----------------------------------------------------------------

    describe('_getLeader() / _leaderAt()', function () {

        it('indexes sorted snapshot pubkeys by (seq + view) % N', function () {
            let members = memberSetOf(SNAPSHOT_SET);
            expect(consensus._leaderAt(0, 0, members).pubkey).to.equal(SNAPSHOT_SET[0].pubkey);
            expect(consensus._leaderAt(1, 0, members).pubkey).to.equal(SNAPSHOT_SET[1].pubkey);
            expect(consensus._leaderAt(0, 2, members).pubkey).to.equal(SNAPSHOT_SET[2].pubkey);
            expect(consensus._leaderAt(4, 0, members).pubkey).to.equal(SNAPSHOT_SET[0].pubkey); // wraps
        });

        it('is unaffected by live validatorSet drift when a snapshot exists', function () {
            let members = memberSetOf(SNAPSHOT_SET);
            // Registration churn reorders AND extends the live set mid-round.
            consensus.setValidatorSet([VALIDATORS_4[3], makeValidator(5), VALIDATORS_4[0],
                                       VALIDATORS_4[2], VALIDATORS_4[1]]);
            expect(consensus._getLeader(SEQ, members).pubkey).to.equal(SNAPSHOT_LEADER.pubkey);
        });

        it('resolves the elected pubkey to its local P2P addr (snapshot rows carry none)', function () {
            let leader = consensus._getLeader(SEQ, memberSetOf(SNAPSHOT_SET));
            expect(leader.addr).to.equal(SNAPSHOT_LEADER.addr);
        });

        it('falls back to live-set rotation when no snapshot population is available', function () {
            expect(consensus._getLeader(SEQ, null)).to.equal(LIVE_SET_LEADER);
            expect(consensus._getLeader(SEQ, new Set())).to.equal(LIVE_SET_LEADER);
        });

        it('returns null with no snapshot and no live set', function () {
            consensus.setValidatorSet([]);
            expect(consensus._getLeader(SEQ, null)).to.equal(null);
        });
    });

    describe('_memberPubkeySet()', function () {
        it('lowercases the snapshot pubkeys', function () {
            let set = consensus._memberPubkeySet({ validators: [{ pubkey: 'AB'.repeat(32) }] });
            expect([...set]).to.deep.equal(['ab'.repeat(32)]);
        });

        it('returns null for a null, malformed or empty snapshot (legacy rotation)', function () {
            expect(consensus._memberPubkeySet(null)).to.equal(null);
            expect(consensus._memberPubkeySet({})).to.equal(null);
            expect(consensus._memberPubkeySet({ validators: [] })).to.equal(null);
            expect(consensus._memberPubkeySet({ validators: [{ amount: '1' }] })).to.equal(null);
        });
    });

    // blocker (2): a snapshot member whose addr binding differs between
    // hubs must still be recognized as leader, or the fix reintroduces the very
    // divergence it removes.
    describe('_isLeaderIdentity()', function () {
        it('matches on the verified pubkey when the addr binding differs', function () {
            let leader = { addr: 'ws://binding-a:10001', pubkey: 'ab'.repeat(32) };
            expect(consensus._isLeaderIdentity(leader, 'ws://binding-b:10001', 'ab'.repeat(32))).to.be.true;
        });

        it('matches on addr when the sender pubkey is unresolvable', function () {
            let leader = { addr: 'ws://binding-a:10001', pubkey: 'ab'.repeat(32) };
            expect(consensus._isLeaderIdentity(leader, 'ws://binding-a:10001', null)).to.be.true;
        });

        it('rejects a mismatch on both, and a null leader', function () {
            let leader = { addr: 'ws://binding-a:10001', pubkey: 'ab'.repeat(32) };
            expect(consensus._isLeaderIdentity(leader, 'ws://other:10001', 'cd'.repeat(32))).to.be.false;
            expect(consensus._isLeaderIdentity(null, 'ws://binding-a:10001', 'ab'.repeat(32))).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // propose(): the leader side
    // -----------------------------------------------------------------

    describe('propose()', function () {

        it('the SNAPSHOT-elected hub proposes even though the drifted live set would not elect it', async function () {
            pm.validatorAddr = SNAPSHOT_LEADER.addr;
            consensus.seq = SEQ - 1;

            let promise = consensus.propose({ cfg: 1 });
            await new Promise(r => setImmediate(r));

            expect(pm.broadcast.called, 'the pinned leader must open the round').to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_PRE_PREPARE');

            let pending = consensus.pendingProposals.get(SEQ);
            expect(pending.memberPubkeys).to.deep.equal(memberSetOf(SNAPSHOT_SET));
            clearTimeout(pending.timer);
            pending.resolved = true;
            pending.reject(new Error('test cleanup'));
            await promise.catch(() => {});
        });

        it('the LIVE-set-elected hub refuses, because the snapshot does not elect it', async function () {
            pm.validatorAddr = LIVE_SET_LEADER.addr;
            consensus.seq = SEQ - 1;

            try {
                await consensus.propose({ cfg: 1 });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Not the leader for seq ' + SEQ);
                expect(e.message).to.include(SNAPSHOT_LEADER.addr);
            }
            expect(pm.broadcast.called).to.be.false;
        });

        it('keeps the live-set rotation when the indexer gives no snapshot (single-node path)', async function () {
            // Non-federated hub: one validator, so the fail-closed federation
            // guard does not fire and the legacy fallback stays reachable.
            consensus.setValidatorSet([VALIDATORS_4[0]]);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            consensus.seq = SEQ - 1;

            // quorum 0 over a single node applies directly, which is the legacy
            // path this round must still take rather than refusing for want of a
            // pinned population.
            pm.getPeerStatus.returns([]);
            expect(await consensus.propose({ cfg: 1 })).to.be.true;
            expect(hub.applyConfig.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // _handlePrePrepare(): the follower side
    // -----------------------------------------------------------------

    describe('_handlePrePrepare()', function () {

        let config, digest;

        beforeEach(function () {
            // A third validator, following the round.
            pm.validatorAddr = VALIDATORS_4[2].addr;
            config = { cfg: 1 };
            digest = consensus._digest(config);
        });

        function prePrepare(sender, extra) {
            return consensus._handlePrePrepare(Object.assign({
                sender: sender,
                data: { seq: SEQ, view: 0, configDigest: digest, config: config, btcBlockHeight: 800000 }
            }, extra || {}));
        }

        it('accepts the SNAPSHOT-elected leader that the drifted live set would have rejected', async function () {
            await prePrepare(SNAPSHOT_LEADER.addr);

            let proposal = consensus.pendingProposals.get(SEQ);
            expect(proposal, 'the legitimate leader must open a follower proposal').to.exist;
            expect(proposal.prepares.has(SNAPSHOT_LEADER.addr)).to.be.true;
            expect(proposal.memberPubkeys).to.deep.equal(memberSetOf(SNAPSHOT_SET));
            expect(pm.broadcast.calledWith('PBFT_PREPARE', sinon.match.object)).to.be.true;
        });

        it('rejects the LIVE-set-elected leader the snapshot does not elect (no proposal, no PREPARE)', async function () {
            let warn = sinon.stub(console, 'warn');
            await prePrepare(LIVE_SET_LEADER.addr);

            expect(consensus.pendingProposals.size, 'a non-leader must not seed a proposal').to.equal(0);
            expect(pm.broadcast.called).to.be.false;
            expect(warn.calledWith(sinon.match(/from non-leader/))).to.be.true;
        });

        it('recognizes the elected leader by verified pubkey when its addr binding differs', async function () {
            // This hub's registry binds the elected key to a stale addr, so
            // _addrForPubkey resolves an addr the peer no longer speaks from.
            consensus.setValidatorSet(DRIFTED_LIVE_SET.map(v =>
                v.pubkey === SNAPSHOT_LEADER.pubkey ? { pubkey: v.pubkey, addr: 'ws://stale-binding:10001' } : v));

            await prePrepare('ws://validator-2-moved:10001',
                { sig_pubkey: SNAPSHOT_LEADER.pubkey });

            expect(consensus.pendingProposals.get(SEQ), 'a differing addr binding must not unseat the leader').to.exist;
        });

        it('re-runs the guard on a repeat PRE_PREPARE without a second snapshot lock', async function () {
            await prePrepare(SNAPSHOT_LEADER.addr);
            let locksAfterFirst = hub.capabilitySnapshot.getActiveValidatorSnapshot.callCount;

            // A non-leader replaying the same seq must be dropped, and must not
            // be able to force another indexer round trip.
            await prePrepare(LIVE_SET_LEADER.addr);
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.callCount).to.equal(locksAfterFirst);

            let proposal = consensus.pendingProposals.get(SEQ);
            expect(proposal.prepares.has(LIVE_SET_LEADER.addr)).to.be.false;
        });

        it('drops a viewless envelope before any snapshot work (anti-DoS pre-filter)', async function () {
            await consensus._handlePrePrepare({
                sender: SNAPSHOT_LEADER.addr,
                data: { seq: SEQ, configDigest: digest, config: config, btcBlockHeight: 800000 }
            });
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('drops a stale seq before any snapshot work (anti-DoS pre-filter)', async function () {
            consensus.lastAppliedSeq = SEQ;
            await prePrepare(SNAPSHOT_LEADER.addr);
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
            expect(consensus.pendingProposals.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // View change: the new leader comes from the same pinned population
    // -----------------------------------------------------------------

    describe('_handleViewChange() / _initiateViewChange()', function () {

        // (5 + 1) % 4 = 2 over the snapshot; (5 + 1) % 5 = 1 over the live set.
        const PINNED_NEW_LEADER = VALIDATORS_4[2];

        function seedProposal() {
            let proposal = {
                digest: 'd', view: 0, prepares: new Set(), commits: new Set(),
                resolved: false, applied: false, timer: null, resolve: null, reject: null,
                quorum: 2, weighted: false, validators: [],
                memberPubkeys: memberSetOf(SNAPSHOT_SET)
            };
            consensus.pendingProposals.set(SEQ, proposal);
            return proposal;
        }

        it('promotes the SNAPSHOT-elected node, not the one the drifted live set would elect', function () {
            seedProposal();
            pm.validatorAddr = PINNED_NEW_LEADER.addr;

            consensus._handleViewChange({ sender: VALIDATORS_4[0].addr, data: { view: 1, seq: SEQ } });
            consensus._handleViewChange({ sender: VALIDATORS_4[1].addr, data: { view: 1, seq: SEQ } });

            expect(consensus.view).to.equal(1);
            expect(pm.broadcast.calledWith('PBFT_NEW_VIEW', { view: 1, seq: SEQ }),
                'the pinned new leader must announce the view').to.be.true;
        });

        it('does NOT promote the live-set-elected node', function () {
            seedProposal();
            pm.validatorAddr = DRIFTED_LIVE_SET[1].addr;   // (5 + 1) % 5 = 1

            consensus._handleViewChange({ sender: VALIDATORS_4[0].addr, data: { view: 1, seq: SEQ } });
            consensus._handleViewChange({ sender: VALIDATORS_4[2].addr, data: { view: 1, seq: SEQ } });

            expect(consensus.view).to.equal(1);
            expect(pm.broadcast.calledWith('PBFT_NEW_VIEW', sinon.match.any)).to.be.false;
        });

        it('_initiateViewChange stashes the round population so the initiator keeps electing from it', function () {
            let members = memberSetOf(SNAPSHOT_SET);
            consensus._initiateViewChange(SEQ, 2, false, [], members);
            expect(consensus.viewChangeQuorums.get(SEQ).memberPubkeys).to.deep.equal(members);
            expect(consensus._memberPubkeysForSeq(SEQ)).to.deep.equal(members);
        });
    });

    // -----------------------------------------------------------------
    // _handleNewView(): the deliberately PARTIAL half (operator-accepted)
    // -----------------------------------------------------------------

    describe('_handleNewView() (partial pin, operator ruling)', function () {

        const PINNED_NEW_LEADER = VALIDATORS_4[2];     // (5 + 1) % 4 = 2
        const LIVE_NEW_LEADER   = DRIFTED_LIVE_SET[1]; // (5 + 1) % 5 = 1

        it('accepts the pinned leader when this hub still holds the round context', function () {
            consensus.pendingProposals.set(SEQ, {
                digest: 'd', timer: null, memberPubkeys: memberSetOf(SNAPSHOT_SET)
            });
            consensus._handleNewView({ sender: PINNED_NEW_LEADER.addr, data: { view: 1, seq: SEQ } });
            expect(consensus.view, 'the pinned leader announced its own view change').to.equal(1);
        });

        it('rejects the live-set leader when the round context pins a different one', function () {
            consensus.pendingProposals.set(SEQ, {
                digest: 'd', timer: null, memberPubkeys: memberSetOf(SNAPSHOT_SET)
            });
            consensus._handleNewView({ sender: LIVE_NEW_LEADER.addr, data: { view: 1, seq: SEQ } });
            expect(consensus.view).to.equal(0);
        });

        it('recovers the population from the stashed view-change context after the proposal is gone', function () {
            consensus.viewChangeQuorums.set(SEQ, {
                quorum: 2, weighted: false, validators: [], memberPubkeys: memberSetOf(SNAPSHOT_SET)
            });
            consensus._handleNewView({ sender: PINNED_NEW_LEADER.addr, data: { view: 1, seq: SEQ } });
            expect(consensus.view).to.equal(1);
        });

        // The accepted residual: with no round context for this seq there is no
        // block height on a NEW_VIEW to lock a snapshot from, so the live set is
        // used exactly as before. Named here so the divergence window is a
        // recorded property rather than an omission.
        it('ACCEPTED RESIDUAL: with no round context it falls back to the live set', function () {
            expect(consensus._memberPubkeysForSeq(SEQ)).to.equal(null);

            consensus._handleNewView({ sender: PINNED_NEW_LEADER.addr, data: { view: 1, seq: SEQ } });
            expect(consensus.view, 'unpinned: the snapshot leader is NOT recognized here').to.equal(0);

            consensus._handleNewView({ sender: LIVE_NEW_LEADER.addr, data: { view: 1, seq: SEQ } });
            expect(consensus.view, 'unpinned: the live-set leader still is').to.equal(1);
        });
    });
});
