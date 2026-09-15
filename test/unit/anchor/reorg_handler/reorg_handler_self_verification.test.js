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
// ReorgHandler: the R2-C2 self-node verification gates. Every inbound path
// (reportReorg, handleAlert, handlePrepare and the commit round) abstains unless
// this hub's own indexer confirms the reorg, and the rollback bound is anchored
// to the block_time that confirmation observed.

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../../../src/anchor/reorg_handler');
const { createMockHub }     = require('../../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4 } = require('../../../helpers/fixtures');

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

    registerSelfVerification();
});

// -----------------------------------------------------------------
// R2-C2: self-node verification gates
// -----------------------------------------------------------------

function registerSelfVerification() {
    describe('self-node verification (R2-C2)', function () {
        registerVerificationGateCases();
        registerReportBlockTimeCases();
        registerRoundBlockTimeCases();
        registerInboundAlertGuardCases();
        registerInboundPrepareGuardCases();
        registerDigestAndUnverifiedRoundCases();
    });
}

// The hash-pair check and the own-node confirmation gate on reportReorg and
// handleAlert.
function registerVerificationGateCases() {
    it('reportReorg requires a well-formed, distinct hash pair', async function () {
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        for (let [o, n] of [[undefined, undefined], [OLD_HASH, OLD_HASH], ['nope', NEW_HASH]]) {
            let threw = false;
            try { await rh.reportReorg('BTC', 500000, Date.now(), o, n); }
            catch (e) { threw = true; expect(e.message).to.match(/distinct 64-hex/); }
            expect(threw, 'should reject ' + o + '/' + n).to.be.true;
        }
        expect(hub.db.doQuery.called).to.be.false;
    });

    it('reportReorg refuses (and does not broadcast or roll back) when the own node does not confirm', async function () {
        rh.setValidatorSet(VALIDATORS_3);
        pm.validatorAddr = VALIDATORS_3[0].addr;
        stubVerified(false);

        let threw = false;
        try { await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH); }
        catch (e) { threw = true; expect(e.message).to.match(/own indexer does not confirm/); }
        expect(threw).to.be.true;
        expect(pm.broadcast.called).to.be.false;
        expect(hub.db.doQuery.called).to.be.false;
        expect(rh.pendingReorgs.size).to.equal(0);
    });

    it('single-node fast path is gated on self-verification too', async function () {
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        stubVerified(false);

        let threw = false;
        try { await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH); }
        catch (e) { threw = true; }
        expect(threw).to.be.true;
        expect(hub.db.doQuery.called, 'no rollback without confirmation').to.be.false;
    });

    it('handleAlert abstains (no round, no PREPARE) when verification fails', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        stubVerified(false);

        let ts = Date.now();
        let reorgId = 'BTC:500:' + ts;
        await rh.handleAlert({
            sender: VALIDATORS_4[1].addr,
            data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId)).to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });
}

// reportReorg(): a timestamp that predates the observed block_time is refused,
// and a single-node rollback anchors its bound to that block_time.
function registerReportBlockTimeCases() {
    it('reportReorg rejects a timestamp that predates the reorged block\'s own block_time', async function () {
        // R1 (over-rollback): a registered reporter announcing a REAL reorg with a
        // far-past timestamp must be refused once our own node shows the reorged
        // block is fresh (a reorg cannot be observed before the block existed).
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        let blockTime = Date.now() - 60000;                       // block mined 1 min ago
        stubVerified({ blockTimeMs: blockTime });

        let threw = false;
        let ts = blockTime - rh.timestampSkewToleranceMs - 60000; // predates block beyond tolerance
        try { await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH); }
        catch (e) { threw = true; expect(e.message).to.match(/predates the reorged block/); }
        expect(threw).to.be.true;
        expect(hub.db.doQuery.called, 'no rollback for an over-reaching timestamp').to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('single-node rollback anchors its bound to the observed block_time', async function () {
        rh.setValidatorSet([]);
        pm.getPeerStatus.returns([]);
        let blockTime = Date.now() - 600000;                      // reorged block 10 min old
        stubVerified({ blockTimeMs: blockTime });

        await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);

        expect(hub.db.doQuery.getCall(0).args[1][1], 'DELETE bound = block_time, not reported now')
            .to.equal(blockTime);
        expect(hub.db.doQuery.getCall(1).args[1][0], 'dispute bound = block_time').to.equal(blockTime);
    });
}

