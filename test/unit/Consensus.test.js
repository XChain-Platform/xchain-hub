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

const sinon          = require('sinon');
const { expect }     = require('chai');
const Consensus      = require('../../src/Consensus');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        makeValidator, WEIGHTED_VALIDATORS_4, makeWeightSnapshot } = require('../helpers/fixtures');

describe('Consensus (PBFT)', function () {

    let hub, pm, consensus;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        consensus = new Consensus(hub);
    });

    afterEach(function () {
        // Clean up timers
        for (let [, prop] of consensus.pendingProposals) {
            if (prop.timer) clearTimeout(prop.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        // Quorum = max(2f+1, ceil((N+1)/2)) where f = floor((N-1)/3) — the
        // majority floor stops 2f+1 degenerating to 1 at N=3. N<=1 returns 0.
        let cases = [
            { N: 1,  expected: 0, label: 'N=1 → 0 (single node)' },
            { N: 2,  expected: 2, label: 'N=2 → 2 (majority floor)' },
            { N: 3,  expected: 2, label: 'N=3 → 2 (majority floor)' },
            { N: 4,  expected: 3, label: 'N=4 → 3' },
            { N: 7,  expected: 5, label: 'N=7 → 5' },
            { N: 10, expected: 7, label: 'N=10 → 7' },
            { N: 13, expected: 9, label: 'N=13 → 9' }
        ];

        for (let c of cases) {
            it(c.label, function () {
                let validators = Array.from({ length: c.N }, (_, i) => makeValidator(i + 1));
                consensus.setValidatorSet(validators);
                expect(consensus._getQuorum()).to.equal(c.expected);
            });
        }

        it('falls back to live peer count when validator set is empty', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([
                { state: 'open' }, { state: 'open' }, { state: 'open' },
                { state: 'open' }, { state: 'open' }, { state: 'open' }
            ]);
            // N = 6 peers + 1 self = 7 → f = 2, quorum = 5
            expect(consensus._getQuorum()).to.equal(5);
        });

        it('returns 0 when no peers and no validators', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(consensus._getQuorum()).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // _getLeader()
    // -----------------------------------------------------------------

    describe('_getLeader()', function () {
        it('returns (seq + view) % N', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 0;
            expect(consensus._getLeader(0)).to.equal(VALIDATORS_3[0]);
            expect(consensus._getLeader(1)).to.equal(VALIDATORS_3[1]);
            expect(consensus._getLeader(3)).to.equal(VALIDATORS_3[0]); // wraps
        });

        it('view offset changes leader', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 1;
            // (0 + 1) % 3 = 1
            expect(consensus._getLeader(0)).to.equal(VALIDATORS_3[1]);
            // (1 + 1) % 3 = 2
            expect(consensus._getLeader(1)).to.equal(VALIDATORS_3[2]);
            // (2 + 1) % 3 = 0
            expect(consensus._getLeader(2)).to.equal(VALIDATORS_3[0]);
        });

        it('returns null for empty validator set', function () {
            consensus.setValidatorSet([]);
            expect(consensus._getLeader(0)).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // _isLeader()
    // -----------------------------------------------------------------

    describe('_isLeader()', function () {
        it('returns true when this node is the leader', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
            expect(consensus._isLeader(0)).to.be.true;
        });

        it('returns false when this node is not the leader', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[2].addr;
            expect(consensus._isLeader(0)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

    describe('_digest()', function () {
        it('returns a 64-char hex SHA-256 hash', function () {
            let d = consensus._digest({ foo: 'bar' });
            expect(d).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic', function () {
            let config = { a: 1, b: 2 };
            expect(consensus._digest(config)).to.equal(consensus._digest(config));
        });
    });

    // -----------------------------------------------------------------
    // propose() — single-node fallback
    // -----------------------------------------------------------------

    describe('propose()', function () {

        it('single-node applies config directly and returns true', async function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await consensus.propose({ test: true });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(hub.applyConfig.calledWith({ test: true })).to.be.true;
        });

        it('throws when not the leader', async function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.seq = 0;
            pm.validatorAddr = VALIDATORS_3[2].addr; // Not leader for seq 1

            try {
                await consensus.propose({ test: true });
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Not the leader');
            }
        });

        it('leader broadcasts PRE_PREPARE', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            consensus.seq = 0;
            pm.validatorAddr = VALIDATORS_4[1].addr; // Leader for seq 1: (1+0)%4 = 1

            let promise = consensus.propose({ cfg: 1 });

            // Wait for the async _lockSnapshot to resolve before checking broadcast
            await new Promise(r => setImmediate(r));

            // Should have broadcast PRE_PREPARE as first call
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('PBFT_PRE_PREPARE');
            expect(data.seq).to.equal(1);
            expect(data.view).to.equal(0);              // leader stamps its view for the follower identity-guard
            expect(data.config).to.deep.equal({ cfg: 1 });
            expect(data.configDigest).to.be.a('string');

            // Clean up — reject the pending promise
            let pending = consensus.pendingProposals.get(1);
            if (pending) {
                if (pending.timer) clearTimeout(pending.timer);
                pending.resolved = true;
                pending.reject(new Error('test cleanup'));
            }
            await promise.catch(() => {});
        });
    });

    // -----------------------------------------------------------------
    // PBFT message flow
    // -----------------------------------------------------------------

    describe('PBFT message flow', function () {

        beforeEach(function () {
            // Use VALIDATORS_4 (quorum=3) to prevent auto-completion in tests
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('PRE_PREPARE creates follower proposal and broadcasts PREPARE', async function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);

            // seq 5, view 0 → (5+0)%4 = 1 → VALIDATORS_4[1] is the rotation leader.
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, view: 0, configDigest: digest, config }
            });

            expect(consensus.pendingProposals.has(5)).to.be.true;
            let proposal = consensus.pendingProposals.get(5);
            expect(proposal.prepares.has(VALIDATORS_4[1].addr)).to.be.true; // proposer
            expect(proposal.prepares.has(VALIDATORS_4[0].addr)).to.be.true; // self
            // Broadcasts PREPARE (quorum=3, have 2 prepares, not yet met)
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_PREPARE');

            if (proposal.timer) clearTimeout(proposal.timer);
        });

        it('PRE_PREPARE from a non-leader for the claimed view is rejected (no proposal, no PREPARE)', async function () {
            // seq 5, view 0 → (5+0)%4 = 1, so VALIDATORS_4[1] is the only legitimate
            // proposer. A PRE_PREPARE from any other registered validator must NOT
            // create a pending proposal or broadcast a PREPARE — otherwise any
            // authenticated validator could drive an uncontested seq to commit its
            // own config. (Without the identity guard this would have been accepted.)
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[2].addr,                       // not the leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('PRE_PREPARE with no view field is rejected', async function () {
            // The leader must stamp its view so followers can resolve the rotation
            // leader; a viewless envelope cannot be identity-checked and is dropped.
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('PRE_PREPARE with wrong digest is rejected', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, view: 0, configDigest: 'bad-digest', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });

        it('PRE_PREPARE with missing fields is ignored', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: null, configDigest: null, config: null }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('second PRE_PREPARE for an already-pending seq with a conflicting digest is dropped (no PREPARE)', async function () {
            // First PRE_PREPARE establishes a pending proposal at seq 5 with digest A.
            let configA = { x: 1 };
            let digestA = consensus._digest(configA);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digestA, config: configA }
            });

            expect(consensus.pendingProposals.has(5)).to.be.true;
            expect(pm.broadcast.callCount).to.equal(1); // PREPARE for digest A

            // A second PRE_PREPARE arrives for the SAME seq with a different,
            // internally-valid config (digest B) — as can happen when two
            // leaders both propose for seq 5 during a view transition.
            let configB = { x: 2 };
            let digestB = consensus._digest(configB);
            expect(digestB).to.not.equal(digestA);

            // A competing leader from view 1: (5+1)%4 = 2 → VALIDATORS_4[2] is the
            // legitimate proposer at view 1, so this passes the identity guard and
            // is dropped only by the digest-conflict rule (two leaders, one seq).
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[2].addr,
                data: { seq: 5, view: 1, configDigest: digestB, config: configB }
            });

            // The conflicting message must be dropped: the existing proposal
            // is untouched (still digest A, no new prepares) and NO additional
            // PBFT_PREPARE is broadcast for the orphan digest B.
            let proposal = consensus.pendingProposals.get(5);
            expect(proposal.digest).to.equal(digestA);
            expect(proposal.prepares.has(VALIDATORS_4[2].addr)).to.be.false;
            expect(pm.broadcast.callCount).to.equal(1); // still just the one PREPARE for A

            if (proposal.timer) clearTimeout(proposal.timer);
        });

        it('PREPARE quorum triggers COMMIT broadcast', function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);

            // N=4, quorum=3. Start with 2 prepares
            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                commits: new Set(),
                resolved: false, applied: false, timer: null,
                resolve: null, reject: null
            });

            // Third prepare → quorum met
            consensus._handlePrepare({
                sender: VALIDATORS_4[2].addr,
                data: { seq: 5, configDigest: digest }
            });

            expect(pm.broadcast.called).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_COMMIT');
        });

        it('COMMIT quorum applies config and saves seq', async function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);

            let resolved = false;
            // N=4, quorum=3. Start with 2 commits
            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: () => { resolved = true; },
                reject: () => {}
            });

            // Third commit → quorum met
            consensus._handleCommit({
                sender: VALIDATORS_4[2].addr,
                data: { seq: 5, configDigest: digest }
            });

            // Wait for async apply
            await new Promise(r => setTimeout(r, 20));

            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(hub.applyConfig.calledWith(config)).to.be.true;
            expect(resolved).to.be.true;
            expect(consensus.applied.has(digest)).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // View change
    // -----------------------------------------------------------------

    describe('view change', function () {
        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('_initiateViewChange increments view and broadcasts', function () {
            consensus.view = 0;
            consensus._initiateViewChange(5);
            expect(consensus.view).to.equal(1);
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_VIEW_CHANGE');
        });

        it('VIEW_CHANGE quorum updates view', function () {
            consensus.view = 0;
            // N=4, quorum=3. Need 3 VIEW_CHANGE votes
            consensus._handleViewChange({
                sender: VALIDATORS_4[1].addr,
                data: { view: 1, seq: 5 }
            });
            consensus._handleViewChange({
                sender: VALIDATORS_4[2].addr,
                data: { view: 1, seq: 5 }
            });
            consensus._handleViewChange({
                sender: VALIDATORS_4[3].addr,
                data: { view: 1, seq: 5 }
            });
            // quorum = 3, 3 votes → accepted
            expect(consensus.view).to.equal(1);
        });

        // -------------------------------------------------------------
        // NEW_VIEW authenticity guards.
        // _handleNewView must not advance the view on any peer's say-so:
        // it only accepts a NEW_VIEW from the rotation-designated leader for
        // the claimed (seq, view), and only when it moves the view forward.
        // Without this a single Byzantine validator can steer leader
        // election by broadcasting escalating NEW_VIEW messages.
        // -------------------------------------------------------------

        it('NEW_VIEW from a non-leader peer does not advance the view', function () {
            consensus.view = 0;
            // Leader for (seq=5, view=1) = validators[(5+1) % 4] = validators[2].
            // A NEW_VIEW from any other validator must be ignored.
            consensus._handleNewView({
                sender: VALIDATORS_4[1].addr,
                data: { view: 1, seq: 5 }
            });
            expect(consensus.view).to.equal(0);
        });

        it('NEW_VIEW from the designated leader advances the view', function () {
            consensus.view = 0;
            // validators[(5+1) % 4] = validators[2] is the leader for (5, 1).
            consensus._handleNewView({
                sender: VALIDATORS_4[2].addr,
                data: { view: 1, seq: 5 }
            });
            expect(consensus.view).to.equal(1);
        });

        it('NEW_VIEW cannot rewind the view to a lower number', function () {
            consensus.view = 5;
            // Even from the correct leader for the lower view, a regression
            // is rejected — NEW_VIEW only moves the view forward.
            let idx = (5 + 2) % VALIDATORS_4.length;
            consensus._handleNewView({
                sender: VALIDATORS_4[idx].addr,
                data: { view: 2, seq: 5 }
            });
            expect(consensus.view).to.equal(5);
        });

        // -------------------------------------------------------------
        // Validator churn between proposal creation and view-change.
        // View-change acceptance must use the round-locked quorum
        // (proposal-creation snapshot), exactly like _checkPrepareQuorum
        // and _checkCommitQuorum — never a live recompute. Otherwise a set
        // that grew can stall the election (liveness) and a set that shrank
        // can let too few votes — even a single node — promote a new leader
        // (safety).
        // -------------------------------------------------------------

        it('follower view-change uses locked quorum from the in-flight proposal, not a live recompute (grow → liveness)', function () {
            // Proposal locked at N=4 → quorum 3.
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            consensus.view = 0;
            consensus.pendingProposals.set(5, {
                config: { x: 1 }, digest: 'd',
                prepares: new Set(), commits: new Set(),
                resolved: false, applied: false, timer: null,
                resolve: null, reject: null,
                quorum: 3
            });

            // Churn: set grows to N=7 → live quorum would be 5.
            consensus.setValidatorSet(VALIDATORS_7);
            expect(consensus._getQuorum()).to.equal(5);

            // Three distinct view-change votes — meets the locked quorum (3),
            // below the live one (5). Must accept on the locked value.
            consensus._handleViewChange({ sender: VALIDATORS_7[1].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_7[2].addr, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0); // 2 votes < 3, not yet
            consensus._handleViewChange({ sender: VALIDATORS_7[3].addr, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(1); // 3 votes == locked quorum → accepted
        });

        it('follower view-change holds at the locked quorum even when the set shrank (shrink → safety)', function () {
            // Proposal locked at N=7 → quorum 5.
            consensus.setValidatorSet(VALIDATORS_7);
            pm.validatorAddr = VALIDATORS_7[0].addr;
            consensus.view = 0;
            consensus.pendingProposals.set(5, {
                config: { x: 1 }, digest: 'd',
                prepares: new Set(), commits: new Set(),
                resolved: false, applied: false, timer: null,
                resolve: null, reject: null,
                quorum: 5
            });

            // Churn: set shrinks to N=3 → live quorum would be 2 (majority
            // floor). The locked quorum is still 5.
            consensus.setValidatorSet(VALIDATORS_3);
            expect(consensus._getQuorum()).to.equal(2);

            // Two distinct votes — would clear the live quorum (2), but must
            // NOT clear the locked quorum (5).
            consensus._handleViewChange({ sender: VALIDATORS_3[1].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_3[2].addr, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0);                 // not promoted
            expect(pm.broadcast.called).to.be.false;            // no NEW_VIEW broadcast
        });

        it('the initiating node recovers the locked quorum from viewChangeQuorums after its proposal is gone', function () {
            // Initiator path: the timeout deletes the proposal before
            // _initiateViewChange runs, so the initiator can't read
            // proposal.quorum — it relies on the stashed value.
            consensus.setValidatorSet(VALIDATORS_7);
            pm.validatorAddr = VALIDATORS_7[0].addr;
            consensus.view = 0;
            consensus.lastAppliedSeq = 0;

            // Initiate with the round-locked quorum (N=7 → 5). No proposal
            // remains in pendingProposals, mirroring the real timeout flow.
            consensus._initiateViewChange(5, 5);
            expect(consensus.view).to.equal(1);
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(consensus.viewChangeQuorums.get(5).quorum).to.equal(5);
            expect(consensus.viewChangeQuorums.get(5).weighted).to.equal(false);
            expect(pm.broadcast.callCount).to.equal(1);         // VIEW_CHANGE only

            // Churn: set shrinks to N=3 → live quorum 1.
            consensus.setValidatorSet(VALIDATORS_3);

            // Own vote was added by _initiateViewChange; add one more (size 2).
            consensus._handleViewChange({ sender: VALIDATORS_3[1].addr, data: { view: 1, seq: 5 } });
            expect(consensus.pendingViewChanges.get(1).size).to.equal(2);
            expect(pm.broadcast.callCount).to.equal(1);         // still no NEW_VIEW — 2 < locked 5
        });

        it('_initiateViewChange stashes the locked quorum and prunes already-applied rounds', function () {
            consensus.setValidatorSet(VALIDATORS_7);
            pm.validatorAddr = VALIDATORS_7[0].addr;
            consensus.lastAppliedSeq = 10;
            consensus.viewChangeQuorums.set(3, 5);  // stale (seq 3 ≤ lastApplied 10)

            consensus._initiateViewChange(12, 7);
            expect(consensus.viewChangeQuorums.has(3)).to.be.false; // pruned
            expect(consensus.viewChangeQuorums.get(12).quorum).to.equal(7);
        });
    });

    // -----------------------------------------------------------------
    // Sequence persistence
    // -----------------------------------------------------------------

    describe('sequence persistence', function () {
        it('_loadSeq reads from DB', async function () {
            hub.db.doQuery.resolves([{ value: '42' }]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(42);
        });

        it('_loadSeq defaults to 0 on empty result', async function () {
            hub.db.doQuery.resolves([]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(0);
        });

        it('_saveSeq writes to DB', async function () {
            await consensus._saveSeq(10);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('consensus_state');
            expect(args[1]).to.include('10');
        });

        it('_saveSeq swallows DB errors', async function () {
            hub.db.doQuery.rejects(new Error('db down'));
            await consensus._saveSeq(5); // must not throw
        });

        it('_loadSeq swallows DB errors and leaves seq at 0', async function () {
            hub.db.doQuery.rejects(new Error('db down'));
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------

    describe('start() / stop()', function () {
        it('start() loads the sequence and subscribes to peer messages', async function () {
            hub.db.doQuery.resolves([{ value: '7' }]);
            await consensus.start();
            expect(consensus.seq).to.equal(7);
            expect(consensus.lastAppliedSeq).to.equal(7);
            expect(pm.listenerCount('message')).to.equal(1);
        });

        it('stop() unsubscribes, rejects pending proposals, and clears all maps', async function () {
            await consensus.start();
            let rejected = null;
            consensus.pendingProposals.set(9, {
                resolved: false, timer: setTimeout(() => {}, 60000),
                reject: (e) => { rejected = e; }
            });
            consensus.viewChangeQuorums.set(9, 3);
            consensus.pendingViewChanges.set(1, new Set(['a']));

            await consensus.stop();

            expect(consensus._messageHandler).to.equal(null);
            expect(pm.listenerCount('message')).to.equal(0);
            expect(rejected).to.be.an('error');
            expect(consensus.pendingProposals.size).to.equal(0);
            expect(consensus.viewChangeQuorums.size).to.equal(0);
            expect(consensus.pendingViewChanges.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // _handleMessage dispatch
    // -----------------------------------------------------------------

    describe('_handleMessage dispatch', function () {
        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('routes PREPARE / COMMIT / VIEW_CHANGE / NEW_VIEW and ignores unknown types', function () {
            let prepare = sinon.spy(consensus, '_handlePrepare');
            let commit  = sinon.spy(consensus, '_handleCommit');
            let vc      = sinon.spy(consensus, '_handleViewChange');
            let nv      = sinon.spy(consensus, '_handleNewView');

            consensus._handleMessage({ type: 'PBFT_PREPARE',     data: { seq: 1, configDigest: 'd' } });
            consensus._handleMessage({ type: 'PBFT_COMMIT',      data: { seq: 1, configDigest: 'd' } });
            consensus._handleMessage({ type: 'PBFT_VIEW_CHANGE', data: { view: 1, seq: 1 } });
            consensus._handleMessage({ type: 'PBFT_NEW_VIEW',    data: { view: 1, seq: 1 } });
            expect(() => consensus._handleMessage({ type: 'NOPE', data: {} })).to.not.throw();

            expect(prepare.calledOnce).to.be.true;
            expect(commit.calledOnce).to.be.true;
            expect(vc.calledOnce).to.be.true;
            expect(nv.calledOnce).to.be.true;
        });

        it('routes PRE_PREPARE and swallows handler errors', async function () {
            // Force _lockSnapshot to throw inside the async handler so the
            // dispatch-site .catch is exercised.
            hub.capabilitySnapshot = { getActiveValidatorSnapshot: () => { throw new Error('boom'); }, getQuorum: () => 3 };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let config = { x: 1 };
            let digest = consensus._digest(config);
            consensus._handleMessage({
                type: 'PBFT_PRE_PREPARE',
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });
            await new Promise(r => setImmediate(r));
            expect(consensus.pendingProposals.has(5)).to.be.false; // threw before creating
        });
    });

    // -----------------------------------------------------------------
    // _lockSnapshot + snapshot-quorum propose
    // -----------------------------------------------------------------

    describe('_lockSnapshot()', function () {
        it('returns the snapshot acquired at the resolved BTC tip', async function () {
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000 }),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let { snapshot, weighted } = await consensus._lockSnapshot();
            expect(snapshot).to.deep.equal({ blockIndex: 800000 });
            expect(weighted).to.equal(false); // hub.network unset → count path
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledWith(800000)).to.be.true;
        });

        it('honours an explicit block-height override without resolving the tip', async function () {
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 42 }),
                getQuorum: sinon.stub().returns(1)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(999);
            await consensus._lockSnapshot(42);
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledWith(42)).to.be.true;
            expect(hub._resolveBtcLatestBlock.called).to.be.false;
        });

        it('returns null snapshot when no capabilitySnapshot is wired', async function () {
            expect((await consensus._lockSnapshot()).snapshot).to.equal(null);
        });

        it('returns null snapshot when no BTC tip can be resolved', async function () {
            hub.capabilitySnapshot = { getActiveValidatorSnapshot: sinon.stub(), getQuorum: sinon.stub() };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            expect((await consensus._lockSnapshot()).snapshot).to.equal(null);
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
        });

        it('propose() locks the federation snapshot quorum and stamps the block height', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // leader for seq 1
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000 }),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let promise = consensus.propose({ cfg: 1 });
            await new Promise(r => setImmediate(r));

            let pending = consensus.pendingProposals.get(1);
            expect(pending.quorum).to.equal(3);
            expect(pending.btcBlockHeight).to.equal(800000);
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('PBFT_PRE_PREPARE');
            expect(data.btcBlockHeight).to.equal(800000);

            clearTimeout(pending.timer);
            pending.resolved = true;
            pending.reject(new Error('cleanup'));
            await promise.catch(() => {});
        });
    });

    // -----------------------------------------------------------------
    // propose() edge cases + timeouts
    // -----------------------------------------------------------------

    describe('propose() additional paths', function () {
        it('warns but still applies in single-node mode when MIN_VALIDATORS > 1', async function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            consensus.minValidators = 3;
            let result = await consensus.propose({ x: 1 });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnce).to.be.true;
        });

        it('times out → rejects the promise and initiates a view change', async function () {
            let clock = sinon.useFakeTimers();
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // leader for seq 1
            consensus.timeout = 1000;

            let promise = consensus.propose({ cfg: 1 });
            let caught = null;
            promise.catch(e => { caught = e; });
            await clock.tickAsync(1001);

            expect(caught).to.be.an('error');
            expect(caught.message).to.include('Consensus timeout');
            expect(consensus.view).to.equal(1);                 // view change initiated
            expect(consensus.pendingProposals.has(1)).to.be.false;
            let vc = pm.broadcast.getCalls().find(c => c.args[0] === 'PBFT_VIEW_CHANGE');
            expect(vc).to.exist;
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // PRE_PREPARE stale seq + follower expiry
    // -----------------------------------------------------------------

    describe('PRE_PREPARE replay + follower expiry', function () {
        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('rejects a PRE_PREPARE whose seq is at/below the last applied seq', async function () {
            consensus.lastAppliedSeq = 10;
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });

        it('expires a follower proposal on its (doubled) timeout', async function () {
            let clock = sinon.useFakeTimers();
            consensus.timeout = 1000;
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.true;
            await clock.tickAsync(2001); // followers wait timeout * 2
            expect(consensus.pendingProposals.has(5)).to.be.false;
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // COMMIT apply-error path
    // -----------------------------------------------------------------

    describe('COMMIT apply failure', function () {
        it('rejects the proposer promise and drops the proposal when applyConfig throws', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            hub.applyConfig.rejects(new Error('db down'));

            let config = { x: 1 };
            let digest = consensus._digest(config);
            let rejected = null;
            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits:  new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: () => {}, reject: (e) => { rejected = e; }, quorum: 3
            });

            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, data: { seq: 5, configDigest: digest } });
            await new Promise(r => setTimeout(r, 20));

            expect(rejected).to.be.an('error');
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // VIEW_CHANGE / NEW_VIEW remaining branches
    // -----------------------------------------------------------------

    describe('view change — remaining branches', function () {
        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('ignores VIEW_CHANGE with non-numeric fields', function () {
            consensus._handleViewChange({ sender: 'a', data: { view: 'x', seq: 5 } });
            expect(consensus.pendingViewChanges.size).to.equal(0);
        });

        it('ignores VIEW_CHANGE when the computed quorum is 0', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            consensus._handleViewChange({ sender: 'a', data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0);
        });

        it('on quorum where this node is the new leader, broadcasts NEW_VIEW and prunes lower views', function () {
            pm.validatorAddr = VALIDATORS_4[2].addr; // leader for (seq 5, view 1)
            consensus.view = 0;
            consensus.pendingViewChanges.set(0, new Set(['stale'])); // lower view to prune

            consensus._handleViewChange({ sender: VALIDATORS_4[1].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_4[3].addr, data: { view: 1, seq: 5 } });
            consensus._handleViewChange({ sender: VALIDATORS_4[0].addr, data: { view: 1, seq: 5 } });

            expect(consensus.view).to.equal(1);
            let nv = pm.broadcast.getCalls().find(c => c.args[0] === 'PBFT_NEW_VIEW');
            expect(nv).to.exist;
            expect(consensus.pendingViewChanges.has(0)).to.be.false; // pruned (0 < 1)
            expect(consensus.pendingViewChanges.has(1)).to.be.false; // cleared on accept
        });

        it('ignores NEW_VIEW with non-numeric fields', function () {
            consensus._handleNewView({ sender: 'a', data: { view: null, seq: 5 } });
            expect(consensus.view).to.equal(0);
        });

        it('ignores NEW_VIEW when the validator set is empty', function () {
            consensus.setValidatorSet([]);
            consensus._handleNewView({ sender: 'a', data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Remaining guard branches
    // -----------------------------------------------------------------

    describe('guard branches', function () {
        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('rejects a PRE_PREPARE with a non-positive seq', async function () {
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: -1, configDigest: 'd', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('_handlePrePrepare uses the snapshot quorum when a snapshot is available', async function () {
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 900000 }),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(900000);
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 900000 }
            });
            let p = consensus.pendingProposals.get(5);
            expect(p.quorum).to.equal(3);
            expect(p.btcBlockHeight).to.equal(900000);
            if (p.timer) clearTimeout(p.timer);
        });

        it('ignores a PREPARE with no configDigest', function () {
            expect(() => consensus._handlePrepare({ sender: 'a', data: { seq: 5 } })).to.not.throw();
        });

        it('ignores a PREPARE whose digest does not match the proposal', function () {
            consensus.pendingProposals.set(5, { digest: 'right', prepares: new Set(), resolved: false, quorum: 3 });
            consensus._handlePrepare({ sender: 'a', data: { seq: 5, configDigest: 'wrong' } });
            expect(consensus.pendingProposals.get(5).prepares.size).to.equal(0);
        });

        it('ignores a COMMIT with no configDigest', function () {
            expect(() => consensus._handleCommit({ sender: 'a', data: { seq: 5 } })).to.not.throw();
        });

        it('ignores a COMMIT whose digest does not match the proposal', function () {
            consensus.pendingProposals.set(5, { digest: 'right', commits: new Set(), applied: false, quorum: 3 });
            consensus._handleCommit({ sender: 'a', data: { seq: 5, configDigest: 'wrong' } });
            expect(consensus.pendingProposals.get(5).commits.size).to.equal(0);
        });

        it('_checkPrepareQuorum returns when the proposal is resolved', function () {
            consensus.pendingProposals.set(5, { resolved: true });
            expect(() => consensus._checkPrepareQuorum(5)).to.not.throw();
        });

        it('_checkCommitQuorum returns when the proposal is already applied', function () {
            consensus.pendingProposals.set(5, { applied: true });
            expect(() => consensus._checkCommitQuorum(5)).to.not.throw();
        });

        it('applies a follower proposal (no resolve handler) on commit quorum', async function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);
            consensus.pendingProposals.set(5, {
                config, digest, prepares: new Set(),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, resolve: null, reject: null, quorum: 3
            });
            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, data: { seq: 5, configDigest: digest } });
            await new Promise(r => setTimeout(r, 20));
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(consensus.applied.has(digest)).to.be.true;
        });

        it('swallows a follower apply error when there is no reject handler', async function () {
            hub.applyConfig.rejects(new Error('db down'));
            let config = { x: 1 };
            let digest = consensus._digest(config);
            consensus.pendingProposals.set(5, {
                config, digest, prepares: new Set(),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, resolve: null, reject: null, quorum: 3
            });
            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, data: { seq: 5, configDigest: digest } });
            await new Promise(r => setTimeout(r, 20));
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });

        it('_getQuorum returns 0 with neither validators nor a peer manager', function () {
            consensus.setValidatorSet([]);
            consensus.peerManager = null;
            expect(consensus._getQuorum()).to.equal(0);
        });

        it('_loadSeq treats a non-numeric stored value as 0', async function () {
            hub.db.doQuery.resolves([{ value: 'abc' }]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // STAKE_WEIGHTED_QUORUM (WI-1) — weighted config consensus
    // -----------------------------------------------------------------

    describe('STAKE_WEIGHTED_QUORUM (WI-1)', function () {

        const WHALE = WEIGHTED_VALIDATORS_4[0];        // weight 1000, >2/3 of S=1300
        const SMALL = WEIGHTED_VALIDATORS_4.slice(1);  // three sources of 100 each

        // Validators as the engine stores them (lowercased pubkeys).
        function normValidators() {
            return WEIGHTED_VALIDATORS_4.map(v => ({
                pubkey: v.pubkey.toLowerCase(), source: v.source, weight: v.weight
            }));
        }
        // The address-set ({pubkey,addr}) form fed to setValidatorSet.
        function addrSet() {
            return WEIGHTED_VALIDATORS_4.map(v => ({ pubkey: v.pubkey, addr: v.addr }));
        }
        // Make the local node the whale (its self pubkey clears quorum alone).
        function beWhale() {
            consensus.setValidatorSet(addrSet());
            pm.validatorAddr = WHALE.addr;
            hub.getIdentity = sinon.stub().returns({ getPubkeyHex: () => WHALE.pubkey });
        }

        describe('_lockSnapshot()', function () {
            it('weighted: locks the source-keyed weight snapshot at/above activation', async function () {
                hub.network = 'testnet';   // activation height 0
                hub._resolveBtcLatestBlock = sinon.stub().resolves(1);
                hub.capabilitySnapshot = {
                    getActiveWeightSnapshot:    sinon.stub().resolves(makeWeightSnapshot(WEIGHTED_VALIDATORS_4, 1)),
                    getActiveValidatorSnapshot: sinon.stub().resolves({ blockIndex: 1, count: 4, validators: [] }),
                    getQuorum:                  sinon.stub().returns(3)
                };
                let { snapshot, weighted } = await consensus._lockSnapshot();
                expect(weighted).to.equal(true);
                expect(hub.capabilitySnapshot.getActiveWeightSnapshot.calledWith(1)).to.be.true;
                expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
                expect(snapshot.validators[0].source).to.equal('srcWhale');
            });

            it('count: locks the legacy snapshot below the activation height', async function () {
                hub.network = 'mainnet';   // activation height 999999999 (placeholder)
                hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
                hub.capabilitySnapshot = {
                    getActiveWeightSnapshot:    sinon.stub().resolves(null),
                    getActiveValidatorSnapshot: sinon.stub().resolves({ blockIndex: 800000, count: 4, validators: [] }),
                    getQuorum:                  sinon.stub().returns(3)
                };
                let { weighted } = await consensus._lockSnapshot();
                expect(weighted).to.equal(false);
                expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledWith(800000)).to.be.true;
                expect(hub.capabilitySnapshot.getActiveWeightSnapshot.called).to.be.false;
            });
        });

        describe('_quorumMet()', function () {
            it('count mode: vote-set size vs the round-locked quorum', function () {
                let ctx = { weighted: false, quorum: 3 };
                expect(consensus._quorumMet(ctx, new Set(['a', 'b']), null)).to.equal(false);
                expect(consensus._quorumMet(ctx, new Set(['a', 'b', 'c']), null)).to.equal(true);
            });

            it('weighted mode: whale clears alone; a small-stake count-majority does not', function () {
                let ctx = { weighted: true, validators: normValidators() };
                // Whale alone (a COUNT minority of one) — 3·1000 > 2·1300.
                expect(consensus._quorumMet(ctx, new Set(), new Set([WHALE.pubkey.toLowerCase()]))).to.equal(true);
                // All three small sources (a COUNT majority) — 3·300 = 900 !> 2600.
                expect(consensus._quorumMet(ctx, new Set(), new Set(SMALL.map(v => v.pubkey.toLowerCase())))).to.equal(false);
            });
        });

        describe('_resolveSenderPubkey()', function () {
            it('prefers envelope.sig_pubkey (lowercased)', function () {
                expect(consensus._resolveSenderPubkey({ sender: 'ws://x', sig_pubkey: 'AABB' })).to.equal('aabb');
            });
            it('falls back to the addr→pubkey registry', function () {
                pm.validatorPubkeys = new Map([['ws://x', 'CCDD']]);
                expect(consensus._resolveSenderPubkey({ sender: 'ws://x' })).to.equal('ccdd');
            });
            it('returns null when neither resolves', function () {
                pm.validatorPubkeys = new Map();
                expect(consensus._resolveSenderPubkey({ sender: 'ws://x' })).to.equal(null);
            });
        });

        it('propose() weighted: proposal carries weighted + source-keyed validators + self pubkey', async function () {
            // Equal-weight snapshot so the proposer's lone self-vote stays sub-quorum
            // (3·100 !> 2·400) and the proposal remains pending to inspect — with the
            // real whale snapshot it would clear 3S>2S on its own vote and self-delete.
            const EQUAL = WEIGHTED_VALIDATORS_4.map(v => ({ pubkey: v.pubkey, addr: v.addr, source: v.source, weight: '100' }));
            hub.network = 'testnet';
            hub._resolveBtcLatestBlock = sinon.stub().resolves(1);
            hub.capabilitySnapshot = {
                getActiveWeightSnapshot:    sinon.stub().resolves(makeWeightSnapshot(EQUAL, 1)),
                getActiveValidatorSnapshot: sinon.stub().resolves({ blockIndex: 1, count: 4, validators: [] }),
                getQuorum:                  sinon.stub().returns(3)
            };
            beWhale();
            consensus.seq = 3;   // → proposes seq 4, whose leader is validatorSet[0] (self)

            let promise = consensus.propose({ cfg: 1 });
            await new Promise(r => setImmediate(r));

            let p = consensus.pendingProposals.get(4);
            expect(p.weighted).to.equal(true);
            expect(p.validators.length).to.equal(4);
            expect(p.preparePubkeys.has(WHALE.pubkey.toLowerCase())).to.be.true;

            clearTimeout(p.timer);
            p.resolved = true;
            p.reject(new Error('cleanup'));
            await promise.catch(() => {});
        });

        describe('PREPARE / COMMIT weighted', function () {
            // Hand-built weighted proposal (mirrors the count-path PBFT-flow tests).
            function weightedProposal(quorum) {
                return {
                    config: { cfg: 1 }, digest: 'd', prepares: new Set(), commits: new Set(),
                    resolved: false, applied: false, timer: null, resolve: null, reject: null,
                    snapshot: null, quorum: (quorum != null ? quorum : 3), btcBlockHeight: 1,
                    weighted: true, validators: normValidators(),
                    preparePubkeys: new Set(), commitPubkeys: new Set()
                };
            }

            beforeEach(beWhale);

            it('whale PREPARE alone triggers COMMIT broadcast + seeds self commit pubkey', function () {
                let p = weightedProposal();
                p.preparePubkeys.add(WHALE.pubkey.toLowerCase());
                consensus.pendingProposals.set(1, p);
                consensus._checkPrepareQuorum(1);
                expect(p._commitSent).to.equal(true);
                expect(pm.broadcast.calledWith('PBFT_COMMIT')).to.be.true;
                expect(p.commitPubkeys.has(WHALE.pubkey.toLowerCase())).to.be.true;
            });

            it('a small-stake COUNT majority PREPARE does NOT trigger COMMIT', function () {
                let p = weightedProposal();
                for (let v of SMALL) p.preparePubkeys.add(v.pubkey.toLowerCase());
                consensus.pendingProposals.set(1, p);
                consensus._checkPrepareQuorum(1);
                expect(p._commitSent).to.not.equal(true);
                expect(pm.broadcast.called).to.be.false;
            });

            it('whale COMMIT alone applies the config', async function () {
                let p = weightedProposal();
                p.commitPubkeys.add(WHALE.pubkey.toLowerCase());
                consensus.pendingProposals.set(1, p);
                consensus._checkCommitQuorum(1);
                await new Promise(r => setImmediate(r));   // _applyConfig is async
                expect(hub.applyConfig.calledWith({ cfg: 1 })).to.be.true;
            });
        });

        describe('view-change weighted', function () {
            beforeEach(beWhale);

            it('_initiateViewChange stashes the weighted context + seeds self view-change pubkey', function () {
                consensus._initiateViewChange(5, 3, true, normValidators());
                let ctx = consensus.viewChangeQuorums.get(5);
                expect(ctx.quorum).to.equal(3);
                expect(ctx.weighted).to.equal(true);
                expect(ctx.validators.length).to.equal(4);
                expect(consensus.pendingViewChangePubkeys.get(consensus.view).has(WHALE.pubkey.toLowerCase())).to.be.true;
            });

            it('whale view-change vote alone promotes the view (proposal-gone initiator path)', function () {
                // No proposal in pendingProposals — context recovered from the stash.
                consensus.viewChangeQuorums.set(5, { quorum: 3, weighted: true, validators: normValidators() });
                consensus._handleViewChange({ sender: WHALE.addr, sig_pubkey: WHALE.pubkey, data: { view: 1, seq: 5 } });
                expect(consensus.view).to.equal(1);
            });

            it('a small-stake COUNT majority view-change does NOT promote the view', function () {
                consensus.viewChangeQuorums.set(5, { quorum: 3, weighted: true, validators: normValidators() });
                for (let v of SMALL)
                    consensus._handleViewChange({ sender: v.addr, sig_pubkey: v.pubkey, data: { view: 1, seq: 5 } });
                expect(consensus.view).to.equal(0);
            });
        });

        it('stop() clears pendingViewChangePubkeys', async function () {
            consensus.pendingViewChangePubkeys.set(1, new Set(['x']));
            await consensus.stop();
            expect(consensus.pendingViewChangePubkeys.size).to.equal(0);
        });
    });
});
