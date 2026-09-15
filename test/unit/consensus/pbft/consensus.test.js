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
// Wire the deterministic federation snapshot a real federated hub locks every round. #4168 keyed the
// fail-closed federation guards on the LIVE validator set instead of the optional MIN_VALIDATORS, so a
// multi-member set with a NULL snapshot now correctly refuses to propose or PREPARE. Tests exercising
// ordinary PBFT flow therefore supply the snapshot rather than riding the single-node fallback the
// default MIN_VALIDATORS once granted them. Quorum is stubbed to the same value _getQuorum() returns
// for the set under test, so what each test measures is unchanged. The snapshot's MEMBERS now decide
// the leader, so it has to carry the validators under test rather than a placeholder pubkey. Callers
// set the validator set first; the snapshot is built from it here.
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
// Quorum = max(2f+1, ceil((N+1)/2)) where f = floor((N-1)/3). The majority floor stops
// 2f+1 degenerating to 1 at N=3. N<=1 returns 0.
let cases = [
            { N: 1,  expected: 0, label: 'N=1 → 0 (single node)' },
            { N: 2,  expected: 2, label: 'N=2 → 2 (majority floor)' },
            { N: 3,  expected: 2, label: 'N=3 → 2 (majority floor)' },
            { N: 4,  expected: 3, label: 'N=4 → 3' },
            { N: 7,  expected: 5, label: 'N=7 → 5' },
            { N: 10, expected: 7, label: 'N=10 → 7' },
            { N: 13, expected: 9, label: 'N=13 → 9' }
        ];
const buildSet = (n) => Array.from({ length: n }, (_, i) => makeValidator(i + 1));
const freshConsensus = () => new Consensus(createMockHub());
function installSuiteHooks2() {
    beforeEach(function () {
                // Use VALIDATORS_4 (quorum=3) to prevent auto-completion in tests
                consensus.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}
describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// getQuorum()
describe('getQuorum()', function () {
for (let c of cases) {
            it(c.label, function () {
                let validators = Array.from({ length: c.N }, (_, i) => makeValidator(i + 1));
                consensus.setValidatorSet(validators);
                expect(consensus.getQuorum()).to.equal(c.expected);
            });
        }
it('falls back to live peer count when validator set is empty', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([
                { state: 'open' }, { state: 'open' }, { state: 'open' },
                { state: 'open' }, { state: 'open' }, { state: 'open' }
            ]);
            // N = 6 peers + 1 self = 7 → f = 2, quorum = 5
            expect(consensus.getQuorum()).to.equal(5);
        });
it('returns 0 when no peers and no validators', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(consensus.getQuorum()).to.equal(0);
        });
});
// _getLeader()
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
});

