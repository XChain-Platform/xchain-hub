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

function installSuiteHooks3() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

function installSuiteHooks4() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('view change', function () {
    installSuiteHooks3();
it('NEW_VIEW cannot rewind the view to a lower number', function () {
            consensus.view = 5;
            // Even from the correct leader for the lower view, a regression
            // is rejected. NEW_VIEW only moves the view forward.
            let idx = (5 + 2) % VALIDATORS_4.length;
            consensus.handleNewView({
                sender: VALIDATORS_4[idx].addr,
                sig_pubkey: VALIDATORS_4[idx].pubkey,
                data: { view: 2, seq: 5 }
            });
            expect(consensus.view).to.equal(5);
        });
// Validator churn between proposal creation and view-change. View-change acceptance must use the
// round-locked quorum (proposal-creation snapshot), exactly like checkPrepareQuorum and
// checkCommitQuorum, never a live recompute. Otherwise a set that grew can stall the election
// (liveness), and a set that shrank can let too few votes, even a single node, promote a new leader
// (safety).
it('follower view-change uses locked quorum from the in-flight proposal, not a live recompute (grow; liveness)', function () {
            // Proposal locked at N=4: quorum 3.
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

            // Churn: set grows to N=7. Live quorum would be 5.
            consensus.setValidatorSet(VALIDATORS_7);
            expect(consensus.getQuorum()).to.equal(5);

            // Three distinct view-change votes, meets the locked quorum (3),
            // below the live one (5). Must accept on the locked value.
            consensus.handleViewChange({ sender: VALIDATORS_7[1].addr, sig_pubkey: VALIDATORS_7[1].pubkey, data: { view: 1, seq: 5 } });
            consensus.handleViewChange({ sender: VALIDATORS_7[2].addr, sig_pubkey: VALIDATORS_7[2].pubkey, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0); // 2 votes < 3, not yet
            consensus.handleViewChange({ sender: VALIDATORS_7[3].addr, sig_pubkey: VALIDATORS_7[3].pubkey, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(1); // 3 votes == locked quorum → accepted
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('view change', function () {
    installSuiteHooks3();
it('follower view-change holds at the locked quorum even when the set shrank (shrink; safety)', function () {
            // Proposal locked at N=7: quorum 5.
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

            // Churn: set shrinks to N=3. Live quorum would be 2 (majority
            // floor). The locked quorum is still 5.
            consensus.setValidatorSet(VALIDATORS_3);
            expect(consensus.getQuorum()).to.equal(2);

            // Two distinct votes would clear the live quorum (2), but must
            // NOT clear the locked quorum (5).
            consensus.handleViewChange({ sender: VALIDATORS_3[1].addr, sig_pubkey: VALIDATORS_3[1].pubkey, data: { view: 1, seq: 5 } });
            consensus.handleViewChange({ sender: VALIDATORS_3[2].addr, sig_pubkey: VALIDATORS_3[2].pubkey, data: { view: 1, seq: 5 } });
            expect(consensus.view).to.equal(0);                 // not promoted
            expect(pm.broadcast.called).to.be.false;            // no NEW_VIEW broadcast
        });
it('the initiating node recovers the locked quorum from viewChangeQuorums after its proposal is gone', function () {
            // Initiator path: the timeout deletes the proposal before
            // initiateViewChange runs, so the initiator can't read
            // proposal.quorum. It relies on the stashed value.
            consensus.setValidatorSet(VALIDATORS_7);
            pm.validatorAddr = VALIDATORS_7[0].addr;
            consensus.view = 0;
            consensus.lastAppliedSeq = 0;

            // Initiate with the round-locked quorum (N=7: 5). No proposal
            // remains in pendingProposals, mirroring the real timeout flow.
            consensus.initiateViewChange(5, 5);
            expect(consensus.view).to.equal(1);
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(consensus.viewChangeQuorums.get(5).quorum).to.equal(5);
            expect(consensus.viewChangeQuorums.get(5).weighted).to.equal(false);
            expect(pm.broadcast.callCount).to.equal(1);         // VIEW_CHANGE only

            // Churn: set shrinks to N=3. Live quorum is 1.
            consensus.setValidatorSet(VALIDATORS_3);

            // Own vote was added by initiateViewChange; add one more (size 2).
            consensus.handleViewChange({ sender: VALIDATORS_3[1].addr, sig_pubkey: VALIDATORS_3[1].pubkey, data: { view: 1, seq: 5 } });
            expect(consensus.pendingViewChanges.get(1).size).to.equal(2);
            expect(pm.broadcast.callCount).to.equal(1);         // still no NEW_VIEW: 2 < locked 5
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('view change', function () {
    installSuiteHooks3();
it('initiateViewChange stashes the locked quorum and prunes already-applied rounds', function () {
            consensus.setValidatorSet(VALIDATORS_7);
            pm.validatorAddr = VALIDATORS_7[0].addr;
            consensus.lastAppliedSeq = 10;
            consensus.viewChangeQuorums.set(3, 5);  // stale (seq 3 <= lastApplied 10)
            consensus.initiateViewChange(12, 7);
            expect(consensus.viewChangeQuorums.has(3)).to.be.false; // pruned
            expect(consensus.viewChangeQuorums.get(12).quorum).to.equal(7);
        });
});
// Sequence persistence
describe('sequence persistence', function () {
it('loadSeq reads from DB', async function () {
            hub.db.doQuery.resolves([{ value: '42' }]);
            await consensus.loadSeq();
            expect(consensus.seq).to.equal(42);
        });
it('loadSeq defaults to 0 on empty result (genuine fresh install)', async function () {
            hub.db.doQuery.resolves([]);
            await consensus.loadSeq();
            expect(consensus.seq).to.equal(0);
        });
it('loadSeq fails CLOSED on a read fault, not open at 0 (#970c0586)', async function () {
            // A swallowed read fault can leave seq/lastAppliedSeq at 0 and reopen the
            // stale-seq replay guard. Mirror saveSeq and rethrow.
            consensus.lastAppliedSeq = 5;
            hub.db.doQuery.rejects(new Error('injected DB read fault'));
            let threw = false;
            try { await consensus.loadSeq(); } catch (e) { threw = true; }
            expect(threw, 'read fault must propagate out of loadSeq').to.be.true;
            expect(consensus.lastAppliedSeq, 'guard baseline must not reset to 0').to.equal(5);
        });
it('saveSeq writes to DB', async function () {
            await consensus.saveSeq(10);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('consensus_state');
            expect(args[1]).to.include('10');
        });
it('saveSeq surfaces DB errors (item 4579: must not silently lose the seq write)', async function () {
            hub.db.doQuery.rejects(new Error('db down'));
            let threw = false;
            try { await consensus.saveSeq(5); }
            catch (e) { threw = true; expect(e.message).to.equal('db down'); }
            expect(threw, 'saveSeq must reject so checkCommitQuorum does not mark the proposal applied while the seq write was lost').to.be.true;
        });
it('loadSeq rethrows a DB read fault so startup fails closed (#970c0586)', async function () {
            // Swallowing the error leaves seq at 0 and silently reopens the stale-seq
            // replay guard. Matching saveSeq means the read fault is rethrown.
            hub.db.doQuery.rejects(new Error('db down'));
            let threw = false;
            try { await consensus.loadSeq(); } catch (e) { threw = true; }
            expect(threw).to.be.true;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// start() / stop()
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
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// _handleMessage dispatch
describe('_handleMessage dispatch', function () {
    installSuiteHooks4();
it('routes PREPARE / COMMIT / VIEW_CHANGE / NEW_VIEW and ignores unknown types', function () {
            let prepare = sinon.spy(consensus, 'handlePrepare');
            let commit  = sinon.spy(consensus, '_handleCommit');
            let vc      = sinon.spy(consensus, 'handleViewChange');
            let nv      = sinon.spy(consensus, 'handleNewView');

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
            // Force lockSnapshot to throw inside the async handler so the
            // dispatch-site .catch is exercised.
            hub.capabilitySnapshot = { getActiveValidatorSnapshot: () => { throw new Error('boom'); }, getQuorum: () => 3 };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let config = { x: 1 };
            let digest = consensus._digest(config);
            consensus._handleMessage({
                type: 'PBFT_PRE_PREPARE',
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });
            await new Promise(r => setImmediate(r));
            expect(consensus.pendingProposals.has(5)).to.be.false; // threw before creating
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// lockSnapshot + snapshot-quorum propose
describe('lockSnapshot()', function () {
it('returns the snapshot acquired at the resolved BTC tip', async function () {
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000 }),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let { snapshot, weighted } = await consensus.lockSnapshot();
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
            await consensus.lockSnapshot(42);
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledWith(42)).to.be.true;
            expect(hub._resolveBtcLatestBlock.called).to.be.false;
        });
it('returns null snapshot when no capabilitySnapshot is wired', async function () {
            expect((await consensus.lockSnapshot()).snapshot).to.equal(null);
        });
it('returns null snapshot when no BTC tip can be resolved', async function () {
            hub.capabilitySnapshot = { getActiveValidatorSnapshot: sinon.stub(), getQuorum: sinon.stub() };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(null);
            expect((await consensus.lockSnapshot()).snapshot).to.equal(null);
            expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
        });
it('propose() locks the federation snapshot quorum and stamps the block height', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // leader for seq 1
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(makeFederationSnapshot(VALIDATORS_4, 800000)),
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
});