// The follower paths and the consensus round carry the same block_time bound.
function registerRoundBlockTimeCases() {
    it('handleAlert abstains when the timestamp predates the observed block_time', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        let blockTime = Date.now() - 60000;
        stubVerified({ blockTimeMs: blockTime });

        let ts = blockTime - rh.timestampSkewToleranceMs - 60000;
        let reorgId = 'BTC:500:' + ts;
        await rh.handleAlert({
            sender: VALIDATORS_4[1].addr,
            data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId), 'no round co-signed').to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('handlePrepare (leader-bypass) abstains when the timestamp predates the observed block_time', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        let blockTime = Date.now() - 60000;
        stubVerified({ blockTimeMs: blockTime });

        let ts = blockTime - rh.timestampSkewToleranceMs - 60000;
        let reorgId = 'BTC:500:' + ts;
        let digest = rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH);
        await rh.handlePrepare({
            sender: VALIDATORS_4[1].addr,
            data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                    affectedChains: ['LTC', 'DOGE'], digest,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId), 'no round joined').to.be.false;
    });

    it('a consensus round carries the observed block_time into the rollback bound', async function () {
        rh.setValidatorSet(VALIDATORS_3);
        pm.validatorAddr = VALIDATORS_3[0].addr;
        let blockTime = Date.now() - 600000;
        stubVerified({ blockTimeMs: blockTime });

        let ts = Date.now();
        await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH);
        let reorgId = 'BTC:500000:' + ts;
        let pending = rh.pendingReorgs.get(reorgId);
        expect(pending, 'round created').to.exist;
        expect(pending.observedBlockTimeMs).to.equal(blockTime);

        // Drive the round to commit quorum and confirm the executed bound.
        pending.commits.add(VALIDATORS_3[1].addr);
        pending.commits.add(VALIDATORS_3[2].addr);
        rh.checkCommitQuorum(reorgId);
        await new Promise(r => setImmediate(r));
        expect(hub.db.doQuery.getCall(0).args[1][1], 'quorum rollback bound = block_time')
            .to.equal(blockTime);
    });
}

// handleAlert(): a hashless alert, a non-canonical reorgId and the concurrent-round
// cap are all dropped before the indexer probe.
function registerInboundAlertGuardCases() {
    it('handleAlert ignores an alert missing the hash pair (legacy / malformed wire)', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        let verify = stubVerified(true);
        let ts = Date.now();
        await rh.handleAlert({
            sender: VALIDATORS_4[1].addr,
            data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId: 'BTC:500:' + ts }
        });
        expect(rh.pendingReorgs.size).to.equal(0);
        expect(verify.called, 'no probe for a hashless alert').to.be.false;
    });

    it('handleAlert drops an ALERT whose reorgId is not the canonical chain:height:timestamp (REORG-INBOUND-UNBOUNDED-ROUNDS-1)', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        let verify = stubVerified(true);
        let ts = Date.now();
        // Real (chain, height, timestamp) but an attacker-minted reorgId string: without
        // the binding this would create a fresh round (and PREPARE fan-out) per distinct id.
        await rh.handleAlert({
            sender: VALIDATORS_4[1].addr,
            data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId: 'FORGED:' + ts,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.size, 'no round created for a non-canonical reorgId').to.equal(0);
        expect(verify.called, 'dropped before the indexer probe').to.be.false;
    });

    it('handleAlert abstains at the concurrent-round cap (REORG-INBOUND-UNBOUNDED-ROUNDS-1)', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        let verify = stubVerified(true);
        rh.maxPendingReorgs = 1;
        rh.pendingReorgs.set('BTC:1:1', { reorgId: 'BTC:1:1', timer: null });   // at cap
        let ts = Date.now();
        await rh.handleAlert({
            sender: VALIDATORS_4[1].addr,
            data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId: 'BTC:500:' + ts,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has('BTC:500:' + ts), 'no new round past the cap').to.be.false;
        expect(verify.called, 'cap checked before the indexer probe').to.be.false;
    });
}

