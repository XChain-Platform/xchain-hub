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
const crypto         = require('crypto');
const testDb         = require('../../helpers/testDb');
const { buildEnvelope } = require('../../helpers/testPeerNetwork');
const { waitUntil }     = require('../../helpers/waitUntil');
const { VALIDATORS_1, VALIDATORS_4 } = require('../../helpers/fixtures');
const CrossChainEngine = require('../../../src/CrossChainEngine');
const SwapTracker      = require('../../../src/SwapTracker');
const coins            = require('../../../src/coins');
const { createIntegrationHub: createTestHub, createCapabilitySnapshotStub } = require('../../helpers/integrationHub');

// Canonical per-chain cross-chain confirmation depths, from the same source the
// engine resolves them from.
const CONFIRMATIONS = coins.resolveConfirmations({}, 'mainnet');

describe('Integration: Cross-Chain Attestation (SC-4.x)', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable: skipping attestation tests');
        }
    });

    after(async function () { await testDb.teardown(); });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });

    // SC-4.1: Single-node attestation (quorum=0)
    describe('SC-4.1: Single-node attestation', function () {
        it('stores attestation directly without consensus', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let engine = new CrossChainEngine(hub);
            engine.setValidatorSet(VALIDATORS_1);
            await engine.start();

            let attestation = await engine.requestAttestation('BTC', 42, 'LTC');

            expect(attestation).to.exist;
            expect(attestation.attestationId).to.equal('BTC:42:LTC');
            expect(attestation.status).to.equal('attested');
            // Read the threshold from the canonical coin bundles instead of pinning a
            // literal. The BTC/LTC/DOGE cross-chain confirmation depths were raised
            // ( mainnet floor clamp) and this assertion still demanded the old
            // 3, which read as a product regression rather than a stale fixture.
            expect(attestation.confirmations).to.equal(CONFIRMATIONS.BTC);
            expect(attestation.validatorCount).to.equal(1);

            // Verify in DB
            let rows = await db.doQuery("SELECT * FROM attestations WHERE attestation_id = 'BTC:42:LTC'");
            expect(rows).to.have.lengthOf(1);
            expect(rows[0].source_chain).to.equal('BTC');
            expect(rows[0].source_action_index).to.equal(42);
            expect(rows[0].dest_chain).to.equal('LTC');

            await engine.stop();
        });

        it('uses correct confirmation threshold per chain', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db);

            let engine = new CrossChainEngine(hub);
            engine.setValidatorSet(VALIDATORS_1);
            await engine.start();

            let dogeAtt = await engine.requestAttestation('DOGE', 1, 'BTC');
            expect(dogeAtt.confirmations).to.equal(CONFIRMATIONS.DOGE);

            let ltcAtt = await engine.requestAttestation('LTC', 1, 'BTC');
            expect(ltcAtt.confirmations).to.equal(CONFIRMATIONS.LTC);

            // The per-chain depths must still differ from one another, or the
            // canonical-source assertions above would pass against a flat table.
            expect(CONFIRMATIONS.DOGE).to.not.equal(CONFIRMATIONS.BTC);

            await engine.stop();
        });
    });

    // SC-4.2: Attestation triggers SWAP progression
    describe('SC-4.2: Attestation to SWAP progression', function () {
        it('auto-progresses swap from initiated to attested', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let engine = new CrossChainEngine(hub);
            engine.setValidatorSet(VALIDATORS_1);

            let swapTracker = new SwapTracker(hub);
            swapTracker.start(engine);

            // Create a swap record
            await swapTracker.initiateSwap('BTC', 42, 'LTC', null);

            // Verify initial status
            let swap = await swapTracker.getSwap('BTC', 42);
            expect(swap.status).to.equal('initiated');

            await engine.start();

            // Request attestation (single-node, completes immediately)
            await engine.requestAttestation('BTC', 42, 'LTC');

            // Wait for the finalized attestation to drive the swap forward.
            await waitUntil(async () => {
                let s = await swapTracker.getSwap('BTC', 42);
                return s && s.status === 'attested';
            }, { timeoutMs: 5000, label: 'the swap record to reach attested' });

            // Verify swap progressed
            let updated = await swapTracker.getSwap('BTC', 42);
            expect(updated.status).to.equal('attested');
            expect(updated.attestation_id).to.equal('BTC:42:LTC');

            swapTracker.stop(engine);
            await engine.stop();
        });

        it('does not create duplicate swap records', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let engine = new CrossChainEngine(hub);
            engine.setValidatorSet(VALIDATORS_1);

            let swapTracker = new SwapTracker(hub);
            swapTracker.start(engine);

            await swapTracker.initiateSwap('BTC', 99, 'LTC', null);

            await engine.start();
            await engine.requestAttestation('BTC', 99, 'LTC');
            await waitUntil(async () => {
                let s = await swapTracker.getSwap('BTC', 99);
                return s && s.status === 'attested';
            }, { timeoutMs: 5000, label: 'the swap record to reach attested' });

            // Should only have one swap record
            let rows = await db.doQuery("SELECT * FROM swap_records WHERE source_chain = 'BTC' AND source_action_index = 99");
            expect(rows).to.have.lengthOf(1);

            swapTracker.stop(engine);
            await engine.stop();
        });
    });

    // SC-4.3: Multi-validator attestation with PBFT
    describe('SC-4.3: Multi-validator attestation', function () {
        it('finalizes attestation after PREPARE and COMMIT quorum', async function () {
            let db = testDb.getDb();
            // This node must BE the leader the engine elects, or requestAttestation
            // refuses. The rotation is set[seq % N] and the first request runs at
            // seq 1, so the leader is index 1, not index 0.
            let leaderIdx = 1 % VALIDATORS_4.length;
            let peerIdxs  = VALIDATORS_4.map((_, i) => i).filter(i => i !== leaderIdx).slice(0, 2);
            // CrossChainEngine._resolveQuorum fails CLOSED for a federated hub with no
            // deterministic cross_chain snapshot, so a validator set alone is not
            // enough fixture: it needs a snapshot at a real block height too.
            let hub = createTestHub(db, VALIDATORS_4[leaderIdx].addr, {
                btcLatestBlock:      800000,
                capabilitySnapshot:  createCapabilitySnapshotStub(VALIDATORS_4)
            });

            let engine = new CrossChainEngine(hub);
            engine.setValidatorSet(VALIDATORS_4);
            await engine.start();

            // Track finalization
            let finalizedAtt = null;
            engine.on('attestation:finalized', (a) => { finalizedAtt = a; });

            // Request attestation: leader broadcasts PROPOSE
            let attestPromise = engine.requestAttestation('BTC', 42, 'LTC');

            await waitUntil(() => engine.pendingAttestations.has('BTC:42:LTC'), { label: 'the leader PROPOSE round to open' });

            // Get the pending attestation
            let attestationId = 'BTC:42:LTC';
            let pending = engine.pendingAttestations.get(attestationId);
            expect(pending).to.exist;

            // Inject PREPARE from the two non-leader validators (quorum 3 of N=4)
            for (let i of peerIdxs) {
                hub._peerManager.emit('message', buildEnvelope('XCHAIN_ATTEST_PREPARE', {
                    attestationId: attestationId,
                    digest: pending.digest
                }, VALIDATORS_4[i].addr));
            }

            await waitUntil(() => pending.prepares.size >= 3, { label: 'the PREPARE quorum to be tallied' });

            // Inject COMMIT from the same two
            for (let i of peerIdxs) {
                hub._peerManager.emit('message', buildEnvelope('XCHAIN_ATTEST_COMMIT', {
                    attestationId: attestationId,
                    digest: pending.digest
                }, VALIDATORS_4[i].addr));
            }

            let result = await attestPromise;

            expect(result.status).to.equal('attested');
            expect(result.validatorCount).to.be.greaterThanOrEqual(3);
            expect(finalizedAtt).to.not.be.null;

            // Verify in DB
            let rows = await db.doQuery("SELECT * FROM attestations WHERE attestation_id = ?", [attestationId]);
            expect(rows).to.have.lengthOf(1);
            expect(rows[0].status).to.equal('attested');

            await engine.stop();
        });
    });

    // SC-4.4: Concurrent attestations for different chain pairs
    describe('SC-4.4: Concurrent attestations', function () {
        it('handles two independent attestations simultaneously', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);

            let engine = new CrossChainEngine(hub);
            engine.setValidatorSet(VALIDATORS_1);
            await engine.start();

            // Request two attestations concurrently
            let [att1, att2] = await Promise.all([
                engine.requestAttestation('BTC', 1, 'LTC'),
                engine.requestAttestation('BTC', 2, 'DOGE')
            ]);

            expect(att1.attestationId).to.equal('BTC:1:LTC');
            expect(att2.attestationId).to.equal('BTC:2:DOGE');

            // Verify both in DB
            let rows = await db.doQuery("SELECT * FROM attestations ORDER BY attestation_id");
            expect(rows).to.have.lengthOf(2);

            await engine.stop();
        });
    });
});
