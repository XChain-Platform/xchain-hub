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

const sinon              = require('sinon');
const { expect }         = require('chai');
const CrossChainEngine   = require('../../src/cross_chain/engine');
const { createMockHub }  = require('../helpers/mockHub');
const { waitUntil }      = require('../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, makeValidator } = require('../helpers/fixtures');

// =================================================================
// CrossChainEngine
// =================================================================

function registerSuitePart1() {
    describe('CrossChainEngine', function () {
    registerNestedSuite1Part1();
    registerNestedSuite1Part2();
    registerNestedSuite1Part3();
    registerNestedSuite1Part4();
    registerNestedSuite1Part5();
    registerNestedSuite1Part6();
    registerNestedSuite1Part7();
    registerNestedSuite1Part8();
    registerNestedSuite1Part9();
    registerNestedSuite1Part10();
    registerNestedSuite1Part11();

    });
}

          function registerNestedSuite2Part1() {
    beforeEach(function () {
                engine.setValidatorSet(VALIDATORS_4);
                pm.validatorAddr = VALIDATORS_4[0].addr;
            });
}
          function registerNestedSuite2Part2() {
    it('PROPOSE creates pending and broadcasts PREPARE @regression-p0', async function () {
                let attestationId = 'BTC:1:LTC';
                let digest = engine._digest(attestationId, 3);

                // A follower now refuses to PREPARE unless the source action
                // verifies against its own local indexer AND a deterministic
                // block-boundary cross_chain snapshot resolves (federation-split
                // guard). Both guards have their own coverage (unit/
                // CrossChainEngine, security suite); satisfy them so this test
                // stays about the PBFT flow.
                sinon.stub(engine, 'verifySourceAction').resolves(true);
                hub.capabilitySnapshot = {
                    getSnapshot: async () => ({ validators: VALIDATORS_4.slice() }),
                    getQuorum:   () => 3
                };

                // btcBlockHeight is the leader-stamped snapshot block; without
                // it the follower resolves no snapshot and fails closed.
                await engine._handlePropose({
                    sender: VALIDATORS_4[1].addr,
                    sig_pubkey: VALIDATORS_4[1].pubkey,
                    data: { attestationId, sourceChain: 'BTC', sourceActionIndex: 1,
                            destChain: 'LTC', confirmations: 3, digest, btcBlockHeight: 900000 }
                });

                expect(engine.pendingAttestations.has(attestationId)).to.be.true;
                expect(pm.broadcast.calledOnce).to.be.true;
                expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_PREPARE');

                let pending = engine.pendingAttestations.get(attestationId);
                if (pending.timer) clearTimeout(pending.timer);
            });
}
          function registerNestedSuite2Part3() {
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

                engine.handlePrepare({
                    sender: VALIDATORS_4[2].addr,
                    sig_pubkey: VALIDATORS_4[2].pubkey,
                    data: { attestationId, digest }
                });

                expect(pm.broadcast.called).to.be.true;
                expect(pm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
            });
}
          function registerNestedSuite2Part4() {
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
                    sig_pubkey: VALIDATORS_4[2].pubkey,
                    data: { attestationId, digest }
                });

                await waitUntil(() => engine.finalized.has(attestationId), { label: 'the commit quorum to finalize the attestation' });

                expect(hub.db.doQuery.called).to.be.true;
                expect(emitted).to.not.be.null;
                expect(emitted.attestationId).to.equal(attestationId);
                expect(emitted.status).to.equal('attested');
                expect(engine.finalized.has(attestationId)).to.be.true;
            });
}
          function registerNestedSuite2Part5() {
    it('PROPOSE with wrong digest rejected @regression-p0', function () {
                engine._handlePropose({
                    sender: VALIDATORS_4[1].addr,
                    sig_pubkey: VALIDATORS_4[1].pubkey,
                    data: { attestationId: 'BTC:1:LTC', digest: 'wrong', confirmations: 3 }
                });
                expect(engine.pendingAttestations.size).to.equal(0);
            });
}
          function registerNestedSuite2Part6() {
    it('already-finalized attestation ignored @regression-p0', function () {
                engine.finalized.add('BTC:1:LTC');
                engine._handlePropose({
                    sender: VALIDATORS_4[1].addr,
                    sig_pubkey: VALIDATORS_4[1].pubkey,
                    data: { attestationId: 'BTC:1:LTC', digest: 'x', confirmations: 3 }
                });
                expect(engine.pendingAttestations.size).to.equal(0);
            });
}

