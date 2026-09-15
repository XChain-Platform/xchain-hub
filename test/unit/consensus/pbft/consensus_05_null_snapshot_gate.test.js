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

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('null-snapshot fail-closed gate (#5334)', function () {
it('(b) follower declines to PREPARE when minValidators>1 and snapshot is null', async function () {
            // The follower locks its own snapshot at the leader-stamped block and
            // gets null. It must NOT create a proposal or emit PREPARE, else it
            // would vote over its local set while peers used a different one.
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            consensus.minValidators = 4;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(null),
                getQuorum: sinon.stub().returns(0)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let config = { x: 1 };
            let digest = consensus._digest(config);
            // seq 5, view 0: (5+0)%4 = 1 → VALIDATORS_4[1] is the legitimate leader.
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });

            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
it('(c) propose()/single-node still applies when minValidators<=1 and snapshot is null', async function () {
            // No federation to split: the existing single-node direct-apply path
            // is preserved untouched for minValidators <= 1.
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            consensus.minValidators = 1;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(null),
                getQuorum: sinon.stub().returns(0)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let result = await consensus.propose({ ok: true });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnceWith({ ok: true })).to.be.true;
        });
it('isEmptyFederationSnapshot: true only for a present-but-empty snapshot in a federation', function () {
            consensus.minValidators = 4;
            expect(consensus.isEmptyFederationSnapshot(null)).to.be.false;
            expect(consensus.isEmptyFederationSnapshot({ validators: [] })).to.be.true;
            expect(consensus.isEmptyFederationSnapshot({ validators: [{ pubkey: 'ab' }] })).to.be.false;
            consensus.minValidators = 1;
            expect(consensus.isEmptyFederationSnapshot({ validators: [] })).to.be.false;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('null-snapshot fail-closed gate (#5334)', function () {
it('(a2) propose() throws over an EMPTY federation snapshot instead of applying unilaterally', async function () {
            // A present-but-empty snapshot yields quorum 0 and passes
            // hasDeterministicSnapshot, so the null-gate does not catch it. The
            // leader must refuse rather than apply the change with no quorum.
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;
            consensus.minValidators = 4;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000, count: 0, validators: [] }),
                getQuorum: sinon.stub().returns(0)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let caught = null;
            try {
                await consensus.propose({ cfg: 1 });
            } catch (e) {
                caught = e;
            }
            expect(caught).to.be.an('error');
            expect(caught.message).to.include('EMPTY');
            expect(hub.applyConfig.called).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
it('(b2) follower declines to PREPARE over an EMPTY federation snapshot', async function () {
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            consensus.minValidators = 4;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000, count: 0, validators: [] }),
                getQuorum: sinon.stub().returns(0)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });

            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('null-snapshot fail-closed gate (#5334)', function () {
it('(c2) single-node (minValidators<=1) still applies over an empty snapshot', async function () {
            // The empty-federation guard requires minValidators>1, so a genuine
            // single-node hub keeps the direct-apply bootstrap path.
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            consensus.minValidators = 1;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000, count: 0, validators: [] }),
                getQuorum: sinon.stub().returns(0)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let result = await consensus.propose({ ok: true });
            expect(result).to.be.true;
            expect(hub.applyConfig.calledOnceWith({ ok: true })).to.be.true;
        });
it('follower still PREPAREs with minValidators>1 when a real snapshot IS present', async function () {
            // Control: a deterministic (even empty-after-filter) snapshot is not
            // null, so the gate does not fire and the normal follower path runs.
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            consensus.minValidators = 4;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns({ blockIndex: 800000, count: 4, validators: VALIDATORS_4 }),
                getQuorum: sinon.stub().returns(3)
            };
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
            });

            expect(consensus.pendingProposals.has(5)).to.be.true;
            let prepare = pm.broadcast.getCalls().find(c => c.args[0] === 'PBFT_PREPARE');
            expect(prepare).to.exist;
            let proposal = consensus.pendingProposals.get(5);
            if (proposal && proposal.timer) clearTimeout(proposal.timer);
        });
});
});
