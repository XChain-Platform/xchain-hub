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
const CrossChainEngine = require('../../../src/cross_chain/engine');
const { createMockHub }       = require('../../helpers/mockHub');
const { makeValidator, VALIDATORS_4 } = require('../../helpers/fixtures');

let hub, pm, cc;

describe('Boundary: CrossChainEngine', registerBoundaryCrossChainEngine);

function registerBoundaryCrossChainEngine() {
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
    // Chain pair validator set fallback
    describe('chain pair validator set fallback', registerChainPairValidatorSetFallback);
    // Leader rotation with chain pairs
    describe('leader rotation with chain pairs', registerLeaderRotationWithChainPairs);
    // Attestation ID boundaries
    describe('attestation ID handling', registerAttestationIDHandling);
    // Confirmation thresholds per chain
    describe('confirmation thresholds', registerConfirmationThresholds);
    // PBFT message validation
    describe('PBFT message validation', registerPBFTMessageValidation);
    // Digest determinism
    describe('digest', registerDigest);
}

function registerChainPairValidatorSetFallback() {
    it('getChainPairSet returns pair-specific set when available', testGetChainPairSetReturnsPairSpecificSetWhenAvailable);
    it('getChainPairSet tries reversed ordering (DOGE-BTC → BTC-DOGE)', testGetChainPairSetTriesReversedOrderingDOGEBTCBTCDOGE);
    it('getChainPairSet falls back to full validator set when pair not found', testGetChainPairSetFallsBackToFullValidatorSetWhenPairNotFound);
    it('getChainPairSet falls back when pair validators array is empty', testGetChainPairSetFallsBackWhenPairValidatorsArrayIsEmpty);
    it('getChainPairSet with no chain pair map returns full set', testGetChainPairSetWithNoChainPairMapReturnsFullSet);
}
function testGetChainPairSetReturnsPairSpecificSetWhenAvailable() {
    let pairSet = [makeValidator(1), makeValidator(2)];
    let pairMap = new Map();
    pairMap.set('BTC-LTC', pairSet);
    cc.setChainPairValidators(pairMap);
    cc.setValidatorSet(VALIDATORS_4);

    let result = cc.getChainPairSet('BTC', 'LTC');
    expect(result).to.equal(pairSet);
}
function testGetChainPairSetTriesReversedOrderingDOGEBTCBTCDOGE() {
    let pairSet = [makeValidator(1), makeValidator(2), makeValidator(3)];
    let pairMap = new Map();
    pairMap.set('BTC-DOGE', pairSet);
    cc.setChainPairValidators(pairMap);

    // Request DOGE→BTC, should find BTC-DOGE
    let result = cc.getChainPairSet('DOGE', 'BTC');
    expect(result).to.equal(pairSet);
}
function testGetChainPairSetFallsBackToFullValidatorSetWhenPairNotFound() {
    cc.setValidatorSet(VALIDATORS_4);
    cc.setChainPairValidators(new Map());

    let result = cc.getChainPairSet('BTC', 'UNKNOWN');
    expect(result).to.equal(VALIDATORS_4);
}
function testGetChainPairSetFallsBackWhenPairValidatorsArrayIsEmpty() {
    let pairMap = new Map();
    pairMap.set('BTC-LTC', []);
    cc.setChainPairValidators(pairMap);
    cc.setValidatorSet(VALIDATORS_4);

    let result = cc.getChainPairSet('BTC', 'LTC');
    // Empty array → falls back to full set
    expect(result).to.equal(VALIDATORS_4);
}
function testGetChainPairSetWithNoChainPairMapReturnsFullSet() {
    cc.setValidatorSet(VALIDATORS_4);
    cc.setChainPairValidators(new Map());

    let result = cc.getChainPairSet('LTC', 'DOGE');
    expect(result).to.equal(VALIDATORS_4);
}

function registerLeaderRotationWithChainPairs() {
    it('uses chain-pair set for leader selection', testUsesChainPairSetForLeaderSelection);
    it('uses full set when no chain pair specified', testUsesFullSetWhenNoChainPairSpecified);
    it('returns null when both sets are empty', testReturnsNullWhenBothSetsAreEmpty);
}
function testUsesChainPairSetForLeaderSelection() {
    let pairSet = [makeValidator(10), makeValidator(20)];
    let pairMap = new Map();
    pairMap.set('BTC-LTC', pairSet);
    cc.setChainPairValidators(pairMap);
    cc.setValidatorSet(VALIDATORS_4);

    let leader = cc._getLeader(0, 'BTC', 'LTC');
    expect(leader).to.equal(pairSet[0]);

    let leader2 = cc._getLeader(1, 'BTC', 'LTC');
    expect(leader2).to.equal(pairSet[1]);
}
function testUsesFullSetWhenNoChainPairSpecified() {
    cc.setValidatorSet(VALIDATORS_4);
    let leader = cc._getLeader(0);
    expect(leader).to.equal(VALIDATORS_4[0]);
}
function testReturnsNullWhenBothSetsAreEmpty() {
    cc.setValidatorSet([]);
    cc.setChainPairValidators(new Map());
    expect(cc._getLeader(0, 'BTC', 'LTC')).to.be.null;
}

