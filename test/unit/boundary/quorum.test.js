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
const Consensus        = require('../../../src/consensus/pbft');
const OracleConsensus  = require('../../../src/oracle/consensus');
const CrossChainEngine = require('../../../src/cross_chain/engine');
const ReorgHandler     = require('../../../src/anchor/reorg_handler');
const { createMockHub }       = require('../../helpers/mockHub');
const { makeValidator }       = require('../../helpers/fixtures');

let hub, pm;
let consensus;
let cases = [
    { N: 0,   expected: 0,  label: 'N=0 → 0 (no validators, no peers)' },
    { N: 1,   expected: 0,  label: 'N=1 → 0 (single node fallback)' },
    { N: 2,   expected: 2,  label: 'N=2 → 2 (majority floor)' },
    { N: 3,   expected: 2,  label: 'N=3 → 2 (f=0; majority floor prevents quorum=1)' },
    { N: 4,   expected: 3,  label: 'N=4 → 3 (f=1)' },
    { N: 5,   expected: 3,  label: 'N=5 → 3' },
    { N: 6,   expected: 4,  label: 'N=6 → 4 (majority floor beats 2f+1=3)' },
    { N: 7,   expected: 5,  label: 'N=7 → 5 (f=2, sharp jump from N=6)' },
    { N: 10,  expected: 7,  label: 'N=10 → 7 (f=3)' },
    { N: 13,  expected: 9,  label: 'N=13 → 9 (f=4)' },
    { N: 100, expected: 67, label: 'N=100 → 67 (f=33)' }
];
let oc;
let cc;
let rh;

describe('Boundary: Quorum Calculation', registerBoundaryQuorumCalculation);

function registerBoundaryQuorumCalculation() {
    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
    });
    afterEach(function () {
        sinon.restore();
    });
    // Formula: f = floor((N-1)/3), quorum = 2f+1, N<=1 returns 0
    // Critical transitions: N=1→2 (0→1), N=3→4 (1→3), N=6→7 (3→5)
    describe('Consensus.getQuorum()', registerConsensusGetQuorum);
    // OracleConsensus uses same formula
    describe('OracleConsensus.getQuorum()', registerOracleConsensusGetQuorum);
    // CrossChainEngine: supports chain-pair-specific validator sets
    describe('CrossChainEngine.getQuorum()', registerCrossChainEngineGetQuorum);
    // ReorgHandler uses same formula
    describe('ReorgHandler.getQuorum()', registerReorgHandlerGetQuorum);
}

function registerConsensusGetQuorum() {
    beforeEach(function () {
        consensus = new Consensus(hub);
    });
    for (let c of cases) {
        it(c.label, function () {
            if (c.N === 0) {
                consensus.setValidatorSet([]);
                pm.getPeerStatus.returns([]);
            } else {
                let validators = Array.from({ length: c.N }, (_, i) => makeValidator(i + 1));
                consensus.setValidatorSet(validators);
            }
            expect(consensus.getQuorum()).to.equal(c.expected);
        });
    }
    it('peer-count fallback: 0 validators, 3 open peers → N=4, quorum=3', testPeerCountFallback0Validators3OpenPeersN4Quorum3);
    it('peer-count fallback ignores non-open peers', testPeerCountFallbackIgnoresNonOpenPeers);
}
function testPeerCountFallback0Validators3OpenPeersN4Quorum3() {
    consensus.setValidatorSet([]);
    pm.getPeerStatus.returns([
        { state: 'open' }, { state: 'open' }, { state: 'open' }
    ]);
    expect(consensus.getQuorum()).to.equal(3);
}
function testPeerCountFallbackIgnoresNonOpenPeers() {
    consensus.setValidatorSet([]);
    pm.getPeerStatus.returns([
        { state: 'open' }, { state: 'closed' }, { state: 'connecting' }
    ]);
    // 1 open peer + 1 self = 2 → quorum=2 (majority floor)
    expect(consensus.getQuorum()).to.equal(2);
}

function registerOracleConsensusGetQuorum() {
    beforeEach(function () {
        let oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
    });
    it('N=1 → 0 (single node)', testN10SingleNode);
    it('N=4 → 3', testN43);
    it('N=7 → 5', testN75);
    it('empty set + 0 peers → 0', testEmptySet0Peers0);
}
function testN10SingleNode() {
    oc.setValidatorSet([makeValidator(1)]);
    expect(oc.getQuorum()).to.equal(0);
}
function testN43() {
    oc.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
    expect(oc.getQuorum()).to.equal(3);
}
function testN75() {
    oc.setValidatorSet(Array.from({ length: 7 }, (_, i) => makeValidator(i + 1)));
    expect(oc.getQuorum()).to.equal(5);
}
function testEmptySet0Peers0() {
    oc.setValidatorSet([]);
    pm.getPeerStatus.returns([]);
    expect(oc.getQuorum()).to.equal(0);
}

function registerCrossChainEngineGetQuorum() {
    beforeEach(function () {
        cc = new CrossChainEngine(hub);
    });
    it('uses full validator set when no chain pair specified', testUsesFullValidatorSetWhenNoChainPairSpecified);
    it('uses chain-pair set when available', testUsesChainPairSetWhenAvailable);
    it('falls back to full set when pair not found', testFallsBackToFullSetWhenPairNotFound);
    it('chain pair with 1 validator → quorum=0', testChainPairWith1ValidatorQuorum0);
}
function testUsesFullValidatorSetWhenNoChainPairSpecified() {
    cc.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
    expect(cc.getQuorum()).to.equal(3);
}
function testUsesChainPairSetWhenAvailable() {
    cc.setValidatorSet(Array.from({ length: 7 }, (_, i) => makeValidator(i + 1)));
    // Chain pair has only 4 validators
    let pairMap = new Map();
    pairMap.set('BTC-LTC', Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
    cc.setChainPairValidators(pairMap);

    expect(cc.getQuorum('BTC', 'LTC')).to.equal(3); // Uses pair set (N=4)
    expect(cc.getQuorum()).to.equal(5);               // Uses full set (N=7)
}
function testFallsBackToFullSetWhenPairNotFound() {
    cc.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
    cc.setChainPairValidators(new Map());

    expect(cc.getQuorum('BTC', 'UNKNOWN')).to.equal(3);
}
function testChainPairWith1ValidatorQuorum0() {
    cc.setValidatorSet([]);
    let pairMap = new Map();
    pairMap.set('BTC-DOGE', [makeValidator(1)]);
    cc.setChainPairValidators(pairMap);

    expect(cc.getQuorum('BTC', 'DOGE')).to.equal(0);
}

function registerReorgHandlerGetQuorum() {
    beforeEach(function () {
        rh = new ReorgHandler(hub);
    });
    it('N=1 → 0', testN10);
    it('N=4 → 3', testN432);
    it('empty set + 2 open peers → N=3, quorum=2 (majority floor)', testEmptySet2OpenPeersN3Quorum2MajorityFloor);
}
function testN10() {
    rh.setValidatorSet([makeValidator(1)]);
    expect(rh.getQuorum()).to.equal(0);
}
function testN432() {
    rh.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
    expect(rh.getQuorum()).to.equal(3);
}
function testEmptySet2OpenPeersN3Quorum2MajorityFloor() {
    rh.setValidatorSet([]);
    pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
    expect(rh.getQuorum()).to.equal(2);
}
