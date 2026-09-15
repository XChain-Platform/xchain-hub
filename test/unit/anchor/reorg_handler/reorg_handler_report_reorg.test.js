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
//
// ReorgHandler: the reportReorg() entry point (single-node fallback, blast-radius
// bound, multi-node broadcast and argument validation), executeRollback() and the
// inbound handleAlert() and commit-quorum error paths.

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../../../src/anchor/reorg_handler');
const { createMockHub }     = require('../../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4 } = require('../../../helpers/fixtures');
const { waitUntil }  = require('../../../helpers/waitUntil');

// A valid observed-hash pair for the R2-C2 wire format (distinct 64-hex).
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

// The handler under test and its mock hub, rebuilt by the hooks inside the
// ReorgHandler describe before every case.
let hub, pm, rh;

// Most flow tests are about the PBFT round, not the node probe, so verification
// is stubbed to "confirmed". The probe itself is covered in its own section.
function stubVerified(result = true) {
    return sinon.stub(rh, 'verifyReorgAgainstOwnNode').resolves(result);
}

describe('ReorgHandler', function () {

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

    registerReportReorg();
    registerExecuteRollback();
    registerHandleAlert();
    registerReportReorgValidation();
    registerCommitQuorumFailure();
});

// -----------------------------------------------------------------
// reportReorg(): single-node fallback
// -----------------------------------------------------------------

function registerReportReorg() {
    describe('reportReorg()', function () {
        registerReportSingleNodeCases();
        registerReportBoundAndBroadcastCases();
    });
}

// reportReorg() on a single node: direct rollback, the confirmed event, and the
// processed-set short circuit.
function registerReportSingleNodeCases() {
    it('single-node executes rollback directly (after self-verification)', async function () {
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        stubVerified(true);

        await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);

        // Should have called doQuery for: delete attestations, update snapshots, insert reorg attestation
        expect(hub.db.doQuery.callCount).to.equal(3);
        expect(hub.db.doQuery.getCall(0).args[0]).to.include('DELETE FROM attestations');
        expect(hub.db.doQuery.getCall(1).args[0]).to.include("status = 'disputed'");
        expect(hub.db.doQuery.getCall(2).args[0]).to.include('reorg_attestations');
    });

    it('single-node emits reorg:confirmed event', async function () {
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        stubVerified(true);

        let emitted = null;
        rh.on('reorg:confirmed', (d) => { emitted = d; });

        await rh.reportReorg('LTC', 300000, Date.now(), OLD_HASH, NEW_HASH);

        expect(emitted).to.not.be.null;
        expect(emitted.sourceChain).to.equal('LTC');
        expect(emitted.reorgHeight).to.equal(300000);
    });

    it('skips already-processed reorgs', async function () {
        let ts = Date.now();
        rh.processed.add('BTC:500000:' + ts);
        let verify = stubVerified(true);
        await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH);
        expect(hub.db.doQuery.called).to.be.false;
        expect(verify.called, 'no probe for an already-processed reorg').to.be.false;
    });
}

// reportReorg(): the far-past timestamp bound and the multi-node ALERT / PREPARE
// broadcast.
function registerReportBoundAndBroadcastCases() {
    it('rejects a reorg whose timestamp is far in the past (blast-radius bound)', async function () {
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        let threw = false;
        // A timestamp near epoch would otherwise DELETE nearly all attestations.
        try { await rh.reportReorg('BTC', 500000, 1700000000000, OLD_HASH, NEW_HASH); }
        catch (e) { threw = true; expect(e.message).to.match(/too far in the past/); }
        expect(threw).to.be.true;
        expect(hub.db.doQuery.called).to.be.false;
    });

    it('multi-node broadcasts REORG_ALERT (carrying the hash pair) and initiates consensus', async function () {
        rh.setValidatorSet(VALIDATORS_3);
        pm.validatorAddr = VALIDATORS_3[0].addr;
        stubVerified(true);

        await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);

        // With N=3 and quorum=1, self-prepare meets quorum immediately.
        // Broadcasts: REORG_ALERT, XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT
        expect(pm.broadcast.callCount).to.be.at.least(2);
        expect(pm.broadcast.getCall(0).args[0]).to.equal('REORG_ALERT');
        expect(pm.broadcast.getCall(0).args[1].oldHash).to.equal(OLD_HASH);
        expect(pm.broadcast.getCall(0).args[1].newHash).to.equal(NEW_HASH);
        expect(pm.broadcast.getCall(1).args[0]).to.equal('XCHAIN_REORG_PREPARE');
        expect(pm.broadcast.getCall(1).args[1].oldHash).to.equal(OLD_HASH);
        expect(pm.broadcast.getCall(1).args[1].newHash).to.equal(NEW_HASH);
    });
}

