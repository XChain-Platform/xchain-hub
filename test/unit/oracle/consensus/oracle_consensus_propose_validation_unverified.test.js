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
const OracleConsensus  = require('../../../../src/oracle/consensus');
const PriceFetcher     = require('../../../../src/oracle/price_fetcher');
const { createMockHub }       = require('../../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions, makeCapabilitySnapshotStub } = require('../../../helpers/fixtures');


    let hub, pm, oc, oracleRound, leader;

    const ROUND = 1;


    function proposeEnvelope(prices, round = ROUND) {
        return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
            round, prices, digest: oc.digest(round, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } };
    }


        let prevEnv;


        function ocOnNetwork(network) {
            let h = createMockHub();
            h.network = network;
            return new OracleConsensus(h, { getSubmissions: sinon.stub().returns(new Map()) });
        }

function registerOracleconsensusFollowerPriceValidationMinsubmissions1Hooks() {                               // must be truthy (handlePropose: `if (!round) return`)

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();          // size 0 → isKnownSender accepts any sender
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        // A federated hub refuses a round with no deterministic capability snapshot, so the
        // harness models one over the same validators. These cases are about price content,
        // not about the snapshot being unreachable.
        hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc.getLeader(ROUND);             // this round's deterministic leader
        // This hub is a follower; pick a validator that is NOT the round leader.
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        // This follower's own locally-observed price for BTC/USD is 100000.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
    });

    afterEach(function () { sinon.restore(); });
}

function registerOracleAllowUnverifiedPairsNetwork2Hooks() {

        beforeEach(function () {
            prevEnv = process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS;
            process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS = 'true';
        });

        afterEach(function () {
            if (prevEnv === undefined) delete process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS;
            else process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS = prevEnv;
        });
}

function registerOracleAllowUnverifiedPairsNetwork2Tests1() {

        it('honors the flag on regtest', function () {
            expect(ocOnNetwork('regtest').allowUnverifiedPairs).to.equal(true);
        });

        ['mainnet', 'testnet', ''].forEach(function (network) {
            it('ignores the flag on ' + (network || '<unset network>') + ' and warns', function () {
                let logs = [];
                let stub = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
                let flag;
                try { flag = ocOnNetwork(network).allowUnverifiedPairs; } finally { stub.restore(); }
                expect(flag).to.equal(false);
                expect(logs.join('\n')).to.contain('ORACLE_ALLOW_UNVERIFIED_PAIRS is set but IGNORED');
            });
        });

        it('stays silent and fail-closed on mainnet when the flag is unset', function () {
            delete process.env.ORACLE_ALLOW_UNVERIFIED_PAIRS;
            let logs = [];
            let stub = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
            let flag;
            try { flag = ocOnNetwork('mainnet').allowUnverifiedPairs; } finally { stub.restore(); }
            expect(flag).to.equal(false);
            expect(logs.join('\n')).to.not.contain('ORACLE_ALLOW_UNVERIFIED_PAIRS');
        });

}

describe('OracleConsensus: follower price validation / minSubmissions / broadcast', function () {
    registerOracleconsensusFollowerPriceValidationMinsubmissions1Hooks();



    // ORACLE_ALLOW_UNVERIFIED_PAIRS disarms the unverifiable-pair co-sign defense above, so
    // it is a regtest-only bring-up seam and follows the same rule as the platform's other
    // regtest hatches (StateCheckpointEngine XDEX_SNAPSHOT_BLOCK, coins resolveFeeDestination):
    // honored on regtest, set-but-IGNORED and warned on every other network. Without the gate
    // a stray env var on a mainnet or testnet hub silently restores clamp-only leniency and
    // lets a Byzantine sole submitter get an arbitrary price co-signed.
    describe('ORACLE_ALLOW_UNVERIFIED_PAIRS network gate', function () {
        registerOracleAllowUnverifiedPairsNetwork2Hooks();
        registerOracleAllowUnverifiedPairsNetwork2Tests1();
    });
});
