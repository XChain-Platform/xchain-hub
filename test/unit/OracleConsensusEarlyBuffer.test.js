'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.
//
// Finding F7 (standing-federation Phase 1, 2026-06-11): PREPARE/COMMIT
// arriving before this hub's pendingRounds entry exists were silently
// dropped — _handlePropose awaits the block-boundary snapshot fetch, and
// the whole PBFT burst completes inside that window. The hub then never
// reached commit quorum locally and the round vanished from its
// price_snapshots even though the federation finalized. These tests pin
// the early-message buffer that fixes it.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');

describe('OracleConsensus — early-message buffer (F7)', function () {

    let hub, pm, oc, oracleRound;
    const VALSET = [
        { addr: 'ws://val-a:10001' },
        { addr: 'ws://val-b:10002' },
        { addr: 'ws://val-c:10003' },
    ];
    // round % 3 === 0 → leader is VALSET[0]
    const ROUND  = 300;
    const PRICES = [{ coinPair: 'BTC/USD', price: '100.00000000' }];

    function proposeEnvelope(digest) {
        return {
            type:   'ORACLE_PROPOSE',
            sender: VALSET[0].addr,
            data:   { round: ROUND, prices: PRICES, digest, btcBlockHeight: 1000, btcBlockTime: 1700000000 }
        };
    }
    function voteEnvelope(type, sender, digest) {
        return { type, sender, data: { round: ROUND, digest } };
    }

    beforeEach(function () {
        hub = createMockHub({ validatorAddr: VALSET[1].addr }); // we are val-b (follower)
        pm  = hub._peerManager;
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALSET);
    });

    afterEach(function () {
        oc.stop();
        sinon.restore();
    });

    it('buffers a PREPARE that arrives before any pending round exists', function () {
        let digest = oc._digest(ROUND, PRICES);
        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, digest));
        expect(oc.pendingRounds.has(ROUND)).to.be.false;
        expect(oc.earlyMessages.get(ROUND)).to.have.length(1);
    });

    it('buffers a COMMIT that arrives before any pending round exists', function () {
        let digest = oc._digest(ROUND, PRICES);
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[2].addr, digest));
        expect(oc.earlyMessages.get(ROUND)).to.have.length(1);
    });

    it('does NOT buffer for rounds already finalized', function () {
        let digest = oc._digest(ROUND, PRICES);
        oc.finalized.add(ROUND);
        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, digest));
        expect(oc.earlyMessages.has(ROUND)).to.be.false;
    });

    it('caps the buffer per round', function () {
        let digest = oc._digest(ROUND, PRICES);
        for (let i = 0; i < oc.earlyMessageMaxPerRound + 10; i++) {
            oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', 'ws://flood-' + i + ':1', digest));
        }
        expect(oc.earlyMessages.get(ROUND)).to.have.length(oc.earlyMessageMaxPerRound);
    });

    it('drains buffered votes into the pending round once the PROPOSE lands', async function () {
        let digest = oc._digest(ROUND, PRICES);

        // Votes from val-c beat the proposal (the F7 race).
        oc._handlePrepare(voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, digest));
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT',  VALSET[2].addr, digest));
        expect(oc.earlyMessages.get(ROUND)).to.have.length(2);

        // Leader's PROPOSE arrives late.
        await oc._handlePropose(proposeEnvelope(digest));

        expect(oc.earlyMessages.has(ROUND)).to.be.false;            // drained
        let pending = oc.pendingRounds.get(ROUND);
        expect(pending, 'pending round must exist').to.exist;
        expect(pending.prepares.has(VALSET[2].addr)).to.be.true;    // replayed
        expect(pending.commits.has(VALSET[2].addr)).to.be.true;     // replayed
    });

    it('reaches commit quorum from replayed votes alone (the missed-round scenario)', async function () {
        let digest = oc._digest(ROUND, PRICES);

        // Both peers' COMMITs arrive while our PROPOSE handling is delayed.
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[0].addr, digest));
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[2].addr, digest));

        await oc._handlePropose(proposeEnvelope(digest));
        // _checkCommitQuorum stores via async db call; let it settle.
        await new Promise(r => setImmediate(r));

        // quorum for N=3 is 2 — replayed commits must finalize the round.
        expect(oc.finalized.has(ROUND)).to.be.true;
        expect(hub.db.doQuery.getCalls().some(c => String(c.args[0]).includes('INSERT INTO price_snapshots'))).to.be.true;
    });

    it('drains at the proposer site too (_proposeRound)', function () {
        let digest = null; // computed inside _proposeRound from aggregated submissions
        let subs = new Map([
            [VALSET[1].addr, { sender: VALSET[1].addr, prices: PRICES }],
        ]);
        // Buffer a vote keyed by the round before proposing. Digest must match
        // what _proposeRound computes over its own aggregation.
        let aggregated = oc._aggregateAll(subs);
        digest = oc._digest(ROUND, aggregated);
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[2].addr, digest));

        oc._proposeRound(ROUND, subs, false, 1000, 1700000000, null, 2);

        let pending = oc.pendingRounds.get(ROUND);
        expect(pending).to.exist;
        expect(pending.commits.has(VALSET[2].addr)).to.be.true;
        expect(oc.earlyMessages.has(ROUND)).to.be.false;
    });
});
