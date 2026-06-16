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
const Consensus        = require('../../../src/Consensus');
const OracleConsensus  = require('../../../src/OracleConsensus');
const CrossChainEngine = require('../../../src/CrossChainEngine');
const ReorgHandler     = require('../../../src/ReorgHandler');
const { createMockHub }       = require('../../helpers/mockHub');
const { makeValidator }       = require('../../helpers/fixtures');

describe('Boundary: Quorum Calculation', function () {

    let hub, pm;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Formula: f = floor((N-1)/3), quorum = 2f+1, N<=1 returns 0
    // Critical transitions: N=1→2 (0→1), N=3→4 (1→3), N=6→7 (3→5)
    // -----------------------------------------------------------------

    describe('Consensus._getQuorum()', function () {

        let consensus;
        beforeEach(function () {
            consensus = new Consensus(hub);
        });

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

        for (let c of cases) {
            it(c.label, function () {
                if (c.N === 0) {
                    consensus.setValidatorSet([]);
                    pm.getPeerStatus.returns([]);
                } else {
                    let validators = Array.from({ length: c.N }, (_, i) => makeValidator(i + 1));
                    consensus.setValidatorSet(validators);
                }
                expect(consensus._getQuorum()).to.equal(c.expected);
            });
        }

        it('peer-count fallback: 0 validators, 3 open peers → N=4, quorum=3', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([
                { state: 'open' }, { state: 'open' }, { state: 'open' }
            ]);
            expect(consensus._getQuorum()).to.equal(3);
        });

        it('peer-count fallback ignores non-open peers', function () {
            consensus.setValidatorSet([]);
            pm.getPeerStatus.returns([
                { state: 'open' }, { state: 'closed' }, { state: 'connecting' }
            ]);
            // 1 open peer + 1 self = 2 → quorum=2 (majority floor)
            expect(consensus._getQuorum()).to.equal(2);
        });
    });

    // -----------------------------------------------------------------
    // OracleConsensus uses same formula
    // -----------------------------------------------------------------

    describe('OracleConsensus._getQuorum()', function () {

        let oc;
        beforeEach(function () {
            let oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
            oc = new OracleConsensus(hub, oracleRound);
        });

        it('N=1 → 0 (single node)', function () {
            oc.setValidatorSet([makeValidator(1)]);
            expect(oc._getQuorum()).to.equal(0);
        });

        it('N=4 → 3', function () {
            oc.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
            expect(oc._getQuorum()).to.equal(3);
        });

        it('N=7 → 5', function () {
            oc.setValidatorSet(Array.from({ length: 7 }, (_, i) => makeValidator(i + 1)));
            expect(oc._getQuorum()).to.equal(5);
        });

        it('empty set + 0 peers → 0', function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            expect(oc._getQuorum()).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // CrossChainEngine — supports chain-pair-specific validator sets
    // -----------------------------------------------------------------

    describe('CrossChainEngine._getQuorum()', function () {

        let cc;
        beforeEach(function () {
            cc = new CrossChainEngine(hub);
        });

        it('uses full validator set when no chain pair specified', function () {
            cc.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
            expect(cc._getQuorum()).to.equal(3);
        });

        it('uses chain-pair set when available', function () {
            cc.setValidatorSet(Array.from({ length: 7 }, (_, i) => makeValidator(i + 1)));
            // Chain pair has only 4 validators
            let pairMap = new Map();
            pairMap.set('BTC-LTC', Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
            cc.setChainPairValidators(pairMap);

            expect(cc._getQuorum('BTC', 'LTC')).to.equal(3); // Uses pair set (N=4)
            expect(cc._getQuorum()).to.equal(5);               // Uses full set (N=7)
        });

        it('falls back to full set when pair not found', function () {
            cc.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
            cc.setChainPairValidators(new Map());

            expect(cc._getQuorum('BTC', 'UNKNOWN')).to.equal(3);
        });

        it('chain pair with 1 validator → quorum=0', function () {
            cc.setValidatorSet([]);
            let pairMap = new Map();
            pairMap.set('BTC-DOGE', [makeValidator(1)]);
            cc.setChainPairValidators(pairMap);

            expect(cc._getQuorum('BTC', 'DOGE')).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // ReorgHandler uses same formula
    // -----------------------------------------------------------------

    describe('ReorgHandler._getQuorum()', function () {

        let rh;
        beforeEach(function () {
            rh = new ReorgHandler(hub);
        });

        it('N=1 → 0', function () {
            rh.setValidatorSet([makeValidator(1)]);
            expect(rh._getQuorum()).to.equal(0);
        });

        it('N=4 → 3', function () {
            rh.setValidatorSet(Array.from({ length: 4 }, (_, i) => makeValidator(i + 1)));
            expect(rh._getQuorum()).to.equal(3);
        });

        it('empty set + 2 open peers → N=3, quorum=2 (majority floor)', function () {
            rh.setValidatorSet([]);
            pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
            expect(rh._getQuorum()).to.equal(2);
        });
    });
});
