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
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        makeValidator } = require('../helpers/fixtures');

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

            // Step 1: PRE_PREPARE from leader creates proposal
            // (seq 5, view 0 → (5+0)%4 = 1 → VALIDATORS_4[1] is the rotation leader)
            // _handlePrePrepare is async (locks the federation snapshot before
            // broadcasting PREPARE), so the flow must be awaited.
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, view: 0, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.true;

            // Step 2: Third PREPARE reaches quorum → COMMIT broadcast
            consensus._handlePrepare({
                sender: VALIDATORS_4[2].addr,
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
                data: { seq: 5, configDigest: digest }
            });

            // Third commit → quorum met
            consensus._handleCommit({
                sender: VALIDATORS_4[2].addr,
                data: { seq: 5, configDigest: digest }
            });

            await new Promise(r => setTimeout(r, 30));
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

            // Only 1 prepare (from PRE_PREPARE sender) + self = 2, need 3
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                data: { seq: 5, view: 0, configDigest: digest, config }
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
                data: { seq: 5, configDigest: digest }
            });

            await new Promise(r => setTimeout(r, 20));
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
                data: { seq: 5, view: 0, configDigest: 'bad-digest', config }
            });

            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('PRE_PREPARE with missing fields is ignored @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
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
