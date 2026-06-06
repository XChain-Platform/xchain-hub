'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon              = require('sinon');
const { expect }         = require('chai');
const EventEmitter       = require('events');
const CrossChainEngine   = require('../../src/CrossChainEngine');
const SwapTracker        = require('../../src/SwapTracker');
const { createMockHub }  = require('../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, makeValidator } = require('../helpers/fixtures');

describe('Regression: CrossChain & SwapTracker', function () {

    // =================================================================
    // CrossChainEngine
    // =================================================================

    describe('CrossChainEngine', function () {

        let hub, pm, engine;

        beforeEach(function () {
            hub    = createMockHub();
            pm     = hub._peerManager;
            engine = new CrossChainEngine(hub);
        });

        afterEach(function () {
            for (let [, pending] of engine.pendingAttestations) {
                if (pending.timer) clearTimeout(pending.timer);
            }
            sinon.restore();
        });

        // REG-XCH-001
        describe('REG-XCH-001: Attestation ID format', function () {
            it('attestation ID is {sourceChain}:{sourceActionIndex}:{destChain} @regression-p1', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let result = await engine.requestAttestation('BTC', 42, 'LTC');
                expect(result.attestationId).to.equal('BTC:42:LTC');
            });
        });

        // REG-XCH-002
        describe('REG-XCH-002: Attestation PBFT flow', function () {

            beforeEach(function () {
                engine.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });

            it('PROPOSE creates pending and broadcasts PREPARE @regression-p0', async function () {
                let attestationId = 'BTC:1:LTC';
                let digest = engine._digest(attestationId, 3);

                await engine._handlePropose({
                    sender: VALIDATORS_4[1].addr,
                    data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                            destChain: 'LTC', confirmations: 3, digest }
                });

                expect(engine.pendingAttestations.has(attestationId)).to.be.true;
                expect(pm.broadcast.calledOnce).to.be.true;
                expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_PREPARE');

                let pending = engine.pendingAttestations.get(attestationId);
                if (pending.timer) clearTimeout(pending.timer);
            });

            it('PREPARE quorum triggers COMMIT @regression-p0', function () {
                let attestationId = 'BTC:1:LTC';
                let digest = engine._digest(attestationId, 3);

                engine.pendingAttestations.set(attestationId, {
                    attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                    destChain: 'LTC', confirmations: 3, digest,
                    prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                    commits: new Set(), finalized: false, timer: null,
                    resolve: null, reject: null
                });

                engine._handlePrepare({
                    sender: VALIDATORS_4[2].addr,
                    data: { attestationId, digest }
                });

                expect(pm.broadcast.called).to.be.true;
                expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
            });

            it('COMMIT quorum stores attestation and emits event @regression-p0', async function () {
                let attestationId = 'BTC:1:LTC';
                let digest = engine._digest(attestationId, 3);

                let emitted = null;
                engine.on('attestation:finalized', (a) => { emitted = a; });

                let resolvedValue = null;
                engine.pendingAttestations.set(attestationId, {
                    attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                    destChain: 'LTC', confirmations: 3, digest,
                    prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                    commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                    finalized: false, timer: null, _commitSent: true,
                    resolve: (v) => { resolvedValue = v; },
                    reject: () => {}
                });

                engine._handleCommit({
                    sender: VALIDATORS_4[2].addr,
                    data: { attestationId, digest }
                });

                await new Promise(r => setTimeout(r, 20));

                expect(hub.db.doQuery.called).to.be.true;
                expect(emitted).to.not.be.null;
                expect(emitted.attestationId).to.equal(attestationId);
                expect(emitted.status).to.equal('attested');
                expect(engine.finalized.has(attestationId)).to.be.true;
            });

            it('PROPOSE with wrong digest rejected @regression-p0', function () {
                engine._handlePropose({
                    sender: VALIDATORS_4[1].addr,
                    data: { attestationId: 'BTC:1:LTC', digest: 'wrong', confirmations: 3 }
                });
                expect(engine.pendingAttestations.size).to.equal(0);
            });

            it('already-finalized attestation ignored @regression-p0', function () {
                engine.finalized.add('BTC:1:LTC');
                engine._handlePropose({
                    sender: VALIDATORS_4[1].addr,
                    data: { attestationId: 'BTC:1:LTC', digest: 'x', confirmations: 3 }
                });
                expect(engine.pendingAttestations.size).to.equal(0);
            });
        });

        // REG-XCH-003
        describe('REG-XCH-003: Confirmation thresholds per chain', function () {
            it('BTC=3, LTC=3, DOGE=6 @regression-p0', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let btc = await engine.requestAttestation('BTC', 1, 'LTC');
                expect(btc.confirmations).to.equal(3);

                let ltc = await engine.requestAttestation('LTC', 1, 'BTC');
                expect(ltc.confirmations).to.equal(3);

                let doge = await engine.requestAttestation('DOGE', 1, 'BTC');
                expect(doge.confirmations).to.equal(6);
            });
        });

        // REG-XCH-004
        describe('REG-XCH-004: Per-chain-pair validator filtering', function () {
            it('uses chain-pair-specific validators when available @regression-p1', function () {
                let pairValidators = [makeValidator(1), makeValidator(2)];
                engine.chainPairValidators = new Map([['BTC-LTC', pairValidators]]);
                engine.setValidatorSet(VALIDATORS_7);

                let set = engine._getChainPairSet('BTC', 'LTC');
                expect(set).to.equal(pairValidators);
            });

            it('checks reverse key ordering @regression-p1', function () {
                let pairValidators = [makeValidator(1)];
                engine.chainPairValidators = new Map([['LTC-BTC', pairValidators]]);

                let set = engine._getChainPairSet('BTC', 'LTC');
                expect(set).to.equal(pairValidators);
            });

            it('falls back to full set when no chain-pair set @regression-p1', function () {
                engine.setValidatorSet(VALIDATORS_3);
                engine.chainPairValidators = new Map();

                let set = engine._getChainPairSet('BTC', 'DOGE');
                expect(set).to.equal(VALIDATORS_3);
            });
        });

        // REG-XCH-005
        describe('REG-XCH-005: Attestation status transitions', function () {
            it('single-node stores as attested @regression-p0', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let result = await engine.requestAttestation('BTC', 42, 'LTC');
                expect(result.status).to.equal('attested');
            });
        });

        // REG-XCH-006
        describe('REG-XCH-006: attestation:finalized event emitted on PBFT consensus', function () {
            it('COMMIT quorum emits attestation:finalized with correct data @regression-p1', async function () {
                engine.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;

                let attestationId = 'LTC:10:DOGE';
                let digest = engine._digest(attestationId, 3);

                let emitted = null;
                engine.on('attestation:finalized', (a) => { emitted = a; });

                engine.pendingAttestations.set(attestationId, {
                    attestationId, sourceChain: 'LTC', sourceActionIndex: 10,
                    destChain: 'DOGE', confirmations: 3, digest,
                    prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                    commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                    finalized: false, timer: null, _commitSent: true,
                    resolve: () => {}, reject: () => {}
                });

                engine._handleCommit({
                    sender: VALIDATORS_4[2].addr,
                    data: { attestationId, digest }
                });

                await new Promise(r => setTimeout(r, 20));

                expect(emitted).to.not.be.null;
                expect(emitted.attestationId).to.equal('LTC:10:DOGE');
                expect(emitted.status).to.equal('attested');
            });
        });

        // REG-XCH-009
        describe('REG-XCH-009: Query methods', function () {
            it('getAttestations filters by status @regression-p2', async function () {
                hub.db.doQuery.resolves([]);
                await engine.getAttestations('attested', 10);
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[0]).to.include("status = ?");
                expect(args[1]).to.include('attested');
            });

            it('getAttestation returns null when not found @regression-p2', async function () {
                hub.db.doQuery.resolves([]);
                let result = await engine.getAttestation('BTC', 999);
                expect(result).to.be.null;
            });
        });

        // REG-XCH-010
        describe('REG-XCH-010: Single-node cross-chain attestation', function () {
            it('applies directly without consensus @regression-p1', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let result = await engine.requestAttestation('BTC', 1, 'LTC');
                expect(result.attestationId).to.equal('BTC:1:LTC');
                expect(result.status).to.equal('attested');
                expect(hub.db.doQuery.called).to.be.true;
                expect(pm.broadcast.called).to.be.false;
            });
        });

        // Digest determinism
        describe('CrossChain digest determinism', function () {
            it('deterministic for same inputs @regression-p0', function () {
                expect(engine._digest('X', 3)).to.equal(engine._digest('X', 3));
            });

            it('different inputs → different digest @regression-p0', function () {
                expect(engine._digest('X', 3)).to.not.equal(engine._digest('Y', 3));
            });
        });
    });

    // =================================================================
    // SwapTracker
    // =================================================================

    describe('SwapTracker', function () {

        let hub, st, crossChainEngine;

        beforeEach(function () {
            hub = createMockHub();
            st  = new SwapTracker(hub);
            crossChainEngine = new EventEmitter();
        });

        afterEach(function () {
            st.stop(crossChainEngine);
            sinon.restore();
        });

        // REG-XCH-007
        describe('REG-XCH-007: SwapTracker auto-progresses on attestation', function () {
            it('attestation:finalized updates initiated swap to attested @regression-p0', async function () {
                hub.db.doQuery.onFirstCall().resolves([{
                    source_chain: 'BTC', source_action_index: 42, status: 'initiated'
                }]);
                hub.db.doQuery.onSecondCall().resolves();

                await st._onAttestationFinalized({
                    sourceChain: 'BTC',
                    sourceActionIndex: 42,
                    attestationId: 'BTC:42:LTC'
                });

                expect(hub.db.doQuery.callCount).to.equal(2);
                let updateArgs = hub.db.doQuery.getCall(1).args;
                expect(updateArgs[0]).to.include("status = ?");
                expect(updateArgs[1][0]).to.equal('attested');
            });

            it('does nothing when no matching swap @regression-p0', async function () {
                hub.db.doQuery.resolves([]);
                await st._onAttestationFinalized({ sourceChain: 'BTC', sourceActionIndex: 42 });
                expect(hub.db.doQuery.callCount).to.equal(1);
            });

            it('does nothing when swap already attested @regression-p0', async function () {
                hub.db.doQuery.resolves([{
                    source_chain: 'BTC', source_action_index: 42, status: 'attested'
                }]);
                await st._onAttestationFinalized({ sourceChain: 'BTC', sourceActionIndex: 42 });
                expect(hub.db.doQuery.callCount).to.equal(1);
            });
        });

        // REG-XCH-008
        describe('REG-XCH-008: Swap lifecycle', function () {
            it('initiateSwap inserts record @regression-p1', async function () {
                await st.initiateSwap('BTC', 42, 'LTC', 100);
                expect(hub.db.doQuery.calledOnce).to.be.true;
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[0]).to.include('swap_records');
                expect(args[0]).to.include("'initiated'");
            });

            it('getSwap returns record @regression-p1', async function () {
                hub.db.doQuery.resolves([{ source_chain: 'BTC', status: 'initiated' }]);
                let result = await st.getSwap('BTC', 42);
                expect(result.source_chain).to.equal('BTC');
            });

            it('getSwap returns null when not found @regression-p1', async function () {
                hub.db.doQuery.resolves([]);
                let result = await st.getSwap('BTC', 999);
                expect(result).to.be.null;
            });
        });

        // Event-driven integration
        describe('Event-driven auto-progress', function () {
            it('attestation:finalized event triggers swap update @regression-p1', async function () {
                st.start(crossChainEngine);

                hub.db.doQuery.onFirstCall().resolves([{
                    source_chain: 'BTC', source_action_index: 1, status: 'initiated'
                }]);
                hub.db.doQuery.onSecondCall().resolves();

                crossChainEngine.emit('attestation:finalized', {
                    sourceChain: 'BTC', sourceActionIndex: 1, attestationId: 'BTC:1:LTC'
                });

                await new Promise(r => setTimeout(r, 20));
                expect(hub.db.doQuery.callCount).to.equal(2);
            });
        });

        // Null safety
        describe('Null safety', function () {
            it('handles null attestation gracefully @regression-p2', async function () {
                await st._onAttestationFinalized(null);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('handles missing fields gracefully @regression-p2', async function () {
                await st._onAttestationFinalized({ sourceChain: null, sourceActionIndex: null });
                expect(hub.db.doQuery.called).to.be.false;
            });
        });
    });
});
