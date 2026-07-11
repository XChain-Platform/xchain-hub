'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// #1443 CONSENSUS-DURABILITY GUARD: a round that reached commit quorum (with
// collected validator signatures) must not evaporate on a transient snapshot-store
// DB error. The finalize path must retry, and on ultimate failure retain round state
// with finalized reset to false so a replayed COMMIT can re-drive finalization,
// never delete the round or leave it stuck finalized-but-unstored.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');

describe('OracleConsensus: quorum-finalized snapshot-store durability (#1443)', function () {
    let hub, oc, oracleRound;
    const ROUND = 5;

    function makePending() {
        return {
            prepares:       new Set(['pkA', 'pkB', 'pkC']),
            commits:        new Set(['pkA', 'pkB', 'pkC']),
            signatures:     new Map([['pkA', 'sigA'], ['pkB', 'sigB']]),
            prices:         [{ coinPair: 'BTC/USD', price: '100000' }],
            btcBlockHeight: 100,
            btcBlockTime:   1700000000,
            finalized:      true                       // set by _checkCommitQuorum before store
        };
    }

    beforeEach(function () {
        hub = createMockHub();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
    });

    afterEach(function () { sinon.restore(); });

    it('on durable store success: marks finalized, clears round state, emits round:finalized', async function () {
        let store = sinon.stub(oc, '_storeSnapshot').resolves();
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        await oc._finalizeCommittedRound(ROUND);

        expect(store.calledOnce).to.be.true;
        expect(oc.pendingRounds.has(ROUND)).to.be.false;   // state cleared only after success
        expect(oc.finalized.has(ROUND)).to.be.true;
        expect(events).to.have.length(1);
        expect(events[0].round).to.equal(ROUND);
        expect(events[0].prices).to.deep.equal([{ coinPair: 'BTC/USD', price: '100000' }]);
    });

    it('on persistent store failure: retains round state, resets finalized=false, never emits', async function () {
        this.timeout(5000);                                // bounded retries use linear backoff
        let store = sinon.stub(oc, '_storeSnapshot').rejects(new Error('db down'));
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        await oc._finalizeCommittedRound(ROUND);

        expect(store.callCount).to.be.greaterThan(1);      // retried, not one-and-done
        expect(oc.pendingRounds.has(ROUND)).to.be.true;    // NOT dropped
        expect(oc.pendingRounds.get(ROUND).finalized).to.be.false; // re-drivable by a replayed COMMIT
        expect(oc.finalized.has(ROUND)).to.be.false;       // never marked finalized
        expect(events).to.have.length(0);                  // publisher never told
    });

    it('re-finalizes after a transient failure when a later COMMIT re-enters the store path', async function () {
        this.timeout(5000);
        let store = sinon.stub(oc, '_storeSnapshot').rejects(new Error('db down'));
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        // First finalize cycle fails on every retry: round retained, finalized reset.
        await oc._finalizeCommittedRound(ROUND);
        expect(oc.pendingRounds.has(ROUND)).to.be.true;
        expect(oc.pendingRounds.get(ROUND).finalized).to.be.false;
        expect(events).to.have.length(0);

        // DB recovers; a replayed COMMIT re-enters _checkCommitQuorum, which re-sets
        // finalized=true and re-drives the store. Emulate that re-entry directly.
        store.resolves();
        oc.pendingRounds.get(ROUND).finalized = true;
        await oc._finalizeCommittedRound(ROUND);

        expect(oc.pendingRounds.has(ROUND)).to.be.false;   // now cleared
        expect(oc.finalized.has(ROUND)).to.be.true;        // now durably finalized
        expect(events).to.have.length(1);                  // and published exactly once
        expect(events[0].round).to.equal(ROUND);
    });

    it('recovers within one finalize cycle when an early store attempt fails but a retry succeeds', async function () {
        this.timeout(5000);
        let store = sinon.stub(oc, '_storeSnapshot');
        store.onFirstCall().rejects(new Error('transient'));
        store.onSecondCall().resolves();
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        await oc._finalizeCommittedRound(ROUND);

        expect(store.callCount).to.equal(2);
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(oc.finalized.has(ROUND)).to.be.true;
        expect(events).to.have.length(1);
    });
});
