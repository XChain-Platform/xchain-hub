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
//
// Finding F7 (standing-federation Phase 1, 2026-06-11): PREPARE/COMMIT
// arrives before this hub's pendingRounds entry exists, and gets silently
// dropped. _handlePropose awaits the block-boundary snapshot fetch, and
// the whole PBFT burst completes inside that window. The hub then never
// reached commit quorum locally and the round vanished from its
// price_snapshots even though the federation finalized. These tests pin
// the early-message buffer that fixes it.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const { createMockHub } = require('../helpers/mockHub');
const { pubkeyForTestSender } = require('../helpers/fixtures');

describe('OracleConsensus: early-message buffer for F7', function () {

    let hub, pm, oc, oracleRound;
    // Each entry needs its signing key: votes are tallied by key, so a validator
    // with no key casts nothing.
    const VALSET = [
        { addr: 'ws://val-a:10001', pubkey: 'a1'.repeat(32) },
        { addr: 'ws://val-b:10002', pubkey: 'b2'.repeat(32) },
        { addr: 'ws://val-c:10003', pubkey: 'c3'.repeat(32) },
    ];
    // round % 3 === 0 → leader is VALSET[0]
    const ROUND  = 300;
    const PRICES = [{ coinPair: 'BTC/USD', price: '100.00000000' }];

    function proposeEnvelope(digest) {
        return {
            type:   'ORACLE_PROPOSE',
            sender: VALSET[0].addr,
            sig_pubkey: VALSET[0].pubkey,
            data:   { round: ROUND, prices: PRICES, digest, btcBlockHeight: 1000, btcBlockTime: 1700000000 }
        };
    }
    function voteEnvelope(type, sender, digest) {
        let v = VALSET.find(x => x.addr === sender);
        // Senders outside VALSET (the flood case) still need a distinct admissible
        // key: the buffer cap only has something to cap once a vote is countable.
        return { type, sender, sig_pubkey: v ? v.pubkey : pubkeyForTestSender(sender),
                 data: { round: ROUND, digest } };
    }

    beforeEach(function () {
        hub = createMockHub({ validatorAddr: VALSET[1].addr }); // we are val-b (follower)
        pm  = hub._peerManager;
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALSET);
        // Finalized history for the proposed pair so the unverifiable-pair
        // co-sign gate stays out of the way; buffering mechanics are under test.
        oc._lastFinalizedPrices = new Map([['BTC/USD', '100.00000000']]);
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
        expect(pending.prepares.has(VALSET[2].pubkey)).to.be.true;  // replayed
        expect(pending.commits.has(VALSET[2].pubkey)).to.be.true;   // replayed
    });

    it('reaches commit quorum from replayed votes alone (the missed-round scenario)', async function () {
        let digest = oc._digest(ROUND, PRICES);

        // Both peers' COMMITs arrive while our PROPOSE handling is delayed.
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[0].addr, digest));
        oc._handleCommit(voteEnvelope('ORACLE_COMMIT', VALSET[2].addr, digest));

        await oc._handlePropose(proposeEnvelope(digest));
        // _checkCommitQuorum stores via async db call; let it settle.
        await new Promise(r => setImmediate(r));

        // quorum for N=3 is 2. replayed commits must finalize the round.
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
        expect(pending.commits.has(VALSET[2].pubkey)).to.be.true;
        expect(oc.earlyMessages.has(ROUND)).to.be.false;
    });

    it('bounds the number of distinct buffered rounds (memory-DoS guard, FIFO evict)', function () {
        // A Byzantine peer streams votes with fresh attacker-chosen round numbers.
        // The distinct-round count must stay capped and evict the oldest first.
        oc.earlyMessageMaxRounds = 8;
        for (let r = 0; r < 100; r++) {
            oc._bufferEarlyMessage(r, voteEnvelope('ORACLE_PREPARE', VALSET[2].addr, 'd' + r));
        }
        expect(oc.earlyMessages.size).to.equal(8);
        // FIFO: only the newest 8 round keys survive (92..99); round 0 evicted.
        expect(oc.earlyMessages.has(0)).to.be.false;
        expect(oc.earlyMessages.has(99)).to.be.true;
        expect(oc.earlyMessages.has(92)).to.be.true;
        // TTL map does not leak past the eviction bound either.
        expect(oc.earlyMessageTtl.size).to.equal(8);
    });
});
