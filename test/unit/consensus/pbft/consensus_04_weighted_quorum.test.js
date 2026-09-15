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

function installSuiteHooks7() {
    beforeEach(function () {
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}

// weight 1000, more than 2/3 of S=1300
const WHALE = WEIGHTED_VALIDATORS_4[0];

// three sources of 100 each
const SMALL = WEIGHTED_VALIDATORS_4.slice(1);

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

function installSuiteHooks8() {
    beforeEach(beWhale);
}

function installSuiteHooks9() {
    beforeEach(beWhale);
}

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('guard branches', function () {
    installSuiteHooks7();
it('applies a follower proposal (no resolve handler) on commit quorum', async function () {
            let config = { x: 1 };
            let digest = consensus._digest(config);
            consensus.pendingProposals.set(5, {
                config, digest, prepares: new Set(),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, resolve: null, reject: null, quorum: 3
            });
            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, sig_pubkey: VALIDATORS_4[2].pubkey, data: { seq: 5, configDigest: digest } });
            await waitUntil(() => !consensus.pendingProposals.has(5), { label: 'the follower apply to clear round 5' });
            expect(hub.applyConfig.calledOnce).to.be.true;
            expect(consensus.pendingProposals.has(5)).to.be.false; // applied and cleared
        });
it('follower apply error (no reject handler): swallows, keeps proposal pending for retry, applied stays false', async function () {
            // A follower has no resolve/reject handlers. On applyConfig failure the
            // proposal must remain in pendingProposals with applied=false so that an
            // external retry or a subsequent COMMIT message can re-trigger the apply
            // once the DB recovers. Dropping the proposal on error here would leave
            // the seq unapplied with no recovery path.
            hub.applyConfig.rejects(new Error('db down'));
            let config = { x: 1 };
            let digest = consensus._digest(config);
            consensus.pendingProposals.set(5, {
                config, digest, prepares: new Set(),
                commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                resolved: false, applied: false, timer: null, resolve: null, reject: null, quorum: 3
            });
            consensus._handleCommit({ sender: VALIDATORS_4[2].addr, sig_pubkey: VALIDATORS_4[2].pubkey, data: { seq: 5, configDigest: digest } });
            // The catch handler clears the in-flight guard, so `_applying === false`
            // is the failed apply having actually been handled: poll that, then assert
            // the proposal survived it. (A poll on `applyConfig.called` would pass
            // before the catch ran and would stop guarding the drop.)
            await waitUntil(() => {
                let p = consensus.pendingProposals.get(5);
                return p && p._applying === false;
            }, { label: 'the failed apply to run its catch handler' });
            // Proposal stays pending (retry path) and applied is still false.
            expect(consensus.pendingProposals.has(5)).to.be.true;
            expect(consensus.pendingProposals.get(5).applied).to.be.false;
        });
it('getQuorum returns 0 with neither validators nor a peer manager', function () {
            consensus.setValidatorSet([]);
            consensus.peerManager = null;
            expect(consensus.getQuorum()).to.equal(0);
        });
it('loadSeq treats a non-numeric stored value as 0', async function () {
            hub.db.doQuery.resolves([{ value: 'abc' }]);
            await consensus.loadSeq();
            expect(consensus.seq).to.equal(0);
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// STAKE_WEIGHTED_QUORUM (WI-1): weighted config consensus
describe('STAKE_WEIGHTED_QUORUM (WI-1)', function () {
it('propose() weighted: proposal carries weighted + source-keyed validators + self pubkey', async function () {
            // Equal-weight snapshot so the proposer's lone self-vote stays sub-quorum
            // (3·100 not > 2·400) and the proposal remains pending to inspect. With the
            // real whale snapshot it would clear 3S>2S on its own vote and self-delete.
            const EQUAL = WEIGHTED_VALIDATORS_4.map(v => ({ pubkey: v.pubkey, addr: v.addr, source: v.source, weight: '100' }));
            hub.network = 'testnet';
            hub.resolveBtcLatestBlock = sinon.stub().resolves(1);
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
it('stop() clears pendingViewChangePubkeys', async function () {
            consensus.pendingViewChangePubkeys.set(1, new Set(['x']));
            await consensus.stop();
            expect(consensus.pendingViewChangePubkeys.size).to.equal(0);
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('STAKE_WEIGHTED_QUORUM (WI-1)', function () {
describe('lockSnapshot()', function () {
it('weighted: locks the source-keyed weight snapshot at/above activation', async function () {
                hub.network = 'testnet';   // activation height 0
                hub.resolveBtcLatestBlock = sinon.stub().resolves(1);
                hub.capabilitySnapshot = {
                    getActiveWeightSnapshot:    sinon.stub().resolves(makeWeightSnapshot(WEIGHTED_VALIDATORS_4, 1)),
                    getActiveValidatorSnapshot: sinon.stub().resolves({ blockIndex: 1, count: 4, validators: [] }),
                    getQuorum:                  sinon.stub().returns(3)
                };
                let { snapshot, weighted } = await consensus.lockSnapshot();
                expect(weighted).to.equal(true);
                expect(hub.capabilitySnapshot.getActiveWeightSnapshot.calledWith(1)).to.be.true;
                expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.called).to.be.false;
                expect(snapshot.validators[0].source).to.equal('srcWhale');
            });
it('count: locks the legacy snapshot below the activation height', async function () {
                hub.network = 'mainnet';   // activation height 999999999 (placeholder)
                hub.resolveBtcLatestBlock = sinon.stub().resolves(800000);
                hub.capabilitySnapshot = {
                    getActiveWeightSnapshot:    sinon.stub().resolves(null),
                    getActiveValidatorSnapshot: sinon.stub().resolves({ blockIndex: 800000, count: 4, validators: [] }),
                    getQuorum:                  sinon.stub().returns(3)
                };
                let { weighted } = await consensus.lockSnapshot();
                expect(weighted).to.equal(false);
                expect(hub.capabilitySnapshot.getActiveValidatorSnapshot.calledWith(800000)).to.be.true;
                expect(hub.capabilitySnapshot.getActiveWeightSnapshot.called).to.be.false;
            });
});
describe('quorumMet()', function () {
it('count mode: vote-set size vs the round-locked quorum', function () {
                let ctx = { weighted: false, quorum: 3 };
                expect(consensus.quorumMet(ctx, new Set(['a', 'b']), null)).to.equal(false);
                expect(consensus.quorumMet(ctx, new Set(['a', 'b', 'c']), null)).to.equal(true);
            });
it('weighted mode: whale clears alone; a small-stake count-majority does not', function () {
                let ctx = { weighted: true, validators: normValidators() };
                // Whale alone (a COUNT minority of one): 3·1000 > 2·1300.
                expect(consensus.quorumMet(ctx, new Set(), new Set([WHALE.pubkey.toLowerCase()]))).to.equal(true);
                // All three small sources (a COUNT majority): 3·300 = 900, not > 2600.
                expect(consensus.quorumMet(ctx, new Set(), new Set(SMALL.map(v => v.pubkey.toLowerCase())))).to.equal(false);
            });
});
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('STAKE_WEIGHTED_QUORUM (WI-1)', function () {
describe('resolveSenderPubkey()', function () {
it('prefers envelope.sig_pubkey (lowercased)', function () {
                expect(consensus.resolveSenderPubkey({ sender: 'ws://x', sig_pubkey: 'AABB' })).to.equal('aabb');
            });
it('falls back to the addr→pubkey registry', function () {
                pm.validatorPubkeys = new Map([['ws://x', 'CCDD']]);
                expect(consensus.resolveSenderPubkey({ sender: 'ws://x' })).to.equal('ccdd');
            });
it('returns null when neither resolves', function () {
                pm.validatorPubkeys = new Map();
                expect(consensus.resolveSenderPubkey({ sender: 'ws://x' })).to.equal(null);
            });
});
describe('PREPARE and COMMIT weighted', function () {
    installSuiteHooks8();
it('whale PREPARE alone triggers COMMIT broadcast + seeds self commit pubkey', function () {
                let p = weightedProposal();
                p.preparePubkeys.add(WHALE.pubkey.toLowerCase());
                consensus.pendingProposals.set(1, p);
                consensus.checkPrepareQuorum(1);
                expect(p._commitSent).to.equal(true);
                expect(pm.broadcast.calledWith('PBFT_COMMIT')).to.be.true;
                expect(p.commitPubkeys.has(WHALE.pubkey.toLowerCase())).to.be.true;
            });
it('a small-stake COUNT majority PREPARE does NOT trigger COMMIT', function () {
                let p = weightedProposal();
                for (let v of SMALL) p.preparePubkeys.add(v.pubkey.toLowerCase());
                consensus.pendingProposals.set(1, p);
                consensus.checkPrepareQuorum(1);
                expect(p._commitSent).to.not.equal(true);
                expect(pm.broadcast.called).to.be.false;
            });
it('whale COMMIT alone applies the config', async function () {
                let p = weightedProposal();
                p.commitPubkeys.add(WHALE.pubkey.toLowerCase());
                consensus.pendingProposals.set(1, p);
                consensus.checkCommitQuorum(1);
                await new Promise(r => setImmediate(r));   // applyConfig is async
                expect(hub.applyConfig.calledWith({ cfg: 1 })).to.be.true;
            });
});
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('STAKE_WEIGHTED_QUORUM (WI-1)', function () {
describe('view-change weighted', function () {
    installSuiteHooks9();
it('initiateViewChange stashes the weighted context + seeds self view-change pubkey', function () {
                consensus.initiateViewChange(5, 3, true, normValidators());
                let ctx = consensus.viewChangeQuorums.get(5);
                expect(ctx.quorum).to.equal(3);
                expect(ctx.weighted).to.equal(true);
                expect(ctx.validators.length).to.equal(4);
                expect(consensus.pendingViewChangePubkeys.get(consensus.view).has(WHALE.pubkey.toLowerCase())).to.be.true;
            });
it('whale view-change vote alone promotes the view (proposal gone, initiator path)', function () {
                // No proposal in pendingProposals. Context recovered from the stash.
                consensus.viewChangeQuorums.set(5, { quorum: 3, weighted: true, validators: normValidators() });
                consensus.handleViewChange({ sender: WHALE.addr, sig_pubkey: WHALE.pubkey, data: { view: 1, seq: 5 } });
                expect(consensus.view).to.equal(1);
            });
it('a small-stake COUNT majority view-change does NOT promote the view', function () {
                consensus.viewChangeQuorums.set(5, { quorum: 3, weighted: true, validators: normValidators() });
                for (let v of SMALL)
                    consensus.handleViewChange({ sender: v.addr, sig_pubkey: v.pubkey, data: { view: 1, seq: 5 } });
                expect(consensus.view).to.equal(0);
            });
});
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// Federation-split fail-closed gate (FINDING #5334)
// A null validator snapshot (indexer down / timeout / 401-403 / malformed) must HALT a multi-hub
// config-change round, never let each hub finalize over its own local validatorSet. Single-host
// federations keep applying.
describe('null-snapshot fail-closed gate (#5334)', function () {
it('hasDeterministicSnapshot: true only for a real validators array', function () {
            expect(consensus.hasDeterministicSnapshot(null)).to.be.false;
            expect(consensus.hasDeterministicSnapshot({})).to.be.false;
            expect(consensus.hasDeterministicSnapshot({ validators: 'nope' })).to.be.false;
            expect(consensus.hasDeterministicSnapshot({ validators: {} })).to.be.false;
            expect(consensus.hasDeterministicSnapshot({ validators: [] })).to.be.true;
            expect(consensus.hasDeterministicSnapshot({ validators: [{ pubkey: 'ab' }] })).to.be.true;
        });
it('(a) propose() throws when minValidators>1 and snapshot is null', async function () {
            // Snapshot resolves to null (indexer unavailable). The leader must
            // refuse rather than fall back to getQuorum() over its local set.
            consensus.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // leader for seq 1
            consensus.minValidators = 4;
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().returns(null),
                getQuorum: sinon.stub().returns(0)
            };
            hub.resolveBtcLatestBlock = sinon.stub().resolves(800000);

            let caught = null;
            try {
                await consensus.propose({ cfg: 1 });
            } catch (e) {
                caught = e;
            }
            expect(caught).to.be.an('error');
            expect(caught.message).to.include('refusing to PROPOSE');
            expect(caught.message).to.include('deterministic');
            // Nothing applied, no PRE_PREPARE broadcast.
            expect(hub.applyConfig.called).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
});
});
