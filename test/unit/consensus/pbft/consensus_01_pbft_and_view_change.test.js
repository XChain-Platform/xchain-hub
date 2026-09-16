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
        hub.resolveBtcLatestBlock = sinon.stub().resolves(blockIndex);
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

function installSuiteHooks2() {
    beforeEach(function () {
                // Use VALIDATORS_4 (quorum=3) to prevent auto-completion in tests
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

function wire(tip) {
                consensus.minValidators = 2;
                hub.capabilitySnapshot = {
                    getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 700000, validators: VALIDATORS_4 }),
                    getActiveWeightSnapshot:    sinon.stub().returns({ blockIndex: 700000, validators: VALIDATORS_4 }),
                    getQuorum: sinon.stub().returns(3)
                };
                hub.resolveBtcLatestBlock = sinon.stub().resolves(tip);
            }

async function send(height) {
                let config = { x: 1 };
                let digest = consensus.digest(config);
                await consensus.handlePrePrepare({
                    sender: VALIDATORS_4[1].addr,                   // leader for (seq 5, view 0)
                    sig_pubkey: VALIDATORS_4[1].pubkey,
                    data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: height }
                });
                let p = consensus.pendingProposals.get(5);
                if (p && p.timer) clearTimeout(p.timer);
                return p;
            }

