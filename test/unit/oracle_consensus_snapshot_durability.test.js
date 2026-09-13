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
    // Mirrors FINALIZE_RETRY_MAX_MS in src/OracleConsensus.js (module-private).
    const FINALIZE_RETRY_MAX_MS = 30000;

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

    afterEach(function () {
        // Clear any self-heal re-drive timer a test armed (item 4281) BEFORE restoring the
        // stubs it would otherwise fire against once the suite has moved on.
        for (let [, p] of oc.pendingRounds) if (p && p.timer) clearTimeout(p.timer);
        oc.pendingRounds.clear();
        sinon.restore();
    });

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

    // item 4281: resetting finalized=false only makes the round re-drivable BY A PEER, and each
    // peer broadcasts COMMIT exactly once behind _commitSent. With the eviction timer already
    // cleared at commit quorum and no sweep over pendingRounds, a DB outage outlasting the
    // bounded retry above stranded the quorum-signed round in memory forever. The finalize path
    // must re-drive itself.
    it('re-drives finalization on its own timer after store exhaustion, with no peer COMMIT', async function () {
        let clock = sinon.useFakeTimers();
        let store = sinon.stub(oc, '_storeSnapshot').rejects(new Error('db down'));
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        // Drive the 3 bounded attempts (500ms + 1000ms of linear backoff between them).
        let cycle = oc._finalizeCommittedRound(ROUND);
        await clock.tickAsync(2000);
        await cycle;

        let pending = oc.pendingRounds.get(ROUND);
        expect(pending, 'round retained').to.exist;
        expect(pending.finalized).to.be.false;
        expect(pending.timer, 'autonomous re-drive armed').to.exist;
        expect(events).to.have.length(0);
        let attemptsBefore = store.callCount;

        // DB recovers. Nothing replays a COMMIT; only the armed timer runs.
        store.resolves();
        await clock.tickAsync(FINALIZE_RETRY_MAX_MS + 1000);

        expect(store.callCount).to.be.greaterThan(attemptsBefore);
        expect(oc.pendingRounds.has(ROUND)).to.be.false;   // stored, then cleared
        expect(oc.finalized.has(ROUND)).to.be.true;
        expect(events).to.have.length(1);                  // published exactly once
        expect(events[0].round).to.equal(ROUND);
    });

    // Control for the test above: with the re-arm removed the round is stranded exactly as
    // item 4281 describes, so a green self-heal cannot be an artefact of the harness.
    it('CONTROL: without the re-arm the round stays stranded forever, unstored and unpublished', async function () {
        let clock = sinon.useFakeTimers();
        let store = sinon.stub(oc, '_storeSnapshot').rejects(new Error('db down'));
        sinon.stub(oc, '_armFinalizeRetry');                // pre-fix behavior: retain only
        oc.pendingRounds.set(ROUND, makePending());
        let events = [];
        oc.on('round:finalized', e => events.push(e));

        let cycle = oc._finalizeCommittedRound(ROUND);
        await clock.tickAsync(2000);
        await cycle;

        let attemptsBefore = store.callCount;
        store.resolves();                                   // DB recovers
        await clock.tickAsync(10 * 60 * 1000);              // ten minutes, no peer COMMIT

        expect(store.callCount).to.equal(attemptsBefore);   // nothing ever retried
        expect(oc.pendingRounds.has(ROUND)).to.be.true;     // still sitting in memory
        expect(oc.finalized.has(ROUND)).to.be.false;        // never persisted
        expect(events).to.have.length(0);                   // never published
    });

    it('keeps at most one re-drive timer per round across repeated failures', async function () {
        let clock = sinon.useFakeTimers();
        sinon.stub(oc, '_storeSnapshot').rejects(new Error('db down'));
        oc.pendingRounds.set(ROUND, makePending());

        let cycle = oc._finalizeCommittedRound(ROUND);
        await clock.tickAsync(2000);
        await cycle;

        let first = oc.pendingRounds.get(ROUND).timer;
        let firstDelay = oc.pendingRounds.get(ROUND)._finalizeRetryMs;
        await clock.tickAsync(firstDelay + 2000);          // fires, fails again, re-arms

        let pending = oc.pendingRounds.get(ROUND);
        expect(pending, 'round still retained after a second failed cycle').to.exist;
        expect(pending.timer).to.not.equal(first);          // replaced, never stacked
        expect(pending._finalizeRetryMs).to.be.greaterThan(firstDelay);   // backoff grows
        expect(pending._finalizeRetryMs).to.be.at.most(FINALIZE_RETRY_MAX_MS);
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
