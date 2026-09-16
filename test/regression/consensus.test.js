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
const Consensus      = require('../../src/consensus/pbft');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_4, makeValidator } = require('../helpers/fixtures');

let hub, pm, consensus;

function registerSuitePart1() {
    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        consensus = new Consensus(hub);
    });
}

function registerSuitePart2() {
    afterEach(function () {
        for (let [, prop] of consensus.pendingProposals) {
            if (prop.timer) clearTimeout(prop.timer);
        }
        sinon.restore();
    });
}

// -----------------------------------------------------------------
// REG-CON-011: PRE_PREPARE carries the requested tip, not the buried one
// -----------------------------------------------------------------

function registerSuitePart3() {
    describe('REG-CON-011: leader and follower bury the reorg buffer once', function () {
    registerNestedSuite1Part1();
    registerNestedSuite1Part2();

    });
}

// -----------------------------------------------------------------
// REG-CON-010: Non-leader PRE_PREPARE rejected
// -----------------------------------------------------------------

function registerSuitePart4() {
    describe('REG-CON-010: PRE_PREPARE with invalid data rejected', function () {
        it('PRE_PREPARE from a non-leader for the claimed view is rejected @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let config = { x: 1 };
            let digest = consensus.digest(config);

            // (seq 5, view 0) → leader is VALIDATORS_4[1]; a PRE_PREPARE from any
            // other validator must not create a proposal; the identity guard stops
            // an authenticated non-leader from driving an uncontested seq to commit.
            consensus.handlePrePrepare({
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

            consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: 'bad-digest', config }
            });

            expect(consensus.pendingProposals.size).to.equal(0);
        });

        it('PRE_PREPARE with missing fields is ignored @regression-p1', function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: null, configDigest: null, config: null }
            });

            expect(consensus.pendingProposals.size).to.equal(0);
        });
    });
}

// -----------------------------------------------------------------
// Quorum math (regression guard for 2f+1 formula)
// -----------------------------------------------------------------

function registerSuitePart5() {
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
                expect(consensus.getQuorum()).to.equal(c.expected);
            });
        }
    });
}

describe('Regression: Consensus (PBFT)', function () {
    registerSuitePart1();
    registerSuitePart2();
    registerSuitePart3();
    registerSuitePart4();
    registerSuitePart5();

});
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
      function registerNestedSuite1Part1() {
    it('follower locks the same block the leader locked @regression-p0', async function () {
            const TIP = 800000;
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // leader for seq 1
            hub.capabilitySnapshot = buryingSnapshotFake();
            hub.resolveBtcLatestBlock = sinon.stub().resolves(TIP);

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
                await follower.lockSnapshot(data.btcBlockHeight);
            expect(followerSnapshot.blockIndex).to.equal(leaderBlock);

            clearTimeout(pending.timer);
            pending.resolved = true;
            pending.reject(new Error('cleanup'));
            await promise.catch(() => {});
        });
}
      function registerNestedSuite1Part2() {
    it('lockSnapshot reports the height it asked for alongside the buried one @regression-p1', async function () {
            hub.capabilitySnapshot = buryingSnapshotFake();
            hub.resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let { snapshot, requestedBlockIndex } = await consensus.lockSnapshot();
            expect(requestedBlockIndex).to.equal(800000);
            expect(snapshot.blockIndex).to.equal(800000 - BUFFER);
        });
}
