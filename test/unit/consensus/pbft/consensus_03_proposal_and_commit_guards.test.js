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
const Consensus      = require('../../../../src/consensus/pbft');
const { createMockHub }     = require('../../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        makeValidator, WEIGHTED_VALIDATORS_4, makeWeightSnapshot,
        makeFederationSnapshot, pubkeyForTestSender } = require('../../../helpers/fixtures');
const { waitUntil }  = require('../../../helpers/waitUntil');

let hub, pm, consensus;

function wireFederationSnapshot(quorum, blockIndex, validators) {
        let snapshot = makeFederationSnapshot(validators || consensus.validatorSet, blockIndex);
        hub.capabilitySnapshot = {
            getActiveValidatorSnapshot: sinon.stub().returns(snapshot),
            getActiveWeightSnapshot:    sinon.stub().returns(snapshot),
            getQuorum:                  sinon.stub().returns(quorum)
        };
        hub._resolveBtcLatestBlock = sinon.stub().resolves(blockIndex);
        return snapshot;
    }

function installSuiteHooks1() {
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
}

function installSuiteHooks5() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

function installSuiteHooks6() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

function installSuiteHooks7() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

// propose() edge cases + timeouts
describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('propose() additional paths', function () {
it('refuses to PROPOSE without a deterministic snapshot when MIN_VALIDATORS > 1', async function () {
            // Federation-split guard: with minValidators > 1 and a null snapshot
            // (no capabilitySnapshot wired here), falling back to the local
            // validatorSet would let two hubs finalize the same round over
            // different sets. The leader must refuse instead of applying.
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            consensus.minValidators = 3;
            let caught = null;
            try {
                await consensus.propose({ x: 1 });
            } catch (e) {
                caught = e;
            }
            expect(caught).to.be.an('error');
            expect(caught.message).to.include('refusing to PROPOSE');
            expect(hub.applyConfig.called).to.be.false;
        });
// #4168: relying only on the guard above required the operator to set MIN_VALIDATORS. That env var is
// optional (CONFIGURATION.md "No", commented out in .env.example), so a normally configured multi-hub
// federation can leave minValidators at 1 and size quorum from its own mutable local set during an
// indexer outage. The live active validator set now decides.
it('refuses to PROPOSE on a multi-member set even with MIN_VALIDATORS unset', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;     // leader for seq 1
            expect(consensus.minValidators).to.equal(1); // the shipped default
            let caught = null;
            try {
                await consensus.propose({ x: 1 });
            } catch (e) {
                caught = e;
            }
            expect(caught).to.be.an('error');
            expect(caught.message).to.include('refusing to PROPOSE');
            expect(hub.applyConfig.called).to.be.false;
        });
it('still applies unilaterally when the hub is genuinely single-node', async function () {
            consensus.setValidatorSet([VALIDATORS_4[0]]);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            pm.getPeerStatus.returns([]);
            expect(await consensus.propose({ x: 1 })).to.equal(true);
            expect(hub.applyConfig.calledOnce).to.be.true;
        });
it('a follower on a multi-member set declines to PREPARE without a snapshot', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let config = { x: 1 };
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,            // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: consensus._digest(config), config, btcBlockHeight: 800000 }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('propose() additional paths', function () {
it('times out → rejects the promise and initiates a view change', async function () {
            let clock = sinon.useFakeTimers();
            consensus.setValidatorSet(VALIDATORS_4);
            wireFederationSnapshot(3, 800000);
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
// PRE_PREPARE stale seq and follower expiry
describe('PRE_PREPARE replay + follower expiry', function () {
    installSuiteHooks5();
it('rejects a PRE_PREPARE whose seq is at/below the last applied seq', async function () {
            consensus.lastAppliedSeq = 10;
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
it('expires a follower proposal on its (doubled) timeout', async function () {
            wireFederationSnapshot(3, 800000);
            let clock = sinon.useFakeTimers();
            consensus.timeout = 1000;
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });
            expect(consensus.pendingProposals.has(5)).to.be.true;
            await clock.tickAsync(2001); // followers wait timeout times 2
            expect(consensus.pendingProposals.has(5)).to.be.false;
            clock.restore();
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// COMMIT apply-error path (error handling)
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

            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, sig_pubkey: VALIDATORS_4[2].pubkey, data: { seq: 5, configDigest: digest } });
            await waitUntil(() => rejected, { label: 'the failed apply to reject the proposer promise' });

            expect(rejected).to.be.an('error');
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('COMMIT apply failure', function () {
it('saveSeq failure: proposal.applied stays false and lastAppliedSeq is not advanced', async function () {
            // applyConfig succeeds but saveSeq rejects (transient DB error). The
            // proposal must NOT be marked applied and lastAppliedSeq must not advance,
            // so a subsequent retry can persist the seq row and complete the apply.
            // This is the case described in item 5293 (comment vs. code mismatch).
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            // applyConfig resolves; saveSeq rejects on the first call, then resolves.
            hub.applyConfig.resolves();
            let saveCallCount = 0;
            sinon.stub(consensus, 'saveSeq').callsFake(async () => {
                saveCallCount++;
                if (saveCallCount === 1) throw new Error('seq write failed');
            });

            let config = { x: 1 };
            let digest = consensus._digest(config);
            let rejected = null;
            consensus.lastAppliedSeq = 0;
            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits:  new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: () => {}, reject: (e) => { rejected = e; }, quorum: 3
            });

            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, sig_pubkey: VALIDATORS_4[2].pubkey, data: { seq: 5, configDigest: digest } });
            await waitUntil(() => rejected, { label: 'the failed seq write to reject the proposer promise' });

            expect(rejected).to.be.an('error');
            expect(rejected.message).to.equal('seq write failed');
            // applied must remain false; lastAppliedSeq must not advance.
            expect(consensus.lastAppliedSeq).to.equal(0);
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// VIEW_CHANGE and NEW_VIEW: remaining branches
describe('view change: remaining branches', function () {
    installSuiteHooks6();
it('ignores VIEW_CHANGE with non-numeric fields', function () {
            consensus.handleViewChange({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { view: 'x', seq: 5 } });
            expect(consensus.pendingViewChanges.size).to.equal(0);
        });
it('ignores VIEW_CHANGE when the computed quorum is 0', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            consensus.handleViewChange({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0);
        });
it('on quorum where this node is the new leader, broadcasts NEW_VIEW and prunes lower views', function () {
            pm.validatorAddr = VALIDATORS_4[2].addr; // leader for (seq 5, view 1)
            consensus.view = 0;
            consensus.pendingViewChanges.set(0, new Set(['stale'])); // lower view to prune

            consensus.handleViewChange({ sender: VALIDATORS_4[1].addr, sig_pubkey: VALIDATORS_4[1].pubkey, data: { view: 1, seq: 5 } });
            consensus.handleViewChange({ sender: VALIDATORS_4[3].addr, sig_pubkey: VALIDATORS_4[3].pubkey, data: { view: 1, seq: 5 } });
            consensus.handleViewChange({ sender: VALIDATORS_4[0].addr, sig_pubkey: VALIDATORS_4[0].pubkey, data: { view: 1, seq: 5 } });

            expect(consensus.view).to.equal(1);
            let nv = pm.broadcast.getCalls().find(c => c.args[0] === 'PBFT_NEW_VIEW');
            expect(nv).to.exist;
            expect(consensus.pendingViewChanges.has(0)).to.be.false; // pruned (0 < 1)
            expect(consensus.pendingViewChanges.has(1)).to.be.false; // cleared on accept
        });
it('ignores NEW_VIEW with non-numeric fields', function () {
            consensus.handleNewView({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { view: null, seq: 5 } });
            expect(consensus.view).to.equal(0);
        });
it('ignores NEW_VIEW when the validator set is empty', function () {
            consensus.setValidatorSet([]);
            consensus.handleNewView({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0);
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// Remaining guard branches
describe('guard branches', function () {
    installSuiteHooks7();
it('rejects a PRE_PREPARE with a non-positive seq', async function () {
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: -1, configDigest: 'd', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });
it('handlePrePrepare uses the snapshot quorum when a snapshot is available', async function () {
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(makeFederationSnapshot(VALIDATORS_4, 900000)),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(900000);
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 900000 }
            });
            let p = consensus.pendingProposals.get(5);
            expect(p.quorum).to.equal(3);
            expect(p.btcBlockHeight).to.equal(900000);
            if (p.timer) clearTimeout(p.timer);
        });
it('ignores a PREPARE with no configDigest', function () {
            expect(() => consensus.handlePrepare({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { seq: 5 } })).to.not.throw();
        });
it('ignores a PREPARE whose digest does not match the proposal', function () {
            consensus.pendingProposals.set(5, { digest: 'right', prepares: new Set(), resolved: false, quorum: 3 });
            consensus.handlePrepare({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { seq: 5, configDigest: 'wrong' } });
            expect(consensus.pendingProposals.get(5).prepares.size).to.equal(0);
        });
it('ignores a COMMIT with no configDigest', function () {
            expect(() => consensus._handleCommit({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { seq: 5 } })).to.not.throw();
        });
it('ignores a COMMIT whose digest does not match the proposal', function () {
            consensus.pendingProposals.set(5, { digest: 'right', commits: new Set(), applied: false, quorum: 3 });
            consensus._handleCommit({ sender: 'a', sig_pubkey: pubkeyForTestSender('a'), data: { seq: 5, configDigest: 'wrong' } });
            expect(consensus.pendingProposals.get(5).commits.size).to.equal(0);
        });
it('checkPrepareQuorum returns when the proposal is resolved', function () {
            consensus.pendingProposals.set(5, { resolved: true });
            expect(() => consensus.checkPrepareQuorum(5)).to.not.throw();
        });
it('checkCommitQuorum returns when the proposal is already applied', function () {
            consensus.pendingProposals.set(5, { applied: true });
            expect(() => consensus.checkCommitQuorum(5)).to.not.throw();
        });
});
});