function installSuiteHooks3() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('federated follower PREPAREs a PRE_PREPARE carrying a valid btcBlockHeight', async function () {
            // Positive path: a well-formed height locks the leader-stamped snapshot
            // and the follower proceeds normally.
            consensus.minValidators = 2;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000, validators: VALIDATORS_4 }),
                getQuorum: sinon.stub().returns(3)
            };
            // Our own tip, which BOUNDS the stamped height (freshness guard) and
            // never to substitute for it; deliberately a few blocks off the leader's
            // so the assertion below distinguishes the two.
            hub.resolveBtcLatestBlock = sinon.stub().resolves(800004);
            let config = { x: 1 };
            let digest = consensus.digest(config);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });
            expect(consensus.pendingProposals.has(5)).to.be.true;
            // Snapshot was locked at the leader-stamped height, not the local tip.
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledWith(800000)).to.be.true;
            expect(consensus.pendingProposals.get(5).btcBlockHeight).to.equal(800000);
            let proposal = consensus.pendingProposals.get(5);
            if (proposal.timer) clearTimeout(proposal.timer);
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('second PRE_PREPARE for an already-pending seq with a conflicting digest is dropped (no PREPARE)', async function () {
            // First PRE_PREPARE establishes a pending proposal at seq 5 with digest A.
            wireFederationSnapshot(3, 800000);
            let configA = { x: 1 };
            let digestA = consensus.digest(configA);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digestA, config: configA, btcBlockHeight: 800000 }
            });

            expect(consensus.pendingProposals.has(5)).to.be.true;
            expect(pm.broadcast.callCount).to.equal(1); // PREPARE for digest A

            // A second PRE_PREPARE arrives for the SAME seq with a different,
            // internally-valid config (digest B). This can happen when two
            // leaders both propose for seq 5 during a view transition.
            let configB = { x: 2 };
            let digestB = consensus.digest(configB);
            expect(digestB).to.not.equal(digestA);

            // A competing leader from view 1: (5+1)%4 = 2, so VALIDATORS_4[2] is the
            // legitimate proposer at view 1. This passes the identity guard and
            // is dropped only by the digest-conflict rule (two leaders, one seq).
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { seq: 5, view: 1, configDigest: digestB, config: configB, btcBlockHeight: 800000 }
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
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('PREPARE quorum triggers COMMIT broadcast', function () {
            let config = { x: 1 };
            let digest = consensus.digest(config);

            // N=4, quorum=3. Start with 2 prepares
            consensus.pendingProposals.set(5, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                commits: new Set(),
                resolved: false, applied: false, timer: null,
                resolve: null, reject: null
            });

            // Third prepare → quorum met
            consensus.handlePrepare({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { seq: 5, configDigest: digest }
            });

            expect(pm.broadcast.called).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_COMMIT');
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('COMMIT quorum applies config and saves seq', async function () {
            let config = { x: 1 };
            let digest = consensus.digest(config);

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
            consensus.handleCommit({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { seq: 5, configDigest: digest }
            });

            // Wait for the async apply to run to completion. The anchor is the
            // proposer promise settling, not applyConfig being CALLED: the seq
            // save and the round clear both happen after that call.
            await waitUntil(() => resolved, { label: 'the quorum commit to resolve the proposal' });

            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(hub.applyConfig.calledWith(config)).to.be.true;
            expect(resolved).to.be.true;
            // Applied exactly once and cleared: the seq advanced and the round is
            // absent from pendingProposals (double-apply is guarded by lastAppliedSeq /
            // proposal.applied / _applying, not by a digest set).
            expect(consensus.lastAppliedSeq).to.equal(5);
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('does NOT apply config twice under a re-entrant COMMIT while the apply is in flight', async function () {
            // `applied` is set only after the async apply
            // resolves, so a second COMMIT reaching quorum mid-apply would re-run
            // applyConfig without the _applying in-flight guard.
            let config = { y: 2 };
            let digest = consensus.digest(config);
            let release;
            hub.applyConfig = sinon.stub().returns(new Promise(r => { release = r; })); // held pending

            consensus.pendingProposals.set(6, {
                config, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits:  new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]), // quorum met
                resolved: false, applied: false, timer: null, _commitSent: true,
                resolve: () => {}, reject: () => {}
            });

            consensus.checkCommitQuorum(6);   // starts the (pending) apply
            consensus.checkCommitQuorum(6);   // re-entrant while in flight: must be a no-op
            expect(hub.applyConfig.calledOnce).to.be.true;

            release();
            // The in-flight apply now completes and clears the round; poll for
            // the clear rather than guessing how long the release takes.
            await waitUntil(() => !consensus.pendingProposals.has(6), { label: 'the released apply to clear round 6' });
            expect(hub.applyConfig.calledOnce).to.be.true;       // still applies exactly once
            expect(consensus.pendingProposals.has(6)).to.be.false; // applied and cleared
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
// Freshness bound on the leader-stamped height. An ancient but INDEXED height passes blockEchoOk and
// yields a valid snapshot, so without this bound a Byzantine leader grinds the height to size quorum N,
// to elect itself under (seq + view) % N, and to land below the STAKE_WEIGHTED_QUORUM activation.
describe('leader-stamped btcBlockHeight freshness bound', function () {
it('declines an ancient height the indexer would happily serve', async function () {
                wire(800000);
                expect(await send(700000)).to.equal(undefined);
                expect(pm.broadcast.called).to.be.false;
                // The snapshot resolve is never reached, so the attacker-chosen block
                // never sizes quorum or elects the leader.
                expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
            });
it('declines a future height beyond the tolerance too', async function () {
                wire(800000);
                expect(await send(800000 + consensus.snapshotToleranceBlocks + 1)).to.equal(undefined);
            });
it('accepts a height inside the tolerance in both directions', async function () {
                wire(800000);
                expect(await send(800000 - consensus.snapshotToleranceBlocks)).to.not.equal(undefined);
                consensus.pendingProposals.delete(5);
                expect(await send(800000 + consensus.snapshotToleranceBlocks)).to.not.equal(undefined);
            });
it('fails closed when this hub cannot resolve a tip of its own', async function () {
                wire(null);
                expect(await send(800000)).to.equal(undefined);
                expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
            });
it('leaves a single-node hub on its legacy path', async function () {
                wire(null);
                consensus.minValidators = 1;
                consensus.validatorSet  = [];
                expect(consensus.isFederated()).to.be.false;
                expect(await send(700000)).to.not.equal(undefined);
            });
});
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// View change
describe('view change', function () {
    installSuiteHooks3();
it('initiateViewChange increments view and broadcasts', function () {
            consensus.view = 0;
            consensus.initiateViewChange(5);
            expect(consensus.view).to.equal(1);
            expect(pm.broadcast.calledOnce).to.be.true;
            expect(pm.broadcast.getCall(0).args[0]).to.equal('PBFT_VIEW_CHANGE');
        });
it('VIEW_CHANGE quorum updates view', function () {
            consensus.view = 0;
            // N=4, quorum=3. Need 3 VIEW_CHANGE votes
            consensus.handleViewChange({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { view: 1, seq: 5 }
            });
            consensus.handleViewChange({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { view: 1, seq: 5 }
            });
            consensus.handleViewChange({
                sender: VALIDATORS_4[3].addr,
                sig_pubkey: VALIDATORS_4[3].pubkey,
                data: { view: 1, seq: 5 }
            });
            // quorum = 3, 3 votes → accepted
            expect(consensus.view).to.equal(1);
        });
// NEW_VIEW authenticity guards. handleNewView must not advance the view on any peer's say-so: it only
// accepts a NEW_VIEW from the rotation-designated leader for the claimed (seq, view), and only when it
// moves the view forward. Without this a single Byzantine validator can steer leader election by
// broadcasting escalating NEW_VIEW messages.
it('NEW_VIEW from a non-leader peer does not advance the view', function () {
            consensus.view = 0;
            // Leader for (seq=5, view=1): validators[(5+1) % 4] = validators[2].
            // A NEW_VIEW from any other validator must be ignored.
            consensus.handleNewView({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { view: 1, seq: 5 }
            });
            expect(consensus.view).to.equal(0);
        });
it('NEW_VIEW from the designated leader advances the view', function () {
            consensus.view = 0;
            // validators[(5+1) % 4] = validators[2], the leader for (5, 1).
            consensus.handleNewView({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { view: 1, seq: 5 }
            });
            expect(consensus.view).to.equal(1);
        });
});
});