describe('Regression: CrossChain & SwapTracker', function () {
    registerSuitePart1();

});
      let hub, pm, engine;
      function registerNestedSuite1Part1() {
    beforeEach(function () {
            hub    = createMockHub();
            pm     = hub._peerManager;
            engine = new CrossChainEngine(hub);
        });
}
      function registerNestedSuite1Part2() {
    afterEach(function () {
            for (let [, pending] of engine.pendingAttestations) {
                if (pending.timer) clearTimeout(pending.timer);
            }
            sinon.restore();
        });
}
      // REG-XCH-001
    function registerNestedSuite1Part3() {
    describe('REG-XCH-001: Attestation ID format', function () {
            it('attestation ID is {sourceChain}:{sourceActionIndex}:{destChain} @regression-p1', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let result = await engine.requestAttestation('BTC', 42, 'LTC');
                expect(result.attestationId).to.equal('BTC:42:LTC');
            });
        });
}
      // REG-XCH-002
    function registerNestedSuite1Part4() {
    describe('REG-XCH-002: Attestation PBFT flow', function () {
    registerNestedSuite2Part1();
    registerNestedSuite2Part2();
    registerNestedSuite2Part3();
    registerNestedSuite2Part4();
    registerNestedSuite2Part5();
    registerNestedSuite2Part6();

        });
}
      // REG-XCH-003
    function registerNestedSuite1Part5() {
    describe('REG-XCH-003: Confirmation thresholds per chain', function () {
            // Defaults come from the canonical coin registry (src/coins/<TICK>.js
            // `confirmations`): BTC=6, LTC=12, DOGE=60.
            it('BTC=6, LTC=12, DOGE=60 @regression-p0', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let btc = await engine.requestAttestation('BTC', 1, 'LTC');
                expect(btc.confirmations).to.equal(6);

                let ltc = await engine.requestAttestation('LTC', 1, 'BTC');
                expect(ltc.confirmations).to.equal(12);

                let doge = await engine.requestAttestation('DOGE', 1, 'BTC');
                expect(doge.confirmations).to.equal(60);
            });
        });
}
      // REG-XCH-004
    function registerNestedSuite1Part6() {
    describe('REG-XCH-004: Per-chain-pair validator filtering', function () {
            it('uses chain-pair-specific validators when available @regression-p1', function () {
                let pairValidators = [makeValidator(1), makeValidator(2)];
                engine.chainPairValidators = new Map([['BTC-LTC', pairValidators]]);
                engine.setValidatorSet(VALIDATORS_7);

                let set = engine.getChainPairSet('BTC', 'LTC');
                expect(set).to.equal(pairValidators);
            });

            it('checks reverse key ordering @regression-p1', function () {
                let pairValidators = [makeValidator(1)];
                engine.chainPairValidators = new Map([['LTC-BTC', pairValidators]]);

                let set = engine.getChainPairSet('BTC', 'LTC');
                expect(set).to.equal(pairValidators);
            });

            it('falls back to full set when no chain-pair set @regression-p1', function () {
                engine.setValidatorSet(VALIDATORS_3);
                engine.chainPairValidators = new Map();

                let set = engine.getChainPairSet('BTC', 'DOGE');
                expect(set).to.equal(VALIDATORS_3);
            });
        });
}
      // REG-XCH-005
    function registerNestedSuite1Part7() {
    describe('REG-XCH-005: Attestation status transitions', function () {
            it('single-node stores as attested @regression-p0', async function () {
                engine.setValidatorSet([]);
                pm.getPeerStatus.returns([]);

                let result = await engine.requestAttestation('BTC', 42, 'LTC');
                expect(result.status).to.equal('attested');
            });
        });
}
      // REG-XCH-006
    function registerNestedSuite1Part8() {
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
                    sig_pubkey: VALIDATORS_4[2].pubkey,
                    data: { attestationId, digest }
                });

                await waitUntil(() => emitted !== null, { label: 'the finalized round to emit its event' });

                expect(emitted).to.not.be.null;
                expect(emitted.attestationId).to.equal('LTC:10:DOGE');
                expect(emitted.status).to.equal('attested');
            });
        });
}
      // REG-XCH-009
    function registerNestedSuite1Part9() {
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
}
      // REG-XCH-010
    function registerNestedSuite1Part10() {
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
}
      // Digest determinism
    function registerNestedSuite1Part11() {
    describe('CrossChain digest determinism', function () {
            it('deterministic for same inputs @regression-p0', function () {
                expect(engine._digest('X', 3)).to.equal(engine._digest('X', 3));
            });

            it('different inputs → different digest @regression-p0', function () {
                expect(engine._digest('X', 3)).to.not.equal(engine._digest('Y', 3));
            });
        });
}
