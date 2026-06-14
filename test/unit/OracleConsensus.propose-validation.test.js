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
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub }       = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('OracleConsensus — follower price validation / minSubmissions / broadcast', function () {
    let hub, pm, oc, oracleRound, leader;
    const ROUND = 1;                               // must be truthy (_handlePropose: `if (!round) return`)

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Set();          // size 0 → _isKnownSender accepts any sender
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
        leader = oc._getLeader(ROUND);             // this round's deterministic leader
        // This hub is a follower — pick a validator that is NOT the round leader.
        pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== leader.addr).addr;
        // This follower's own locally-observed price for BTC/USD is 100000.
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
        ]));
    });

    afterEach(function () { sinon.restore(); });

    function proposeEnvelope(prices, round = ROUND) {
        return { sender: leader.addr, data: {
            round, prices, digest: oc._digest(round, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } };
    }

    it('rejects (no sign/PREPARE) a proposed price outside the slash deviation band', async function () {
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '200000' }])); // +100% vs local 100000
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(pm.broadcast.called).to.be.false;
    });

    it('rejects a proposed price at/above PRICE_MAX', async function () {
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '20000000' }])); // > 10_000_000
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
    });

    it('accepts a proposed price within the deviation band', async function () {
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '102000' }])); // +2% vs local
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('accepts (bound-only) when this hub has no local submission for the pair', async function () {
        oracleRound.getSubmissions.returns(new Map()); // no local aggregate → only PRICE_MAX bound applies
        await oc._handlePropose(proposeEnvelope([{ coinPair: 'BTC/USD', price: '100000' }]));
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
    });

    it('minSubmissions defaults to a 2-hub diversity floor', function () {
        let saved = process.env.ORACLE_MIN_SUBMISSIONS;
        delete process.env.ORACLE_MIN_SUBMISSIONS;
        let oc2 = new OracleConsensus(hub, oracleRound);
        expect(oc2.minSubmissions).to.equal(2);
        if (saved !== undefined) process.env.ORACLE_MIN_SUBMISSIONS = saved;
    });

    it('_storeSnapshot broadcasts each finalized row to hub-DB mirror subscribers', async function () {
        hub.hubDbBroadcaster = { broadcastRow: sinon.stub() };
        hub.db.doQuery.callsFake(async (sql) => {
            if (/SELECT \* FROM price_snapshots/i.test(sql)) return [{ round_number: 1, coin_pair: 'BTC/USD', price: '100000' }];
            return [];
        });
        await oc._storeSnapshot(1, [{ coinPair: 'BTC/USD', price: '100000' }], 3, 'proof', 100, 1700000000);
        expect(hub.hubDbBroadcaster.broadcastRow.calledOnce).to.be.true;
        expect(hub.hubDbBroadcaster.broadcastRow.firstCall.args[0].table).to.equal('price_snapshots');
    });
});
