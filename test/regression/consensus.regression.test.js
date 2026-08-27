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

const sinon          = require('sinon');
const { expect }     = require('chai');
const Consensus      = require('../../src/Consensus');
const { createMockHub }     = require('../helpers/mockHub');
const { waitUntil }         = require('../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        makeValidator, makeFederationSnapshot } = require('../helpers/fixtures');

describe('Regression: Consensus (PBFT)', function () {

    let hub, pm, consensus;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        consensus = new Consensus(hub);
    });

    afterEach(function () {
        for (let [, prop] of consensus.pendingProposals) {
            if (prop.timer) clearTimeout(prop.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // REG-CON-001: Leader rotation determinism
    // -----------------------------------------------------------------

    describe('REG-CON-001: Leader rotation follows validators[seq % len]', function () {
        it('rotates through validators deterministically @regression-p0', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            consensus.view = 0;
            expect(consensus._getLeader(0)).to.equal(VALIDATORS_4[0]);
            expect(consensus._getLeader(1)).to.equal(VALIDATORS_4[1]);
            expect(consensus._getLeader(2)).to.equal(VALIDATORS_4[2]);
            expect(consensus._getLeader(3)).to.equal(VALIDATORS_4[3]);
            expect(consensus._getLeader(4)).to.equal(VALIDATORS_4[0]); // wraps
        });

        it('view offset shifts leader selection @regression-p0', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            consensus.view = 1;
            expect(consensus._getLeader(0)).to.equal(VALIDATORS_3[1]);
            expect(consensus._getLeader(1)).to.equal(VALIDATORS_3[2]);
            expect(consensus._getLeader(2)).to.equal(VALIDATORS_3[0]);
        });

        it('returns null for empty validator set @regression-p0', function () {
            consensus.setValidatorSet([]);
            expect(consensus._getLeader(0)).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-002: Full PBFT flow applies config on 2f+1 quorum
    // -----------------------------------------------------------------

    describe('REG-CON-002: PRE_PREPARE → PREPARE → COMMIT applies config on quorum', function () {

        beforeEach(function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('full PBFT flow results in config applied @regression-p0', async function () {
            let config = { key: 'regression-test' };
            let digest = consensus._digest(config);

            // #4168: a 4-member validator set is a federation regardless of
            // MIN_VALIDATORS now, so a follower fails closed without the
            // deterministic snapshot a real hub locks each round. Supply it;
            // quorum 3 is what _getQuorum() returns for N=4, so what this
            // regression measures is unchanged.
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(makeFederationSnapshot(VALIDATORS_4, 800000)),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            // Step 1: PRE_PREPARE from leader creates proposal
            // (seq 5, view 0 → (5+0)%4 = 1 → VALIDATORS_4[1] is the rotation leader)
            // _handlePrePrepare is async (locks the federation snapshot before
            // broadcasting PREPARE), so the flow must be awaited.
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });
            expect(consensus.pendingProposals.has(5)).to.be.true;

            // Step 2: Third PREPARE reaches quorum → COMMIT broadcast
            consensus._handlePrepare({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { seq: 5, configDigest: digest }
            });
            expect(pm.broadcast.calledWith('PBFT_COMMIT')).to.be.true;

            // Step 3: Gather commits to reach quorum
            let resolved = false;
            let pending = consensus.pendingProposals.get(5);
            pending.resolve = () => { resolved = true; };
            pending.reject = () => {};
            pending._commitSent = true;

            // Add self commit
            pending.commits.add(VALIDATORS_4[0].addr);

            // Second commit
            consensus._handleCommit({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, configDigest: digest }
            });

            // Third commit → quorum met
            consensus._handleCommit({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { seq: 5, configDigest: digest }
            });

            // The proposer promise resolves only after the apply AND the seq write, so
            // it is the last observable of the round: polling the apply alone would
            // race the seq write and re-introduce the flake from the other side.
            await waitUntil(() => resolved, { label: 'the commit quorum to apply the config and resolve the proposer' });
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(hub.applyConfig.calledWith(config)).to.be.true;
            expect(resolved).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-003: Config not applied without 2f+1 PREPARE votes
    // -----------------------------------------------------------------

    describe('REG-CON-003: Config not applied without PREPARE quorum', function () {
        it('insufficient prepares do not trigger COMMIT @regression-p0', async function () {
            consensus.setValidatorSet(VALIDATORS_4); // quorum=3
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let config = { x: 1 };
            let digest = consensus._digest(config);

            // #4168: supply the deterministic snapshot the federation guard now
            // requires for a multi-member set (quorum 3 = _getQuorum() at N=4).
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(makeFederationSnapshot(VALIDATORS_4, 800000)),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            // Only 1 prepare (from PRE_PREPARE sender) + self = 2, need 3
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });

            // PREPARE broadcast sent, but no COMMIT should be broadcast yet
            expect(pm.broadcast.callCount).to.equal(1);
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_PREPARE');

            let pending = consensus.pendingProposals.get(5);
            if (pending && pending.timer) clearTimeout(pending.timer);
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-004: Config not applied without 2f+1 COMMIT votes
    // -----------------------------------------------------------------

    describe('REG-CON-004: Config not applied without COMMIT quorum', function () {
        it('insufficient commits do not apply config @regression-p0', async function () {
            consensus.setValidatorSet(VALIDATORS_4); // quorum=3
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let config = { x: 1 };
            let digest = consensus._digest(config);

            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits: new Set([VALIDATORS_4[0].addr]), // only 1 commit
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: () => {}, reject: () => {}
            });

            // Second commit → still only 2, need 3
            consensus._handleCommit({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, configDigest: digest }
            });

            // One vote short of quorum, so wait on the round the votes landed in rather
            // than on a clock: both commits are recorded and no third can arrive.
            await waitUntil(() => consensus.pendingProposals.get(5).commits.size === 2, { label: 'the second commit to be tallied' });
            expect(hub.applyConfig.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-005: View change on PBFT timeout
    // -----------------------------------------------------------------

    describe('REG-CON-005: View change triggered on timeout', function () {
        it('_initiateViewChange increments view and broadcasts VIEW_CHANGE @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            consensus.view = 0;

            consensus._initiateViewChange(5);

            expect(consensus.view).to.equal(1);
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_VIEW_CHANGE');
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-006: Sequence number persisted and restored
    // -----------------------------------------------------------------

    describe('REG-CON-006: Sequence number persistence', function () {
        it('_loadSeq reads from DB @regression-p1', async function () {
            hub.db.doQuery.resolves([{ value: '42' }]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(42);
        });

        it('_loadSeq defaults to 0 on empty result @regression-p1', async function () {
            hub.db.doQuery.resolves([]);
            await consensus._loadSeq();
            expect(consensus.seq).to.equal(0);
        });

        it('_saveSeq writes to DB @regression-p1', async function () {
            await consensus._saveSeq(10);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('consensus_state');
            expect(args[1]).to.include('10');
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-007: Replay prevention via stale sequence numbers
    // -----------------------------------------------------------------

    describe('REG-CON-007: Replay prevention', function () {
        it('PRE_PREPARE with stale seq (below lastAppliedSeq) is rejected @regression-p0', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            consensus.lastAppliedSeq = 10; // Already applied through seq 10

            let config = { x: 1 };
            let digest = consensus._digest(config);

            // Attempt with seq 5 (below lastAppliedSeq)
            // (sender is the legit (seq 5, view 0) leader, so the stale-seq guard,
            // not the identity guard, is what rejects it)
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config }
            });

            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-008: Single-node fallback
    // -----------------------------------------------------------------

    describe('REG-CON-008: Single-node applies config directly', function () {
        it('no peers → config applied without consensus @regression-p1', async function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await consensus.propose({ singleNode: true });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(hub.applyConfig.calledWith({ singleNode: true })).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-009: Digest determinism
    // -----------------------------------------------------------------

    describe('REG-CON-009: Digest computation is deterministic', function () {
        it('same payload → same digest @regression-p0', function () {
            let config = { a: 1, b: 'test', c: [1, 2, 3] };
            let d1 = consensus._digest(config);
            let d2 = consensus._digest(config);
            expect(d1).to.equal(d2);
            expect(d1).to.match(/^[0-9a-f]{64}$/);
        });

        it('different payload → different digest @regression-p0', function () {
            expect(consensus._digest({ a: 1 })).to.not.equal(consensus._digest({ a: 2 }));
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-011: PRE_PREPARE carries the requested tip, not the buried one
    // -----------------------------------------------------------------

    describe('REG-CON-011: leader and follower bury the reorg buffer once', function () {
        // Board #3080. CapabilitySnapshot buries every height it is handed by
        // HUB_SNAPSHOT_REORG_BUFFER, so the snapshot a leader locks is already
        // at tip - buffer. Stamping that buried value into PRE_PREPARE made the
        // follower bury it a second time and lock at tip - 2*buffer: two hubs,
        // one round, different validator sets whenever the set changed across
        // that window.
        //
        // The fake below applies the real burial rather than echoing the
        // request, which is the whole point: the pre-existing stubs return a
        // fixed blockIndex, so leader and follower agreed by construction and
        // no assertion on them could see this.
        const BUFFER = 6;

        function buryingSnapshotFake() {
            return {
                getActiveValidatorSnapshot: (blockIndex) =>
                    ({ blockIndex: Math.max(0, Number(blockIndex) - BUFFER), validators: [], count: 4 }),
                getQuorum: () => 3
            };
        }

        it('follower locks the same block the leader locked @regression-p0', async function () {
            const TIP = 800000;
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // leader for seq 1
            hub.capabilitySnapshot = buryingSnapshotFake();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(TIP);

            let promise = consensus.propose({ cfg: 1 });
            await new Promise(r => setImmediate(r));

            let pending = consensus.pendingProposals.get(1);
            let [, data] = pm.broadcast.getCall(0).args;

            // What the leader actually resolved its validator set at.
            let leaderBlock = pending.snapshot.blockIndex;
            expect(leaderBlock).to.equal(TIP - BUFFER);

            // The envelope must carry the REQUESTED tip, so the follower's own
            // single burial lands on the leader's block.
            expect(data.btcBlockHeight).to.equal(TIP);

            let follower = new Consensus(createMockHub());
            follower.hub.capabilitySnapshot = buryingSnapshotFake();
            let { snapshot: followerSnapshot } =
                await follower._lockSnapshot(data.btcBlockHeight);
            expect(followerSnapshot.blockIndex).to.equal(leaderBlock);

            clearTimeout(pending.timer);
            pending.resolved = true;
            pending.reject(new Error('cleanup'));
            await promise.catch(() => {});
        });

        it('_lockSnapshot reports the height it asked for alongside the buried one @regression-p1', async function () {
            hub.capabilitySnapshot = buryingSnapshotFake();
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let { snapshot, requestedBlockIndex } = await consensus._lockSnapshot();
            expect(requestedBlockIndex).to.equal(800000);
            expect(snapshot.blockIndex).to.equal(800000 - BUFFER);
        });
    });

    // -----------------------------------------------------------------
    // REG-CON-010: Non-leader PRE_PREPARE rejected
    // -----------------------------------------------------------------

    describe('REG-CON-010: PRE_PREPARE with invalid data rejected', function () {
        it('PRE_PREPARE from a non-leader for the claimed view is rejected @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let config = { x: 1 };
            let digest = consensus._digest(config);

            // (seq 5, view 0) → leader is VALIDATORS_4[1]; a PRE_PREPARE from any
            // other validator must not create a proposal; the identity guard stops
            // an authenticated non-leader from driving an uncontested seq to commit.
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[3].addr,
                sig_pubkey: VALIDATORS_4[3].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config }
            });

            expect(consensus.pendingProposals.size).to.equal(0);
            expect(pm.broadcast.called).to.be.false;
        });

        it('PRE_PREPARE with wrong digest is rejected @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let config = { x: 1 };

            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: 'bad-digest', config }
            });

            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('PRE_PREPARE with missing fields is ignored @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: null, configDigest: null, config: null }
            });

            expect(consensus.pendingProposals.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Quorum math (regression guard for 2f+1 formula)
    // -----------------------------------------------------------------

    describe('Quorum math regression guard', function () {
        // Formula: max(2f+1, ceil((N+1)/2)). The majority floor keeps N=3
        // (f=0) from degenerating to quorum=1, where a single validator
        // could finalize alone.
        let cases = [
            { N: 1,  expected: 0 },
            { N: 3,  expected: 2 },
            { N: 4,  expected: 3 },
            { N: 7,  expected: 5 },
            { N: 10, expected: 7 },
            { N: 13, expected: 9 }
        ];

        for (let c of cases) {
            it('N=' + c.N + ' → quorum=' + c.expected + ' @regression-p0', function () {
                let validators = Array.from({ length: c.N }, (_, i) => makeValidator(i + 1));
                consensus.setValidatorSet(validators);
                expect(consensus._getQuorum()).to.equal(c.expected);
            });
        }
    });
});
