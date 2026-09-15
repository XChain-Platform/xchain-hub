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
// ReorgHandler: the PBFT reorg round (PREPARE recording, the out-of-window
// refusals, digest rejection and the COMMIT quorum rollback) and the reorg:timeout
// event a round emits when quorum never arrives.

const sinon          = require('sinon');
const { expect }     = require('chai');
const ReorgHandler   = require('../../src/anchor/reorg_handler');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4 } = require('../helpers/fixtures');
const { waitUntil }  = require('../helpers/waitUntil');

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

    registerPbftFlow();
    registerConsensusTimeout();
});

// -----------------------------------------------------------------
// PBFT reorg flow
// -----------------------------------------------------------------

function registerPbftFlow() {
    describe('PBFT reorg flow', function () {

        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
        });

        registerPreparePathCases();
        registerCommitPathCases();
    });
}

// A peer PREPARE is recorded, and stale timestamps are refused on both the ALERT
// and the PREPARE path.
function registerPreparePathCases() {
    it('PREPARE from peer is recorded', async function () {
        let ts = Date.now();
        let reorgId = 'BTC:500:' + ts;
        let digest = rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH);

        rh.pendingReorgs.set(reorgId, {
            reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
            affectedChains: ['LTC', 'DOGE'], digest,
            oldHash: OLD_HASH, newHash: NEW_HASH, selfVerified: true,
            prepares: new Set(), commits: new Set(),
            finalized: false, timer: null
        });

        await rh.handlePrepare({
            sender: VALIDATORS_3[1].addr,
            data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                    affectedChains: ['LTC', 'DOGE'], digest,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });

        expect(rh.pendingReorgs.get(reorgId).prepares.has(VALIDATORS_3[1].addr)).to.be.true;
    });

    it('handleAlert refuses an out-of-window (old) timestamp and starts no consensus', async function () {
        let ts = 1700000000000; // ~2023, far outside the 24h blast-radius window
        let reorgId = 'BTC:500:' + ts;
        await rh.handleAlert({
            sender: VALIDATORS_3[1].addr,
            data: { chain: 'BTC', reorgHeight: 500, timestamp: ts, reorgId,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId), 'no pending round for a stale reorg').to.be.false;
        expect(pm.broadcast.called, 'no PREPARE broadcast for a stale reorg').to.be.false;
    });

    it('handlePrepare refuses to co-sign an out-of-window (old) timestamp', async function () {
        let ts = 1700000000000;
        let reorgId = 'BTC:500:' + ts;
        await rh.handlePrepare({
            sender: VALIDATORS_3[1].addr,
            data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                    affectedChains: ['LTC', 'DOGE'],
                    digest: rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH),
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId), 'a follower does not create a round for a stale reorg').to.be.false;
    });
}

// A wrong digest is rejected, and COMMIT quorum executes the rollback.
function registerCommitPathCases() {
    it('PREPARE with wrong digest is rejected', async function () {
        let ts = Date.now();
        let reorgId = 'BTC:500:' + ts;
        let digest = rh._digest(reorgId, 'BTC', 500, ts, OLD_HASH, NEW_HASH);

        rh.pendingReorgs.set(reorgId, {
            reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
            affectedChains: ['LTC', 'DOGE'], digest,
            oldHash: OLD_HASH, newHash: NEW_HASH, selfVerified: true,
            prepares: new Set(), commits: new Set(),
            finalized: false, timer: null
        });

        await rh.handlePrepare({
            sender: VALIDATORS_3[1].addr,
            data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                    oldHash: OLD_HASH, newHash: NEW_HASH, digest: 'wrong' }
        });

        expect(rh.pendingReorgs.get(reorgId).prepares.size).to.equal(0);
    });

    it('COMMIT quorum executes rollback', async function () {
        let reorgId = 'BTC:500:123';
        let digest = rh._digest(reorgId, 'BTC', 500, 123, OLD_HASH, NEW_HASH);

        rh.pendingReorgs.set(reorgId, {
            reorgId, chain: 'BTC', reorgHeight: 500, timestamp: 123,
            affectedChains: ['LTC', 'DOGE'], digest,
            oldHash: OLD_HASH, newHash: NEW_HASH, selfVerified: true,
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

        await waitUntil(() => rh.processed.has(reorgId), { label: 'the commit quorum to execute the rollback' });

        expect(hub.db.doQuery.callCount).to.equal(3); // delete + update + insert
        expect(rh.processed.has(reorgId)).to.be.true;
        expect(emitted).to.not.be.null;
    });
}

// The fake clock a timeout case installs; the describe's afterEach restores it.
let clock;

// -----------------------------------------------------------------
// Consensus timeout: surfaced event (not silent discard)
//
// When a reorg round can't reach quorum within the window, the pending
// rollback was once dropped with only a console.warn, leaving cross-chain
// state dirty after a reorg with no programmatic signal. The handler now
// emits a 'reorg:timeout' event carrying the discarded rollback details
// before deleting it, so operators/consumers can alert or retry.
// -----------------------------------------------------------------

function registerConsensusTimeout() {
    describe('consensus timeout event', function () {

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
        });

        registerLeaderTimeoutCase();
        registerFollowerTimeoutCase();
    });
}

// The leader round: quorum never arrives, the timer fires the event.
function registerLeaderTimeoutCase() {
    it('emits reorg:timeout instead of silently discarding when quorum is not reached', async function () {
        clock = sinon.useFakeTimers({ now: 1700000000000 });
        // N=4 → quorum=3, so a lone self-prepare can't finalize and the round
        // must time out (N=3 would finalize immediately at quorum=1).
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        stubVerified(true);

        let emitted = null;
        rh.on('reorg:timeout', (d) => { emitted = d; });

        await rh.reportReorg('BTC', 500000, 1700000000000, OLD_HASH, NEW_HASH);
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
}

// The follower round created by a peer PREPARE times out on the longer timer.
function registerFollowerTimeoutCase() {
    it('emits reorg:timeout for a follower-created round (PREPARE path) that never reaches quorum', async function () {
        clock = sinon.useFakeTimers({ now: 1700000000000 });
        rh.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
        stubVerified(true);

        let reorgId = 'LTC:300:1700000000000';
        let digest = rh._digest(reorgId, 'LTC', 300, 1700000000000, OLD_HASH, NEW_HASH);

        let emitted = null;
        rh.on('reorg:timeout', (d) => { emitted = d; });

        // A peer's PREPARE creates the pending round locally.
        await rh.handlePrepare({
            sender: VALIDATORS_4[1].addr,
            data: { reorgId, chain: 'LTC', reorgHeight: 300, timestamp: 1700000000000,
                    affectedChains: ['BTC', 'DOGE'], digest,
                    oldHash: OLD_HASH, newHash: NEW_HASH }
        });
        expect(rh.pendingReorgs.has(reorgId)).to.be.true;

        // Follower timer is timeout*2; quorum (3) unreachable → event fires.
        clock.tick(rh.timeout * 2 + 1);

        expect(emitted).to.not.be.null;
        expect(emitted.reorgId).to.equal(reorgId);
        expect(emitted.sourceChain).to.equal('LTC');
        expect(rh.pendingReorgs.has(reorgId)).to.be.false;
    });
}