// -----------------------------------------------------------------
// executeRollback()
// -----------------------------------------------------------------

function registerExecuteRollback() {
    describe('executeRollback()', function () {

        it('deletes attestations for affected chain after a recent timestamp (legacy fallback bound)', async function () {
            let ts = Date.now() - 60000;
            await rh.executeRollback('BTC', 500000, ts, 'reorg-1', 3, '[]');

            let deleteCall = hub.db.doQuery.getCall(0);
            expect(deleteCall.args[0]).to.include('DELETE FROM attestations');
            expect(deleteCall.args[1][0]).to.equal('BTC');
            expect(deleteCall.args[1][1]).to.equal(ts);
        });

        it('anchors the DELETE/UPDATE bound to the observed block_time, not the reported timestamp', async function () {
            // R1 (over/under-rollback): the reporter-supplied timestamp is gameable,
            // so the bound must come from OUR OWN node's block_time for reorgHeight.
            let reported  = Date.now() - 12 * 3600000;   // adversarial far-past report
            let blockTime = Date.now() - 600000;         // the reorged block is 10 min old
            await rh.executeRollback('BTC', 500000, reported, 'reorg-bt', 3, '[]', blockTime);

            expect(hub.db.doQuery.getCall(0).args[1][1], 'attestation DELETE bound').to.equal(blockTime);
            expect(hub.db.doQuery.getCall(1).args[1][0], 'snapshot dispute bound').to.equal(blockTime);
        });

        it('clamps the rollback bound to the lookback floor (blast-radius bound)', async function () {
            let before = Date.now() - rh.maxLookbackMs;
            await rh.executeRollback('BTC', 500000, Date.now(), 'reorg-deep', 3, '[]',
                Date.now() - 3 * rh.maxLookbackMs);      // fabricated deep "reorg" block_time
            let after = Date.now() - rh.maxLookbackMs;

            let bound = hub.db.doQuery.getCall(0).args[1][1];
            expect(bound, 'bound never reaches past the lookback window').to.be.at.least(before);
            expect(bound).to.be.at.most(after);
        });

        it('marks price snapshots as disputed', async function () {
            await rh.executeRollback('BTC', 500000, Date.now() - 60000, 'reorg-1', 3, '[]');

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[0]).to.include("status = 'disputed'");
        });

        it('stores reorg attestation', async function () {
            await rh.executeRollback('BTC', 500000, Date.now() - 60000, 'reorg-1', 3, '["v1","v2","v3"]');

            let insertCall = hub.db.doQuery.getCall(2);
            expect(insertCall.args[0]).to.include('reorg_attestations');
            expect(insertCall.args[1]).to.include('reorg-1');
            expect(insertCall.args[1]).to.include(3); // validator_count
        });

        it('adds reorgId to processed set', async function () {
            await rh.executeRollback('BTC', 500000, Date.now() - 60000, 'reorg-x', 1, '[]');
            expect(rh.processed.has('reorg-x')).to.be.true;
        });
    });
}

// -----------------------------------------------------------------
// handleAlert()
// -----------------------------------------------------------------

