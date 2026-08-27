'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: a follower must withhold its co-sign when the
// leader's PROPOSE omits a pair the follower priced locally (or is empty).
// The per-price deviation loop only bounds pairs the proposer INCLUDES, so
// omission was otherwise unbounded, letting a Byzantine leader freeze a pair.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('OracleConsensus PROPOSE pair-coverage (stress-sweep 2026-07-08)', function () {
    let hub, pm, oc, oracleRound, leader;
    const ROUND = 1;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc._getLeader(ROUND);
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        // This follower priced BTC/USD locally this round.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
    });

    afterEach(function () { sinon.restore(); });

    function envelope(prices) {
        return { sender: leader.addr, sig_pubkey: leader.pubkey, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } };
    }

    it('withholds co-sign when the proposal omits a locally-priced pair', async function () {
        // Proposal covers only LTC/USD; this follower priced BTC/USD but it is dropped.
        await oc._handlePropose(envelope([{ coinPair: 'LTC/USD', price: '90' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('withholds co-sign on an empty proposal', async function () {
        await oc._handlePropose(envelope([]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('co-signs when the proposal covers the locally-priced pair', async function () {
        await oc._handlePropose(envelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    // item 4939: coverage is owed only for pairs the LEADER's own aggregation prices.
    // A pair submitted by the leader plus exactly one other hub, disagreeing past
    // ORACLE_DEVIATION_THRESHOLD, is dropped by the leader's exactly-2-source gate and
    // honestly omitted. The follower's reference excludes the proposer, so that pair
    // looks single-source there, never meets the 2-source gate, and used to trip this
    // check on every honest round the two feeds diverged - costing all 36+ pairs and
    // leaving no price_snapshots row at all.
    it('co-signs when the leader honestly drops a 2-source divergent pair', async function () {
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: leader.addr, prices: [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '100' }
            ] },
            { sender: pm.validatorAddr, prices: [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '200' }   // (200-100)/300 = 33% > 5% gate
            ] }
        ]));
        // The leader aggregates the full set, so LTC/USD drops out of its proposal.
        let leaderPairs = oc._aggregateAll(oracleRound.getSubmissions(ROUND)).map(a => a.coinPair);
        expect(leaderPairs).to.deep.equal(['BTC/USD']);

        await oc._handlePropose(envelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND), 'honest 2-source drop must not wedge the round').to.be.true;
    });

    it('still withholds when the leader suppresses a pair its own aggregate prices', async function () {
        // Same shape, but the two feeds AGREE, so the leader's aggregate keeps
        // LTC/USD: omitting it is suppression and the round is withheld.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: leader.addr, prices: [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '100' }
            ] },
            { sender: pm.validatorAddr, prices: [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '100' }
            ] }
        ]));
        let events = [];
        oc.on('oracle:propose-rejected', e => events.push(e));
        await oc._handlePropose(envelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(events.map(e => e.reason)).to.include('missing-pairs');
    });
});