// L4 determinism: leader/quorum derivation (spec §6 / validator-test-spec)
// The validator-specific risk is *quiet divergence*: two hubs at the same block_index must derive the
// SAME quorum N and elect the SAME leader for each (seq, view), or the federation forks. These pin that
// contract for the config-PBFT path across two independently-constructed Consensus instances (the
// L1-level half of spec §6 "Determinism (L4)" item 1).
describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('L4 determinism: leader/quorum derivation', function () {
it('identical validator set: identical leader for every (seq, view) on two independent hubs', function () {
            const set = buildSet(7);
            const a = freshConsensus(); a.setValidatorSet(set);
            // b gets a deep copy (different object identities, same content), so
            // matching leaders prove content-level determinism, not shared refs.
            const b = freshConsensus(); b.setValidatorSet(set.map(v => ({ ...v })));
            for (let view = 0; view < 3; view++) {
                a.view = view; b.view = view;
                for (let seq = 0; seq < set.length * 2 + 1; seq++) {
                    expect(a._getLeader(seq)).to.deep.equal(b._getLeader(seq));
                }
            }
        });
it('quorum N is identical regardless of validator ordering (depends only on |set|)', function () {
            const set = buildSet(7);
            const a = freshConsensus(); a.setValidatorSet(set.slice());
            const b = freshConsensus(); b.setValidatorSet(set.slice().reverse());
            expect(a.getQuorum()).to.equal(b.getQuorum());
        });
// setValidatorSet canonicalizes order (validator_order.js), so leader election depends on MEMBERSHIP
// alone rather than every hub's loader emitting the same ordering. This is the consensus-breaking
// change itself; it ships ungated and is made safe by a mandatory fleet-wide wipe-and-replay rebase.
it('leader election is order-INSENSITIVE: divergent input ordering elects the same leader', function () {
            const set = buildSet(7);
            const a = freshConsensus(); a.setValidatorSet(set.slice());
            const b = freshConsensus(); b.setValidatorSet(set.slice().reverse());
            for (let view = 0; view < 3; view++) {
                a.view = view; b.view = view;
                for (let seq = 0; seq < set.length * 2 + 1; seq++) {
                    expect(a._getLeader(seq)).to.deep.equal(b._getLeader(seq));
                }
            }
        });
it('an arbitrarily shuffled input converges on the pubkey-sorted order', function () {
            const set = buildSet(10);
            const shuffled = set.slice().sort(() => Math.random() - 0.5);
            const a = freshConsensus(); a.setValidatorSet(shuffled);
            const expected = set.slice()
                .sort((x, y) => (x.pubkey < y.pubkey ? -1 : x.pubkey > y.pubkey ? 1 : 0));
            expect(a.validatorSet).to.deep.equal(expected);
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('L4 determinism: leader/quorum derivation', function () {
// The hub hands the SAME array object to five engines (XChainHub.propagateValidatorSet), so an in-place
// sort here would reorder a caller's array and leak one engine's canonicalization into the next input.
it('does not mutate or reorder the caller\'s array', function () {
            const set = buildSet(5);
            const caller = set.slice().reverse();
            const snapshot = caller.slice();
            const a = freshConsensus(); a.setValidatorSet(caller);
            expect(caller).to.deep.equal(snapshot);
            expect(a.validatorSet).to.not.equal(caller);
        });
// Duplicate pubkeys are not expected from the registry, but it can bind one signing key to several
// addrs; the addr tie-break keeps the order total instead of leaning on sort stability, which would
// just preserve the non-canonical input order.
it('ties on pubkey are broken by addr, so equal-key sets still order identically', function () {
            const dup = (addr) => ({ pubkey: 'aa'.repeat(32), addr: addr });
            const a = freshConsensus(); a.setValidatorSet([dup('ws://z:1'), dup('ws://a:1'), dup('ws://m:1')]);
            const b = freshConsensus(); b.setValidatorSet([dup('ws://m:1'), dup('ws://z:1'), dup('ws://a:1')]);
            expect(a.validatorSet).to.deep.equal(b.validatorSet);
            expect(a.validatorSet.map(v => v.addr)).to.deep.equal(['ws://a:1', 'ws://m:1', 'ws://z:1']);
        });
// Mixed-case pubkeys for the same key must not sort into two different buckets; the sort key is the
// lowercased pubkey, matching Governance.buildValidatorSnapshot and OracleConsensus._getLeader.
it('sorts on the LOWERCASED pubkey so case drift cannot reorder the set', function () {
            const lower = [
                { pubkey: 'aa'.repeat(32), addr: 'ws://1:1' },
                { pubkey: 'bb'.repeat(32), addr: 'ws://2:1' },
                { pubkey: 'cc'.repeat(32), addr: 'ws://3:1' }
            ];
            const upper = lower.map(v => ({ pubkey: v.pubkey.toUpperCase(), addr: v.addr })).reverse();
            const a = freshConsensus(); a.setValidatorSet(lower);
            const b = freshConsensus(); b.setValidatorSet(upper);
            expect(a.validatorSet.map(v => v.addr)).to.deep.equal(b.validatorSet.map(v => v.addr));
        });
it('empty set still elects no leader after canonicalization', function () {
            const a = freshConsensus(); a.setValidatorSet([]);
            expect(a.validatorSet).to.deep.equal([]);
            expect(a._getLeader(0)).to.be.null;
        });
});
});
describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// isLeader()
describe('isLeader()', function () {
it('returns true when this node is the leader', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
            expect(consensus.isLeader(0)).to.be.true;
        });
it('returns false when this node is not the leader', function () {
            consensus.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[2].addr;
            expect(consensus.isLeader(0)).to.be.false;
        });
});
// _digest()
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
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// propose(): single-node fallback
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
            wireFederationSnapshot(2, 800000); // N=3 -> quorum 2; clears the federation guard
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
            wireFederationSnapshot(3, 800000); // N=4 -> quorum 3
            consensus.seq = 0;
            pm.validatorAddr = VALIDATORS_4[1].addr; // Leader for seq 1: (1+0)%4 = 1
            let promise = consensus.propose({ cfg: 1 });
            // Wait for the async lockSnapshot to resolve before checking broadcast
            await new Promise(r => setImmediate(r));
            // Should have broadcast PRE_PREPARE as first call
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('PBFT_PRE_PREPARE');
            expect(data.seq).to.equal(1);
            expect(data.view).to.equal(0);              // leader stamps its view for the follower identity-guard
            expect(data.config).to.deep.equal({ cfg: 1 });
            expect(data.configDigest).to.be.a('string');
            // Clean up: reject the pending promise
            let pending = consensus.pendingProposals.get(1);
            if (pending) {
                if (pending.timer) clearTimeout(pending.timer);
                pending.resolved = true;
                pending.reject(new Error('test cleanup'));
            }
            await promise.catch(() => {});
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
// PBFT message flow
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('PRE_PREPARE creates follower proposal and broadcasts PREPARE', async function () {
            wireFederationSnapshot(3, 800000);
            let config = { x: 1 };
            let digest = consensus._digest(config);

            // seq 5, view 0: (5+0)%4 = 1, VALIDATORS_4[1] is the rotation leader.
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config, btcBlockHeight: 800000 }
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
            // seq 5, view 0: (5+0)%4 = 1, so VALIDATORS_4[1] is the only legitimate
            // proposer. A PRE_PREPARE from any other registered validator must NOT
            // create a pending proposal or broadcast a PREPARE. Otherwise any
            // authenticated validator could drive an uncontested seq to commit its
            // own config. (Without the identity guard this would have been accepted.)
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[2].addr,                       // not the leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[2].pubkey,
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
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, configDigest: digest, config }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
});
});