function registerAttestationIDHandling() {
    it('already-finalized attestation returns stored result', testAlreadyFinalizedAttestationReturnsStoredResult);
    it('single-node fallback stores attestation directly', testSingleNodeFallbackStoresAttestationDirectly);
    it('sourceActionIndex is parsed to int', testSourceActionIndexIsParsedToInt);
}
async function testAlreadyFinalizedAttestationReturnsStoredResult() {
    let attestationId = 'BTC:100:LTC';
    cc.finalized.add(attestationId);
    hub.db.doQuery.resolves([{ attestation_id: attestationId, status: 'attested' }]);

    let result = await cc.requestAttestation('BTC', '100', 'LTC');
    expect(result.attestation_id).to.equal(attestationId);
    expect(pm.broadcast.called).to.be.false;
}
async function testSingleNodeFallbackStoresAttestationDirectly() {
    cc.setValidatorSet([]);
    pm.getPeerStatus.returns([]);

    let result = await cc.requestAttestation('BTC', '42', 'LTC');
    expect(result.status).to.equal('attested');
    expect(result.validatorCount).to.equal(1);
    expect(result.sourceActionIndex).to.equal(42);
    expect(hub.db.doQuery.called).to.be.true;
}
async function testSourceActionIndexIsParsedToInt() {
    cc.setValidatorSet([]);
    pm.getPeerStatus.returns([]);

    let result = await cc.requestAttestation('DOGE', '999', 'BTC');
    expect(result.sourceActionIndex).to.equal(999);
}

function registerConfirmationThresholds() {
    it('BTC uses 6 confirmations', testBTCUses6Confirmations);
    it('DOGE uses 60 confirmations', testDOGEUses60Confirmations);
    it('unknown chain is rejected by validation', testUnknownChainIsRejectedByValidation);
}
async function testBTCUses6Confirmations() {
    cc.setValidatorSet([]);
    pm.getPeerStatus.returns([]);

    let result = await cc.requestAttestation('BTC', '1', 'LTC');
    expect(result.confirmations).to.equal(6);
}
async function testDOGEUses60Confirmations() {
    cc.setValidatorSet([]);
    pm.getPeerStatus.returns([]);

    let result = await cc.requestAttestation('DOGE', '1', 'BTC');
    expect(result.confirmations).to.equal(60);
}
async function testUnknownChainIsRejectedByValidation() {
    cc.setValidatorSet([]);
    pm.getPeerStatus.returns([]);

    try {
        await cc.requestAttestation('UNKNOWN', '1', 'BTC');
        expect.fail('should have thrown');
    } catch (e) {
        expect(e.message).to.include('Invalid sourceChain');
    }
}

function registerPBFTMessageValidation() {
    beforeEach(function () {
        cc.setValidatorSet(VALIDATORS_4);
        pm.validatorAddr = VALIDATORS_4[0].addr;
    });
    it('PROPOSE with missing attestationId is ignored', testPROPOSEWithMissingAttestationIdIsIgnored);
    it('PROPOSE with wrong digest is ignored', testPROPOSEWithWrongDigestIsIgnored);
    it('PROPOSE for already-finalized attestation is ignored', testPROPOSEForAlreadyFinalizedAttestationIsIgnored);
    it('PREPARE with mismatched digest is ignored', testPREPAREWithMismatchedDigestIsIgnored);
}
function testPROPOSEWithMissingAttestationIdIsIgnored() {
    cc._handlePropose({
        sender: VALIDATORS_4[1].addr,
        data: { digest: 'abc' }
    });
    expect(cc.pendingAttestations.size).to.equal(0);
}
function testPROPOSEWithWrongDigestIsIgnored() {
    cc._handlePropose({
        sender: VALIDATORS_4[1].addr,
        data: {
            attestationId: 'BTC:1:LTC', sourceChain: 'BTC',
            sourceActionIndex: 1, destChain: 'LTC',
            confirmations: 3, digest: 'wrong-digest'
        }
    });
    expect(cc.pendingAttestations.size).to.equal(0);
}
function testPROPOSEForAlreadyFinalizedAttestationIsIgnored() {
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
}
function testPREPAREWithMismatchedDigestIsIgnored() {
    let digest = cc._digest('BTC:1:LTC', 3);
    cc.pendingAttestations.set('BTC:1:LTC', {
        attestationId: 'BTC:1:LTC', digest,
        prepares: new Set(), commits: new Set(),
        finalized: false, timer: null
    });

    cc.handlePrepare({
        sender: VALIDATORS_4[1].addr,
        data: { attestationId: 'BTC:1:LTC', digest: 'wrong' }
    });
    expect(cc.pendingAttestations.get('BTC:1:LTC').prepares.size).to.equal(0);
}

function registerDigest() {
    it('same inputs produce same digest', testSameInputsProduceSameDigest);
    it('different confirmations produce different digest', testDifferentConfirmationsProduceDifferentDigest);
    it('returns 64-char hex string', testReturns64CharHexString);
}
function testSameInputsProduceSameDigest() {
    let d1 = cc._digest('BTC:1:LTC', 3);
    let d2 = cc._digest('BTC:1:LTC', 3);
    expect(d1).to.equal(d2);
}
function testDifferentConfirmationsProduceDifferentDigest() {
    let d1 = cc._digest('BTC:1:LTC', 3);
    let d2 = cc._digest('BTC:1:LTC', 6);
    expect(d1).to.not.equal(d2);
}
function testReturns64CharHexString() {
    let d = cc._digest('BTC:1:LTC', 3);
    expect(d).to.match(/^[0-9a-f]{64}$/);
}