function registerHandleAlert() {
    describe('handleAlert()', function () {
        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('ignores an alert with missing fields', async function () {
            await rh.handleAlert({ sender: 'peer', data: { chain: 'BTC' } });
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('ignores an alert for an already-processed reorg', async function () {
            rh.processed.add('BTC:5:1700000000000');
            await rh.handleAlert({ sender: 'peer', data: { chain: 'BTC', reorgHeight: 5, timestamp: 1700000000000, reorgId: 'BTC:5:1700000000000', oldHash: OLD_HASH, newHash: NEW_HASH } });
            expect(rh.pendingReorgs.size).to.equal(0);
        });

        it('starts consensus for a new (verified) reorg alert', async function () {
            stubVerified(true);
            let ts = Date.now();
            let reorgId = 'BTC:5:' + ts;
            let init = sinon.spy(rh, 'initiateReorgConsensus');
            await rh.handleAlert({ sender: 'peer', data: { chain: 'BTC', reorgHeight: 5, timestamp: ts, reorgId, oldHash: OLD_HASH, newHash: NEW_HASH } });
            expect(init.calledOnce).to.be.true;
            let p = rh.pendingReorgs.get(reorgId);
            if (p && p.timer) clearTimeout(p.timer);
        });
    });
}

// -----------------------------------------------------------------
// Commit-quorum rollback error path
// -----------------------------------------------------------------

function registerReportReorgValidation() {
    describe('reportReorg() validation', function () {
        it('rejects an unsupported chain', async function () {
            try { await rh.reportReorg('ETH', 5, Date.now(), OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Invalid chain'); }
        });

        it('rejects a negative / non-integer reorgHeight', async function () {
            try { await rh.reportReorg('BTC', -1, Date.now(), OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('non-negative integer'); }
        });

        it('rejects a negative timestamp', async function () {
            try { await rh.reportReorg('BTC', 5, -1, OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('non-negative number'); }
        });

        it('rejects a timestamp too far in the future', async function () {
            try { await rh.reportReorg('BTC', 5, Date.now() + 600000, OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('future'); }
        });

        it('enforces the per-chain rate limit', async function () {
            rh.reorgRateTracker.set('BTC', Date.now());
            try { await rh.reportReorg('BTC', 5, Date.now(), OLD_HASH, NEW_HASH); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Rate limit'); }
        });

        it('an ALREADY-PROCESSED reorg is ignored, not rate-limited', async function () {
            // Re-reporting a reorg this hub has already rolled back must stay a silent
            // no-op even inside the 60s window; it once threw 'Rate limit ...'
            // because the limiter sat in front of the dedup return.
            let ts = Date.now();
            rh.processed.add('BTC:5:' + ts);
            rh.reorgRateTracker.set('BTC', ts);
            await rh.reportReorg('BTC', 5, ts, OLD_HASH, NEW_HASH);
            expect(hub.db.doQuery.called, 'no work for an already-processed reorg').to.be.false;
        });

        it('initiateReorgConsensus is a no-op for an already-pending reorg', function () {
            rh.pendingReorgs.set('r1', { timer: null });
            rh.initiateReorgConsensus('r1', 'BTC', 5, 1, ['LTC', 'DOGE'], OLD_HASH, NEW_HASH);
            expect(rh.pendingReorgs.get('r1')).to.deep.equal({ timer: null });
        });
    });
}

function registerCommitQuorumFailure() {
    describe('checkCommitQuorum() rollback failure', function () {
        it('logs and clears the pending reorg when rollback execution throws', async function () {
            sinon.stub(rh, 'executeRollback').rejects(new Error('db down'));
            rh.pendingReorgs.set('BTC:5:1', {
                chain: 'BTC', reorgHeight: 5, timestamp: 1,
                prepares: new Set(['a', 'b']), commits: new Set(['a', 'b']),
                finalized: false, timer: null, quorum: 2, digest: 'd', selfVerified: true
            });
            rh.checkCommitQuorum('BTC:5:1');
            await waitUntil(() => rh.pendingReorgs.has('BTC:5:1') === false, { label: 'the failed rollback to clear the pending reorg' });
            expect(rh.pendingReorgs.has('BTC:5:1')).to.be.false;
        });
    });
}
