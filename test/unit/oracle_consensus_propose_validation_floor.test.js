'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: followers must content-validate a leader's proposed prices before co-signing
// (leadership rotates round-robin, so a Byzantine/feed-broken validator gets leader turns), plus the
// minSubmissions diversity floor and the finalized-round mirror broadcast.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/oracle/consensus');
const PriceFetcher     = require('../../src/oracle/price_fetcher');
const { createMockHub }       = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions, makeCapabilitySnapshotStub } = require('../helpers/fixtures');


    let hub, pm, oc, oracleRound, leader;

    const ROUND = 1;


    function proposeEnvelope(prices, round = ROUND) {
        return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
            round, prices, digest: oc._digest(round, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } };
    }


        let prevEnv;


        function ocOnNetwork(network) {
            let h = createMockHub();
            h.network = network;
            return new OracleConsensus(h, { getSubmissions: sinon.stub().returns(new Map()) });
        }


        function constructCapturingLogs(network) {
            let logs = [];
            let logStub  = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
            let warnStub = sinon.stub(console, 'warn').callsFake(m => logs.push(String(m)));
            let oc;
            try { oc = ocOnNetwork(network); } finally { logStub.restore(); warnStub.restore(); }
            return { oc: oc, text: logs.join('\n') };
        }

function registerOracleconsensusFollowerPriceValidationMinsubmissions1Hooks() {                               // must be truthy (_handlePropose: `if (!round) return`)

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();          // size 0 → _isKnownSender accepts any sender
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        // A federated hub refuses a round with no deterministic capability snapshot, so the
        // harness models one over the same validators. These cases are about price content,
        // not about the snapshot being unreachable.
        hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc._getLeader(ROUND);             // this round's deterministic leader
        // This hub is a follower; pick a validator that is NOT the round leader.
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        // This follower's own locally-observed price for BTC/USD is 100000.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
    });

    afterEach(function () { sinon.restore(); });
}

function registerOracleMinSubmissionsFloor2Hooks() {

        beforeEach(function () {
            prevEnv = process.env.ORACLE_MIN_SUBMISSIONS;
        });

        afterEach(function () {
            if (prevEnv === undefined) delete process.env.ORACLE_MIN_SUBMISSIONS;
            else process.env.ORACLE_MIN_SUBMISSIONS = prevEnv;
        });
}

function registerOracleMinSubmissionsFloor2Tests1() {

        it('defaults to 2 and says nothing when the knob is unset', function () {
            delete process.env.ORACLE_MIN_SUBMISSIONS;
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(2);
            expect(r.text).to.not.contain('ORACLE_MIN_SUBMISSIONS');
        });

        it('honors an explicit 1 on mainnet but announces the stood-down floor', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '1';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(1);
            expect(r.text).to.contain('ORACLE_MIN_SUBMISSIONS=1');
            expect(r.text).to.contain('mainnet');
        });

        it('honors an explicit 1 on regtest without the banner', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '1';
            let r = constructCapturingLogs('regtest');
            expect(r.oc.minSubmissions).to.equal(1);
            expect(r.text).to.not.contain('STOOD DOWN');
        });

        it('falls back to 2 on a negative value rather than removing the floor', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '-1';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(2);
        });

        it('falls back to 2 on an unparseable value', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = 'one';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(2);
        });

        it('honors a raised floor on every network', function () {
            process.env.ORACLE_MIN_SUBMISSIONS = '5';
            let r = constructCapturingLogs('mainnet');
            expect(r.oc.minSubmissions).to.equal(5);
            expect(r.text).to.not.contain('STOOD DOWN');
        });

}

describe('OracleConsensus: follower price validation / minSubmissions / broadcast', function () {
    registerOracleconsensusFollowerPriceValidationMinsubmissions1Hooks();



    // ORACLE_MIN_SUBMISSIONS lowers the 2-hub price diversity floor. Unlike the hatch above
    // it is NOT regtest-gated, because single-host PROD is a supported deployment that would
    // otherwise skip every round; what it must not be is silent, and a NEGATIVE value must
    // never remove the floor outright (`size < -1` is always false).
    describe('ORACLE_MIN_SUBMISSIONS floor', function () {
        registerOracleMinSubmissionsFloor2Hooks();
        registerOracleMinSubmissionsFloor2Tests1();
    });
});
