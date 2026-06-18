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
const ReorgHandler   = require('../../src/ReorgHandler');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4 } = require('../helpers/fixtures');

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
        it('returns all chains except source: BTC', function () {
            expect(rh._getAffectedChains('BTC')).to.deep.equal(['LTC', 'DOGE']);
        });

        it('returns all chains except source: LTC', function () {
            expect(rh._getAffectedChains('LTC')).to.deep.equal(['BTC', 'DOGE']);
        });

        it('returns all chains except source: DOGE', function () {
            expect(rh._getAffectedChains('DOGE')).to.deep.equal(['BTC', 'LTC']);
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        it('N=3 → 2 (majority floor)', function () {
            rh.setValidatorSet(VALIDATORS_3);
            // f=floor(2/3)=0 → 2f+1=1, floored at ceil((3+1)/2)=2
            expect(rh._getQuorum()).to.equal(2);
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
    // reportReorg(): single-node fallback
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
    // Consensus timeout: surfaced event (not silent discard)
    //
    // When a reorg round can't reach quorum within the window, the pending
    // rollback used to be dropped with only a console.warn, leaving cross-chain
    // state dirty after a reorg with no programmatic signal. The handler now
    // emits a 'reorg:timeout' event carrying the discarded rollback details
    // before deleting it, so operators/consumers can alert or retry.
    // -----------------------------------------------------------------

    describe('consensus timeout event', function () {

        let clock;

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
        });

        it('emits reorg:timeout instead of silently discarding when quorum is not reached', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            // N=4 → quorum=3, so a lone self-prepare can't finalize and the round
            // must time out (N=3 would finalize immediately at quorum=1).
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let emitted = null;
            rh.on('reorg:timeout', (d) => { emitted = d; });

            await rh.reportReorg('BTC', 500000, 1700000000000);
            let reorgId = 'BTC:500000:1700000000000';

            // Round is pending, no event yet.
            expect(rh.pendingReorgs.has(reorgId)).to.be.true;
            expect(emitted).to.be.null;

            // Window elapses without quorum → event fires, round discarded.
            clock.tick(rh.timeout + 1);

            expect(emitted).to.not.be.null;
            expect(emitted.reorgId).to.equal(reorgId);
            expect(emitted.sourceChain).to.equal('BTC');
            expect(emitted.reorgHeight).to.equal(500000);
            expect(emitted.affectedChains).to.deep.equal(['LTC', 'DOGE']);
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
        });

        it('emits reorg:timeout for a follower-created round (PREPARE path) that never reaches quorum', function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;

            let reorgId = 'LTC:300:1700000000000';
            let digest = rh._digest(reorgId, 'LTC', 300, 1700000000000);

            let emitted = null;
            rh.on('reorg:timeout', (d) => { emitted = d; });

            // A peer's PREPARE creates the pending round locally.
            rh._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: 1700000000000,
                        affectedChains: ['BTC', 'DOGE'], digest }
            });
            expect(rh.pendingReorgs.has(reorgId)).to.be.true;

            // Follower timer is timeout*2; quorum (3) unreachable → event fires.
            clock.tick(rh.timeout * 2 + 1);

            expect(emitted).to.not.be.null;
            expect(emitted.reorgId).to.equal(reorgId);
            expect(emitted.sourceChain).to.equal('LTC');
            expect(rh.pendingReorgs.has(reorgId)).to.be.false;
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

    // -----------------------------------------------------------------
    // start() / stop() + dispatch
    // -----------------------------------------------------------------

    describe('start() / stop()', function () {
        it('start subscribes to peer messages; stop unsubscribes and clears pending timers', async function () {
            await rh.start();
            expect(rh._messageHandler).to.be.a('function');
            expect(pm.listenerCount('message')).to.equal(1);

            rh.pendingReorgs.set('x', { timer: setTimeout(() => {}, 60000) });
            await rh.stop();

            expect(rh._messageHandler).to.equal(null);
            expect(pm.listenerCount('message')).to.equal(0);
            expect(rh.pendingReorgs.size).to.equal(0);
        });
    });

    describe('_handleMessage dispatch', function () {
        it('routes alert / prepare / commit and ignores unknown types', function () {
            let a = sinon.spy(rh, '_handleAlert');
            let p = sinon.spy(rh, '_handlePrepare');
            let c = sinon.spy(rh, '_handleCommit');
            rh._handleMessage({ type: 'REORG_ALERT', data: {} });
            rh._handleMessage({ type: 'XCHAIN_REORG_PREPARE', data: {} });
            rh._handleMessage({ type: 'XCHAIN_REORG_COMMIT', data: {} });
            expect(() => rh._handleMessage({ type: 'NOPE', data: {} })).to.not.throw();
            expect(a.calledOnce).to.be.true;
            expect(p.calledOnce).to.be.true;
            expect(c.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // _handleAlert()
    // -----------------------------------------------------------------

    describe('_handleAlert()', function () {
        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('ignores an alert with missing fields', function () {
            rh._handleAlert({ sender: 'peer', data: { chain: 'BTC' } });
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('ignores an alert for an already-processed reorg', function () {
            rh.processed.add('BTC:5:1700000000000');
            rh._handleAlert({ sender: 'peer', data: { chain: 'BTC', reorgHeight: 5, timestamp: 1700000000000, reorgId: 'BTC:5:1700000000000' } });
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('starts consensus for a new reorg alert', function () {
            let init = sinon.spy(rh, '_initiateReorgConsensus');
            rh._handleAlert({ sender: 'peer', data: { chain: 'BTC', reorgHeight: 5, timestamp: 1700000000000, reorgId: 'BTC:5:1700000000000' } });
            expect(init.calledOnce).to.be.true;
            let p = rh.pendingReorgs.get('BTC:5:1700000000000');
            if (p && p.timer) clearTimeout(p.timer);
        });
    });

    // -----------------------------------------------------------------
    // Commit-quorum rollback error path
    // -----------------------------------------------------------------

    describe('reportReorg() validation', function () {
        it('rejects an unsupported chain', async function () {
            try { await rh.reportReorg('ETH', 5, Date.now()); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Invalid chain'); }
        });

        it('rejects a negative / non-integer reorgHeight', async function () {
            try { await rh.reportReorg('BTC', -1, Date.now()); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('non-negative integer'); }
        });

        it('rejects a negative timestamp', async function () {
            try { await rh.reportReorg('BTC', 5, -1); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('non-negative number'); }
        });

        it('rejects a timestamp too far in the future', async function () {
            try { await rh.reportReorg('BTC', 5, Date.now() + 600000); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('future'); }
        });

        it('enforces the per-chain rate limit', async function () {
            rh.reorgRateTracker.set('BTC', Date.now());
            try { await rh.reportReorg('BTC', 5, Date.now()); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Rate limit'); }
        });

        it('_initiateReorgConsensus is a no-op for an already-pending reorg', function () {
            rh.pendingReorgs.set('r1', { timer: null });
            rh._initiateReorgConsensus('r1', 'BTC', 5, 1, ['LTC', 'DOGE']);
            expect(rh.pendingReorgs.get('r1')).to.deep.equal({ timer: null });
        });
    });

    describe('_checkCommitQuorum() rollback failure', function () {
        it('logs and clears the pending reorg when rollback execution throws', async function () {
            sinon.stub(rh, '_executeRollback').rejects(new Error('db down'));
            rh.pendingReorgs.set('BTC:5:1', {
                chain: 'BTC', reorgHeight: 5, timestamp: 1,
                prepares: new Set(['a', 'b']), commits: new Set(['a', 'b']),
                finalized: false, timer: null, quorum: 2, digest: 'd'
            });
            rh._checkCommitQuorum('BTC:5:1');
            await new Promise(r => setTimeout(r, 20));
            expect(rh.pendingReorgs.has('BTC:5:1')).to.be.false;
        });
    });
});
