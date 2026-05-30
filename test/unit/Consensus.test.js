'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const Consensus      = require('../../src/Consensus');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        makeValidator } = require('../helpers/fixtures');

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
        // Quorum = 2f+1 where f = floor((N-1)/3). N<=1 returns 0 (single-node).
        let cases = [
            { N: 1,  expected: 0, label: 'N=1 → 0 (single node)' },
            { N: 2,  expected: 1, label: 'N=2 → 1' },
            { N: 3,  expected: 1, label: 'N=3 → 1' },
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

            await consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, configDigest: digest, config }
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

        it('PRE_PREPARE with wrong digest is rejected', function () {
            consensus._handlePrePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { seq: 5, configDigest: 'bad-digest', config: { x: 1 } }
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
    });
});
