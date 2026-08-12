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
const { waitUntil }         = require('../helpers/waitUntil');
const { VALIDATORS_3 }      = require('../helpers/fixtures');

// R2-C2 wire format: every report/round carries the reporter's observed hash
// pair, and hubs verify against their own indexer before co-signing. These
// regressions stub the probe (its behavior has its own unit suite).
const OLD_HASH = 'a'.repeat(64);
const NEW_HASH = 'b'.repeat(64);

describe('Regression: ReorgHandler', function () {

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
    // REG-REORG-001: Reorg report validation
    // -----------------------------------------------------------------

    describe('REG-REORG-001: Reorg report validated', function () {
        it('skips already-processed reorgs @regression-p1', async function () {
            let ts = Date.now();
            rh.processed.add('BTC:500000:' + ts);
            await rh.reportReorg('BTC', 500000, ts, OLD_HASH, NEW_HASH);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('single-node processes valid reorg @regression-p1', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            sinon.stub(rh, '_verifyReorgAgainstOwnNode').resolves(true);

            await rh.reportReorg('BTC', 500000, Date.now(), OLD_HASH, NEW_HASH);
            expect(hub.db.doQuery.callCount).to.equal(3);
        });
    });

    // -----------------------------------------------------------------
    // REG-REORG-002: Rate limiting
    // -----------------------------------------------------------------

    describe('REG-REORG-002: Rate limit 1 reorg per chain per 60s', function () {
        it('affected chains computed correctly @regression-p1', function () {
            expect(rh._getAffectedChains('BTC')).to.deep.equal(['LTC', 'DOGE']);
            expect(rh._getAffectedChains('LTC')).to.deep.equal(['BTC', 'DOGE']);
            expect(rh._getAffectedChains('DOGE')).to.deep.equal(['BTC', 'LTC']);
        });
    });

    // -----------------------------------------------------------------
    // REG-REORG-003: Reorg PBFT flow
    // -----------------------------------------------------------------

    describe('REG-REORG-003: Reorg PBFT ALERT → PREPARE → COMMIT → rollback', function () {

        beforeEach(function () {
            rh.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;
        });

        it('PREPARE from peer is recorded @regression-p0', async function () {
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

            await rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                        affectedChains: ['LTC', 'DOGE'], digest,
                        oldHash: OLD_HASH, newHash: NEW_HASH }
            });

            expect(rh.pendingReorgs.get(reorgId).prepares.has(VALIDATORS_3[1].addr)).to.be.true;
        });

        it('PREPARE with wrong digest rejected @regression-p0', async function () {
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

            await rh._handlePrepare({
                sender: VALIDATORS_3[1].addr,
                data: { reorgId, chain: 'BTC', reorgHeight: 500, timestamp: ts,
                        oldHash: OLD_HASH, newHash: NEW_HASH, digest: 'wrong' }
            });

            expect(rh.pendingReorgs.get(reorgId).prepares.size).to.equal(0);
        });

        it('COMMIT quorum executes rollback @regression-p0', async function () {
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

            expect(hub.db.doQuery.callCount).to.equal(3);
            expect(rh.processed.has(reorgId)).to.be.true;
            expect(emitted).to.not.be.null;
        });
    });

    // -----------------------------------------------------------------
    // REG-REORG-004: Attestations below reorg height rolled back
    // -----------------------------------------------------------------

    describe('REG-REORG-004: Attestations rolled back below reorg height', function () {
        it('DELETE FROM attestations executed with an in-window bound @regression-p0', async function () {
            let ts = Date.now() - 60000; // within the lookback window: used as-is
            await rh._executeRollback('BTC', 500000, ts, 'reorg-1', 3, '[]');

            let deleteCall = hub.db.doQuery.getCall(0);
            expect(deleteCall.args[0]).to.include('DELETE FROM attestations');
            expect(deleteCall.args[1][0]).to.equal('BTC');
            expect(deleteCall.args[1][1]).to.equal(ts);
        });

        it('a far-past reported timestamp is clamped to the lookback floor @regression-p0', async function () {
            // The rollback bound is clamped to Date.now() - maxLookbackMs so a
            // fabricated deep "reorg" cannot grief-delete attestations further
            // back than the documented blast-radius bound.
            let before = Date.now();
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-1', 3, '[]');
            let after = Date.now();

            let bound = hub.db.doQuery.getCall(0).args[1][1];
            expect(bound).to.be.at.least(before - rh.maxLookbackMs);
            expect(bound).to.be.at.most(after - rh.maxLookbackMs);
        });
    });

    // -----------------------------------------------------------------
    // REG-REORG-005: Price snapshots rolled back
    // -----------------------------------------------------------------

    describe('REG-REORG-005: Price snapshots marked disputed', function () {
        it('UPDATE price_snapshots status to disputed @regression-p0', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-1', 3, '[]');

            let updateCall = hub.db.doQuery.getCall(1);
            expect(updateCall.args[0]).to.include("status = 'disputed'");
        });
    });

    // -----------------------------------------------------------------
    // REG-REORG-006: Reorg attestation stored
    // -----------------------------------------------------------------

    describe('REG-REORG-006: Reorg stored in reorg_attestations', function () {
        it('INSERT into reorg_attestations @regression-p2', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-1', 3, '["v1","v2","v3"]');

            let insertCall = hub.db.doQuery.getCall(2);
            expect(insertCall.args[0]).to.include('reorg_attestations');
            expect(insertCall.args[1]).to.include('reorg-1');
            expect(insertCall.args[1]).to.include(3);
        });

        it('reorgId added to processed set @regression-p2', async function () {
            await rh._executeRollback('BTC', 500000, 1700000000000, 'reorg-x', 1, '[]');
            expect(rh.processed.has('reorg-x')).to.be.true;
        });
    });

    // Digest determinism
    describe('Reorg digest determinism', function () {
        it('deterministic for same inputs @regression-p0', function () {
            let a = rh._digest('id', 'BTC', 100, 999, OLD_HASH, NEW_HASH);
            let b = rh._digest('id', 'BTC', 100, 999, OLD_HASH, NEW_HASH);
            expect(a).to.equal(b);
            expect(a).to.match(/^[0-9a-f]{64}$/);
        });
    });

    // Single-node fallback
    describe('Single-node reorg', function () {
        it('single-node emits reorg:confirmed event @regression-p1', async function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            sinon.stub(rh, '_verifyReorgAgainstOwnNode').resolves(true);

            let emitted = null;
            rh.on('reorg:confirmed', (d) => { emitted = d; });

            await rh.reportReorg('LTC', 300000, Date.now(), OLD_HASH, NEW_HASH);

            expect(emitted).to.not.be.null;
            expect(emitted.sourceChain).to.equal('LTC');
            expect(emitted.reorgHeight).to.equal(300000);
        });
    });

    // Query methods
    describe('getReorgHistory()', function () {
        it('queries with limit @regression-p2', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory(10);
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([10]);
        });

        it('defaults to 50 @regression-p2', async function () {
            hub.db.doQuery.resolves([]);
            await rh.getReorgHistory();
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal([50]);
        });
    });
});
