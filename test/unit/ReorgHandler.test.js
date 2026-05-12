'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../src/ReorgHandler');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3 }      = require('../helpers/fixtures');

describe('ReorgHandler', function () {

    let hub, pm, rh;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        rh  = new ReorgHandler(hub);
    });

    afterEach(function () {
        for (let [, pending] of rh.pendingReorgs) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _getAffectedChains()
    // -----------------------------------------------------------------

    describe('_getAffectedChains()', function () {
        it('returns all chains except source — BTC', function () {
            expect(rh._getAffectedChains('BTC')).to.deep.equal(['LTC', 'DOGE']);
        });

        it('returns all chains except source — LTC', function () {
            expect(rh._getAffectedChains('LTC')).to.deep.equal(['BTC', 'DOGE']);
        });

        it('returns all chains except source — DOGE', function () {
            expect(rh._getAffectedChains('DOGE')).to.deep.equal(['BTC', 'LTC']);
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        it('N=3 → 1', function () {
            rh.setValidatorSet(VALIDATORS_3);
            // f=floor(2/3)=0, quorum=2*0+1=1
            expect(rh._getQuorum()).to.equal(1);
        });

        it('single node → 0', function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(rh._getQuorum()).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

    describe('_digest()', function () {
        it('returns 64-char hex hash', function () {
            expect(rh._digest('BTC:100:123', 'BTC', 100, 123)).to.match(/^[0-9a-f]{64}$/);
        });

        it('is deterministic', function () {
            let a = rh._digest('id', 'BTC', 100, 999);
            let b = rh._digest('id', 'BTC', 100, 999);
            expect(a).to.equal(b);
        });
    });

    // -----------------------------------------------------------------
    // reportReorg() — single-node fallback
    // -----------------------------------------------------------------

    describe('reportReorg()', function () {

        it('single-node executes rollback directly', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            await rh.reportReorg('BTC', 500000, Date.now());

            // Should have called doQuery for: delete attestations, update snapshots, insert reorg attestation
            expect(hub.db.doQuery.callCount).to.equal(3);
            expect(hub.db.doQuery.getCall(0).args[0]).to.include('DELETE FROM attestations');
            expect(hub.db.doQuery.getCall(1).args[0]).to.include("status = 'disputed'");
            expect(hub.db.doQuery.getCall(2).args[0]).to.include('reorg_attestations');
        });

        it('single-node emits reorg:confirmed event', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let emitted = null;
            rh.on('reorg:confirmed', (d) => { emitted = d; });

            await rh.reportReorg('LTC', 300000, 1700000000000);

            expect(emitted).to.not.be.null;
            expect(emitted.sourceChain).to.equal('LTC');
            expect(emitted.reorgHeight).to.equal(300000);
        });

        it('skips already-processed reorgs', async function () {
            rh.processed.add('BTC:500000:123');
            await rh.reportReorg('BTC', 500000, 123);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('multi-node broadcasts REORG_ALERT and initiates consensus', async function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;

            await rh.reportReorg('BTC', 500000, 1700000000000);

            // With N=3 and quorum=1, self-prepare meets quorum immediately.
            // Broadcasts: REORG_ALERT, XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT
            expect(pm.broadcast.callCount).to.be.at.least(2);
            expect(pm.broadcast.getCall(0).args[0]).to.equal('REORG_ALERT');
            expect(pm.broadcast.getCall(1).args[0]).to.equal('XCHAIN_REORG_PREPARE');
        });
    });

    // -----------------------------------------------------------------
    // _executeRollback()
    // -----------------------------------------------------------------

    describe('_executeRollback()', function () {

        it('deletes attestations for affected chain after timestamp', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-1', 3, '[]');

            let deleteCall = hub.db.doQuery.getCall(0);
            expect(deleteCall.args[0]).to.include('DELETE FROM attestations');
            expect(deleteCall.args[1][0]).to.equal('BTC');
            expect(deleteCall.args[1][1]).to.equal(1700000000000);
        });

        it('marks price snapshots as disputed', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-1', 3, '[]');

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[0]).to.include("status = 'disputed'");
        });

        it('stores reorg attestation', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-1', 3, '["v1","v2","v3"]');

            let insertCall = hub.db.doQuery.getCall(2);
            expect(insertCall.args[0]).to.include('reorg_attestations');
            expect(insertCall.args[1]).to.include('reorg-1');
            expect(insertCall.args[1]).to.include(3); // validator_count
        });

        it('adds reorgId to processed set', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-x', 1, '[]');
            expect(rh.processed.has('reorg-x')).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // PBFT reorg flow
    // -----------------------------------------------------------------

    describe('PBFT reorg flow', function () {

        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
        });

        it('PREPARE from peer is recorded', function () {
            let reorgId = 'BTC:500:123';
            let digest = rh._digest(reorgId, 'BTC', 500, 123);

            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
                affectedChains: ['LTC', 'DOGE'], digest,
                prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
                        affectedChains: ['LTC', 'DOGE'], digest }
            });

            expect(rh.pendingReorgs.get(reorgId).prepares.has(VALIDATORS_3[1].addr)).to.be.true;
        });

        it('PREPARE with wrong digest is rejected', function () {
            let reorgId = 'BTC:500:123';
            let digest = rh._digest(reorgId, 'BTC', 500, 123);

            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
                affectedChains: ['LTC', 'DOGE'], digest,
                prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, digest: 'wrong' }
            });

            expect(rh.pendingReorgs.get(reorgId).prepares.size).to.equal(0);
        });

        it('COMMIT quorum executes rollback', async function () {
            let reorgId = 'BTC:500:123';
            let digest = rh._digest(reorgId, 'BTC', 500, 123);

            rh.pendingReorgs.set(reorgId, {
                reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
                affectedChains: ['LTC', 'DOGE'], digest,
                prepares: new Set([VALIDATORS_3[0].addr, VALIDATORS_3[1].addr]),
                commits: new Set([VALIDATORS_3[0].addr]),
                finalized: false, timer: null, _commitSent: true
            });

            let emitted = null;
            rh.on('reorg:confirmed', (d) => { emitted = d; });

            rh._handleCommit({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, digest }
            });

            await new Promise(r => setTimeout(r, 20));

            expect(hub.db.doQuery.callCount).to.equal(3); // delete + update + insert
            expect(rh.processed.has(reorgId)).to.be.true;
            expect(emitted).to.not.be.null;
        });
    });

    // -----------------------------------------------------------------
    // getReorgHistory()
    // -----------------------------------------------------------------

    describe('getReorgHistory()', function () {
        it('queries with limit', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory(10);
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([10]);
        });

        it('defaults to 50', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory();
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([50]);
        });
    });
});
