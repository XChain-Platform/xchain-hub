'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// finalizeRound already computed federation-wide source diversity and, when it
// collapsed, emitted a console.warn and nothing else: the value was never counted,
// never stored and never reached getSubmissionsInfo, so `getoraclesubmissions` --
// the payload the dashboard's whole oracle ladder is built from -- had no field for
// it. The round finalizes normally, so every other signal (round_timeouts, the skip
// streak, lastSuccessAgeSec, pairHealth) reads healthy while PRICE v0 keeps being
// quorum-signed with no outlier rejection behind it, and the only trace is one hub's
// stdout. These cases pin the counter, its export and the fact that the round's
// OUTCOME is unchanged by counting it.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const OracleRound     = require('../../src/OracleRound');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

function snapshotOf(validators, blockIndex) {
    return {
        capability: 'price',
        blockIndex: blockIndex,
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100' }))
    };
}

describe('OracleConsensus: single-source rounds are counted, not only logged', function () {
    let hub, pm, oc, oracleRound, warn;
    const ROUND = 2;

    function submissionsWithSources(n) {
        return buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000', sources: n }] },
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000', sources: n }] }
        ]);
    }

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorAddr = VALIDATORS_3[0].addr;
        pm.validatorPubkeys = new Map(VALIDATORS_3.map(v => [v.addr, v.pubkey]));
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        hub.capabilitySnapshot = {
            getSnapshot:       sinon.stub().resolves(snapshotOf(VALIDATORS_3.slice(0, 2), 100)),
            getWeightSnapshot: sinon.stub().resolves(null),
            getQuorum:         sinon.stub().returns(2)
        };
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()), priceFetcher: null };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        warn = sinon.stub(console, 'warn');
    });

    afterEach(function () { sinon.restore(); });

    it('starts at zero with no last round recorded', function () {
        expect(oc._singleSourceRounds).to.equal(0);
        expect(oc._lastSingleSourceRound).to.equal(null);
    });

    it('counts a round that finalized on one uncorrelated source, and names it', async function () {
        oracleRound.getSubmissions.returns(submissionsWithSources(1));
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(oc._singleSourceRounds).to.equal(1);
        expect(oc._lastSingleSourceRound).to.equal(ROUND);
    });

    it('leaves the round outcome untouched: it still proposes and is still signed', async function () {
        oracleRound.getSubmissions.returns(submissionsWithSources(1));
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(pm.broadcast.calledOnce).to.be.true;
        expect(pm.broadcast.firstCall.args[0]).to.equal('ORACLE_PROPOSE');
    });

    it('stays flat for a healthy multi-source round', async function () {
        oracleRound.getSubmissions.returns(submissionsWithSources(2));
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(oc._singleSourceRounds).to.equal(0);
        expect(oc._lastSingleSourceRound).to.equal(null);
        expect(warn.called).to.be.false;
    });

    it('does not count a round it cannot assess (no per-pair source counts)', async function () {
        // _minRoundSources returns Infinity when no submission carries a count. An
        // unassessable round is not a degraded one, and counting it would make the
        // series fire on every round from any hub running an older submitter.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(oc._singleSourceRounds).to.equal(0);
    });

    it('is monotonic across rounds rather than a per-round flag', async function () {
        oracleRound.getSubmissions.returns(submissionsWithSources(1));
        await oc.finalizeRound(2, 100, 1700000000);
        await oc.finalizeRound(4, 100, 1700000000);
        expect(oc._singleSourceRounds).to.equal(2);
        expect(oc._lastSingleSourceRound).to.equal(4);
    });
});

describe('OracleRound.getSubmissionsInfo exports the diversity counter', function () {
    function roundWith(consensus) {
        const round = Object.create(OracleRound.prototype);
        round.submissions     = new Map();
        round.db              = { doQuery: async () => [] };
        round.oracleConsensus = consensus;
        return round;
    }

    it('carries single_source_rounds and the last such round from the consensus handle', async function () {
        const info = await roundWith({ _roundTimeouts: 0, _singleSourceRounds: 3, _lastSingleSourceRound: 4211 })
            .getSubmissionsInfo();
        expect(info.single_source_rounds).to.equal(3);
        expect(info.lastSingleSourceRound).to.equal(4211);
    });

    it('reports 0 / null before the consensus handle is wired, not undefined', async function () {
        // setConsensus() runs inside startOracle(), so an RPC can land on a
        // half-built oracle; undefined here would read as "field absent" to the
        // monitor and silence the rail on every tick of a starting hub.
        const info = await roundWith(null).getSubmissionsInfo();
        expect(info.single_source_rounds).to.equal(0);
        expect(info.lastSingleSourceRound).to.equal(null);
    });
});