describe('Consensus (PBFT)', function () {
    installSuiteHooks1();
describe('PBFT message flow', function () {
    installSuiteHooks2();
it('PRE_PREPARE with wrong digest is rejected', function () {
            consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: 'bad-digest', config: { x: 1 } }
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
        });
it('PRE_PREPARE with missing fields is ignored', function () {
            consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: null, configDigest: null, config: null }
            });
            expect(consensus.pendingProposals.size).to.equal(0);
        });
it('federated follower declines to PREPARE when btcBlockHeight is omitted (fail closed, no local-tip fallback)', async function () {
            // #1791: with minValidators > 1, a PRE_PREPARE that omits btcBlockHeight
            // must NOT resolve the follower's own BTC tip (which would lock a
            // divergent validator snapshot vs the leader). It must be declined.
            consensus.minValidators = 2;
            hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
            let config = { x: 1 };
            let digest = consensus._digest(config);
            await consensus.handlePrePrepare({
                sender: VALIDATORS_4[1].addr,                       // leader for (seq 5, view 0)
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { seq: 5, view: 0, configDigest: digest, config }  // no btcBlockHeight
            });
            expect(consensus.pendingProposals.has(5)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
            // Critically, the own-tip resolver was never consulted for this message.
            expect(hub._resolveBtcLatestBlock.called).to.be.false;
        });
});
});