// handlePrepare(): the non-canonical reorgId and failed-verification drops, and the
// rate budget that a failed self-verification must not consume.
function registerInboundPrepareGuardCases() {
    it('handlePrepare drops a PREPARE whose reorgId is not canonical (REORG-INBOUND-UNBOUNDED-ROUNDS-1)', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        let verify = stubVerified(true);
        let ts = Date.now();
        let reorgId = 'FORGED:' + ts;
        let digest = rh._digest(reorgId, 'LTC', 300, ts, OLD_HASH, NEW_HASH);
        await rh.handlePrepare({
            sender: VALIDATORS_4[1].addr,
            data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: ts,
                    affectedChains: ['BTC', 'DOGE'], digest, oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId), 'no round for a non-canonical reorgId').to.be.false;
        expect(verify.called, 'dropped before the indexer probe').to.be.false;
    });

    it('reportReorg does NOT consume the rate budget when self-verification fails (REORG-RATELIMIT-BEFORE-VERIFY-1)', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        let verify = sinon.stub(rh, 'verifyReorgAgainstOwnNode');
        verify.onFirstCall().resolves(false);   // local node momentarily lagging
        verify.onSecondCall().resolves(true);    // re-synced on the retry
        let ts = Date.now();

        let threw = false;
        try { await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH); }
        catch (e) { threw = true; expect(e.message).to.match(/own indexer does not confirm/); }
        expect(threw, 'the failed report throws').to.be.true;
        expect(rh.reorgRateTracker.has('BTC'), 'a failed verify does not burn the 60s budget').to.be.false;

        // The retry (node now synced) is therefore not rate-limited and broadcasts the ALERT.
        await rh.reportReorg('BTC', 500001, ts + 1, OLD_HASH, NEW_HASH);
        expect(pm.broadcast.getCalls().some(c => c.args[0] === 'REORG_ALERT'),
            'the genuine retry is not blocked by the rate limit').to.be.true;
    });

    it('handlePrepare (leader-bypass path) abstains when verification fails', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        stubVerified(false);

        let ts = Date.now();
        let reorgId = 'LTC:300:' + ts;
        let digest = rh._digest(reorgId, 'LTC', 300, ts, OLD_HASH, NEW_HASH);
        await rh.handlePrepare({
            sender: VALIDATORS_4[1].addr,
            data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: ts,
                    affectedChains: ['BTC', 'DOGE'], digest,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId)).to.be.false;
    });
}

// The wire digest is recomputed from the fields, and an unverified round never
// commits or rolls back.
function registerDigestAndUnverifiedRoundCases() {
    it('handlePrepare recomputes the digest and drops a wire digest that does not match the fields', async function () {
        rh.setValidatorSet(VALIDATORS_4);
        let verify = stubVerified(true);

        let ts = Date.now();
        let reorgId = 'LTC:300:' + ts;
        // Digest computed over a DIFFERENT newHash than the wire fields carry.
        let poisoned = rh._digest(reorgId, 'LTC', 300, ts, OLD_HASH, 'c'.repeat(64));
        await rh.handlePrepare({
            sender: VALIDATORS_4[1].addr,
            data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: ts,
                    affectedChains: ['BTC', 'DOGE'], digest: poisoned,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId)).to.be.false;
        expect(verify.called, 'digest mismatch is dropped before probing').to.be.false;
    });

    it('an unverified pending round never commits or rolls back, regardless of votes', async function () {
        rh.setValidatorSet(VALIDATORS_3);
        pm.validatorAddr = VALIDATORS_3[0].addr;

        let reorgId = 'BTC:500:123';
        let digest = rh._digest(reorgId, 'BTC', 500, 123, OLD_HASH, NEW_HASH);
        rh.pendingReorgs.set(reorgId, {
            reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
            affectedChains: ['LTC', 'DOGE'], digest, oldHash: OLD_HASH, newHash: NEW_HASH,
            selfVerified: false,
            quorum: 2,
            prepares: new Set([VALIDATORS_3[0].addr, VALIDATORS_3[1].addr]),
            commits: new Set([VALIDATORS_3[0].addr, VALIDATORS_3[1].addr]),
            finalized: false, timer: null
        });

        rh.checkPrepareQuorum(reorgId);
        expect(pm.broadcast.called, 'no COMMIT broadcast for an unverified round').to.be.false;

        rh.checkCommitQuorum(reorgId);
        // checkCommitQuorum refuses an unverified round inline, so the refusal is
        // already decided by the time it returns.
        expect(hub.db.doQuery.called, 'no rollback for an unverified round').to.be.false;
    });
}
