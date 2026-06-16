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

const sinon            = require('sinon');
const { expect }       = require('chai');
const CrossChainEngine = require('../../../src/CrossChainEngine');
const { createMockHub }       = require('../../helpers/mockHub');
const { makeValidator, VALIDATORS_4 } = require('../../helpers/fixtures');

describe('Boundary: CrossChainEngine', function () {

    let hub, pm, cc;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        cc  = new CrossChainEngine(hub);
    });

    afterEach(function () {
        for (let [, pending] of cc.pendingAttestations) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Chain pair validator set fallback
    // -----------------------------------------------------------------

    describe('chain pair validator set fallback', function () {

        it('_getChainPairSet returns pair-specific set when available', function () {
            let pairSet = [makeValidator(1), makeValidator(2)];
            let pairMap = new Map();
            pairMap.set('BTC-LTC', pairSet);
            cc.setChainPairValidators(pairMap);
            cc.setValidatorSet(VALIDATORS_4);

            let result = cc._getChainPairSet('BTC', 'LTC');
            expect(result).to.equal(pairSet);
        });

        it('_getChainPairSet tries reversed ordering (DOGE-BTC → BTC-DOGE)', function () {
            let pairSet = [makeValidator(1), makeValidator(2), makeValidator(3)];
            let pairMap = new Map();
            pairMap.set('BTC-DOGE', pairSet);
            cc.setChainPairValidators(pairMap);

            // Request DOGE→BTC, should find BTC-DOGE
            let result = cc._getChainPairSet('DOGE', 'BTC');
            expect(result).to.equal(pairSet);
        });

        it('_getChainPairSet falls back to full validator set when pair not found', function () {
            cc.setValidatorSet(VALIDATORS_4);
            cc.setChainPairValidators(new Map());

            let result = cc._getChainPairSet('BTC', 'UNKNOWN');
            expect(result).to.equal(VALIDATORS_4);
        });

        it('_getChainPairSet falls back when pair validators array is empty', function () {
            let pairMap = new Map();
            pairMap.set('BTC-LTC', []);
            cc.setChainPairValidators(pairMap);
            cc.setValidatorSet(VALIDATORS_4);

            let result = cc._getChainPairSet('BTC', 'LTC');
            // Empty array → falls back to full set
            expect(result).to.equal(VALIDATORS_4);
        });

        it('_getChainPairSet with no chain pair map returns full set', function () {
            cc.setValidatorSet(VALIDATORS_4);
            cc.setChainPairValidators(new Map());

            let result = cc._getChainPairSet('LTC', 'DOGE');
            expect(result).to.equal(VALIDATORS_4);
        });
    });

    // -----------------------------------------------------------------
    // Leader rotation with chain pairs
    // -----------------------------------------------------------------

    describe('leader rotation with chain pairs', function () {

        it('uses chain-pair set for leader selection', function () {
            let pairSet = [makeValidator(10), makeValidator(20)];
            let pairMap = new Map();
            pairMap.set('BTC-LTC', pairSet);
            cc.setChainPairValidators(pairMap);
            cc.setValidatorSet(VALIDATORS_4);

            let leader = cc._getLeader(0, 'BTC', 'LTC');
            expect(leader).to.equal(pairSet[0]);

            let leader2 = cc._getLeader(1, 'BTC', 'LTC');
            expect(leader2).to.equal(pairSet[1]);
        });

        it('uses full set when no chain pair specified', function () {
            cc.setValidatorSet(VALIDATORS_4);
            let leader = cc._getLeader(0);
            expect(leader).to.equal(VALIDATORS_4[0]);
        });

        it('returns null when both sets are empty', function () {
            cc.setValidatorSet([]);
            cc.setChainPairValidators(new Map());
            expect(cc._getLeader(0, 'BTC', 'LTC')).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // Attestation ID boundaries
    // -----------------------------------------------------------------

    describe('attestation ID handling', function () {

        it('already-finalized attestation returns stored result', async function () {
            let attestationId = 'BTC:100:LTC';
            cc.finalized.add(attestationId);
            hub.db.doQuery.resolves([{ attestation_id: attestationId, status: 'attested' }]);

            let result = await cc.requestAttestation('BTC', '100', 'LTC');
            expect(result.attestation_id).to.equal(attestationId);
            expect(pm.broadcast.called).to.be.false;
        });

        it('single-node fallback stores attestation directly', async function () {
            cc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await cc.requestAttestation('BTC', '42', 'LTC');
            expect(result.status).to.equal('attested');
            expect(result.validatorCount).to.equal(1);
            expect(result.sourceActionIndex).to.equal(42);
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('sourceActionIndex is parsed to int', async function () {
            cc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await cc.requestAttestation('DOGE', '999', 'BTC');
            expect(result.sourceActionIndex).to.equal(999);
        });
    });

    // -----------------------------------------------------------------
    // Confirmation thresholds per chain
    // -----------------------------------------------------------------

    describe('confirmation thresholds', function () {

        it('BTC uses 6 confirmations', async function () {
            cc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await cc.requestAttestation('BTC', '1', 'LTC');
            expect(result.confirmations).to.equal(6);
        });

        it('DOGE uses 60 confirmations', async function () {
            cc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            let result = await cc.requestAttestation('DOGE', '1', 'BTC');
            expect(result.confirmations).to.equal(60);
        });

        it('unknown chain is rejected by validation', async function () {
            cc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);

            try {
                await cc.requestAttestation('UNKNOWN', '1', 'BTC');
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Invalid sourceChain');
            }
        });
    });

    // -----------------------------------------------------------------
    // PBFT message validation
    // -----------------------------------------------------------------

    describe('PBFT message validation', function () {

        beforeEach(function () {
            cc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        it('PROPOSE with missing attestationId is ignored', function () {
            cc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { digest: 'abc' }
            });
            expect(cc.pendingAttestations.size).to.equal(0);
        });

        it('PROPOSE with wrong digest is ignored', function () {
            cc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: {
                    attestationId: 'BTC:1:LTC', sourceChain: 'BTC',
                    sourceActionIndex: 1, destChain: 'LTC',
                    confirmations: 3, digest: 'wrong-digest'
                }
            });
            expect(cc.pendingAttestations.size).to.equal(0);
        });

        it('PROPOSE for already-finalized attestation is ignored', function () {
            cc.finalized.add('BTC:1:LTC');
            let digest = cc._digest('BTC:1:LTC', 3);
            cc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: {
                    attestationId: 'BTC:1:LTC', sourceChain: 'BTC',
                    sourceActionIndex: 1, destChain: 'LTC',
                    confirmations: 3, digest
                }
            });
            expect(cc.pendingAttestations.size).to.equal(0);
        });

        it('PREPARE with mismatched digest is ignored', function () {
            let digest = cc._digest('BTC:1:LTC', 3);
            cc.pendingAttestations.set('BTC:1:LTC', {
                attestationId: 'BTC:1:LTC', digest,
                prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            cc._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { attestationId: 'BTC:1:LTC', digest: 'wrong' }
            });
            expect(cc.pendingAttestations.get('BTC:1:LTC').prepares.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Digest determinism
    // -----------------------------------------------------------------

    describe('digest', function () {

        it('same inputs produce same digest', function () {
            let d1 = cc._digest('BTC:1:LTC', 3);
            let d2 = cc._digest('BTC:1:LTC', 3);
            expect(d1).to.equal(d2);
        });

        it('different confirmations produce different digest', function () {
            let d1 = cc._digest('BTC:1:LTC', 3);
            let d2 = cc._digest('BTC:1:LTC', 6);
            expect(d1).to.not.equal(d2);
        });

        it('returns 64-char hex string', function () {
            let d = cc._digest('BTC:1:LTC', 3);
            expect(d).to.match(/^[0-9a-f]{64}$/);
        });
    });
});
