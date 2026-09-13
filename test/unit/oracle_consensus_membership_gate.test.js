'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: the oracle round sizes its quorum from
// the price capability snapshot, so submissions and count-mode votes must be
// restricted to SNAPSHOT MEMBERS and tallied by VERIFIED PUBKEY, not raw
// envelope.sender. A merely-registered validator (no qualifying stake), or a
// second addr bound to a key that already participated, must not reach the
// trimmed median, the minSubmissions floor, or the PREPARE/COMMIT quorum.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const OracleRound     = require('../../src/OracleRound');
const { createMockHub } = require('../helpers/mockHub');
const { VALIDATORS_3, makeValidator, buildSubmissions, pubkeyForTestSender } = require('../helpers/fixtures');

const NONMEMBER = makeValidator(9); // registered, but NOT in the price snapshot

function registryFor(validators) {
    let m = new Map();
    for (let v of validators) m.set(v.addr, v.pubkey);
    return m;
}

function snapshotOf(validators, blockIndex) {
    return {
        capability: 'price',
        blockIndex: blockIndex,
        count:      validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100' }))
    };
}

describe('OracleConsensus: snapshot membership gate (Oracle M1)', function () {
    let hub, pm, oc, oracleRound;
    // the leader now derives from the locked snapshot (validators 1+2),
    // so round 2 -> sorted-pubkeys[2 % 2] = validator-1 (this hub).
    const ROUND = 2;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorAddr    = VALIDATORS_3[0].addr;
        pm.validatorPubkeys = registryFor([...VALIDATORS_3, NONMEMBER]);
        // Own identity = validator-1's registered pubkey so self resolves consistently.
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[0].pubkey);
        // Count-mode snapshot: only validators 1+2 qualify for `price`.
        hub.capabilitySnapshot = {
            getSnapshot:       sinon.stub().resolves(snapshotOf(VALIDATORS_3.slice(0, 2), 100)),
            getWeightSnapshot: sinon.stub().resolves(null),
            getQuorum:         sinon.stub().returns(2)
        };
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()), priceFetcher: null };
        oc = new OracleConsensus(hub, oracleRound);
        oc.setValidatorSet(VALIDATORS_3);
    });

    afterEach(function () { sinon.restore(); });

    it('finalizeRound excludes a non-member submission from the proposed aggregate', async function () {
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
            { sender: VALIDATORS_3[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
            // Registered but unstaked outlier trying to drag the median.
            { sender: NONMEMBER.addr,       prices: [{ coinPair: 'BTC/USD', price: '999999' }] }
        ]));
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(pm.broadcast.calledOnce).to.be.true;
        let [type, data] = pm.broadcast.firstCall.args;
        expect(type).to.equal('ORACLE_PROPOSE');
        expect(data.submissionKeys).to.not.include(NONMEMBER.addr);
        expect(data.prices.find(p => p.coinPair === 'BTC/USD').price).to.equal('100000.00000000');
    });

    it('finalizeRound skips the round when member submissions fall below minSubmissions', async function () {
        let skipped = sinon.stub(oc, '_storeSkippedRound').resolves();
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
            // Two non-members padding the raw count past minSubmissions=2.
            { sender: NONMEMBER.addr,       prices: [{ coinPair: 'BTC/USD', price: '100001' }] },
            { sender: makeValidator(8).addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
        ]));
        pm.validatorPubkeys.set(makeValidator(8).addr, makeValidator(8).pubkey);
        await oc.finalizeRound(ROUND, 100, 1700000000);
        expect(pm.broadcast.called).to.be.false;
        expect(skipped.calledOnce).to.be.true;
        expect(skipped.firstCall.args[3]).to.match(/member/);
    });

    it('count-mode quorum ignores votes from senders outside the snapshot', function () {
        let pending = {
            weighted: false, quorum: 2, signatures: new Map(),
            memberPubkeys: new Set([VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey])
        };
        // One member + two non-member votes: quorum NOT met.
        let votes = new Set([VALIDATORS_3[0].pubkey, NONMEMBER.pubkey, makeValidator(8).pubkey]);
        expect(oc._quorumMet(pending, votes)).to.be.false;
        // Second member joins: met.
        votes.add(VALIDATORS_3[1].pubkey);
        expect(oc._quorumMet(pending, votes)).to.be.true;
    });

    it('count-mode quorum counts one key once however many addrs carried it', function () {
        let twinAddr = 'ws://validator-1-twin:10001';
        pm.validatorPubkeys.set(twinAddr, VALIDATORS_3[0].pubkey); // same KEY, second addr
        let pending = {
            weighted: false, quorum: 2, signatures: new Map(),
            memberPubkeys: new Set([VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey])
        };
        let votes = new Set([VALIDATORS_3[0].addr, twinAddr]);
        expect(oc._quorumMet(pending, votes)).to.be.false; // one distinct key, not two
    });

    it('legacy behavior preserved when no snapshot is available (memberPubkeys null)', function () {
        let pending = { weighted: false, quorum: 2, signatures: new Map(), memberPubkeys: null };
        let votes = new Set([VALIDATORS_3[0].addr, NONMEMBER.addr]);
        expect(oc._quorumMet(pending, votes)).to.be.true; // raw sender count, unchanged
    });

    // item 4941: price_snapshots.validator_count is the endorsement breadth operators,
    // the indexer mirror and getpricesnapshots read, so it must be the tally that
    // finalized the round - distinct qualified member pubkeys - not the raw addr-keyed
    // prepare set, which a twin addr or a registered non-member inflates.
    it('records validator_count as the deduped member tally, not the raw prepare set', async function () {
        let twinAddr = 'ws://validator-1-twin:10001';
        pm.validatorPubkeys.set(twinAddr, VALIDATORS_3[0].pubkey); // same KEY, second addr
        let store = sinon.stub(oc, '_storeSnapshot').resolves();
        oc.pendingRounds.set(ROUND, {
            round:          ROUND,
            weighted:       false,
            quorum:         2,
            memberPubkeys:  new Set([VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey]),
            // Prepare KEYS: two members plus a registered non-member the quorum never
            // counts. The twin addr contributed no extra entry, because it carried a key
            // that had already voted.
            prepares:       new Set([VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey, NONMEMBER.pubkey]),
            commits:        new Set([VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey]),
            signatures:     new Map(),
            prices:         [{ coinPair: 'BTC/USD', price: '100000' }],
            btcBlockHeight: 100,
            btcBlockTime:   1700000000,
            finalized:      true
        });

        await oc._finalizeCommittedRound(ROUND);

        expect(store.calledOnce).to.be.true;
        expect(store.firstCall.args[2]).to.equal(2);
    });

    it('_handlePropose locks memberPubkeys on the pending round', async function () {
        // Follower view: validator-2 is this hub; leader (validator-1) proposes.
        pm.validatorAddr = VALIDATORS_3[1].addr;
        hub._identity.getPubkeyHex.returns(VALIDATORS_3[1].pubkey);
        let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
        oracleRound.getSubmissions.returns(buildSubmissions([
            { sender: VALIDATORS_3[1].addr, prices: prices }
        ]));
        await oc._handlePropose({ sender: VALIDATORS_3[0].addr, sig_pubkey: VALIDATORS_3[0].pubkey, data: {
            round: ROUND, prices, digest: oc._digest(ROUND, prices),
            btcBlockHeight: 100, btcBlockTime: 1700000000
        } });
        let pending = oc.pendingRounds.get(ROUND);
        expect(pending).to.exist;
        expect(pending.memberPubkeys).to.be.instanceOf(Set);
        expect([...pending.memberPubkeys]).to.have.members(
            [VALIDATORS_3[0].pubkey, VALIDATORS_3[1].pubkey]);
        // A non-member PREPARE must not advance the round to COMMIT quorum.
        oc._handlePrepare({ sender: NONMEMBER.addr, sig_pubkey: NONMEMBER.pubkey, data: { round: ROUND, digest: pending.digest } });
        expect(pending.finalized).to.be.false;
    });
});

describe('OracleRound: submission ingest dedup by verified pubkey (Oracle M1)', function () {
    let hub, pm, round;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        pm.validatorAddr = VALIDATORS_3[0].addr;
        pm.validatorPubkeys = registryFor(VALIDATORS_3);
        round = new OracleRound(hub);
        round.currentRound = 7;
        round.roundStartTime = Date.now();
        round.submissions.set(7, new Map());
    });

    afterEach(function () { sinon.restore(); });

    // sigPubkey defaults to a key unique to this sender; a test that wants two
    // senders to share ONE signing key passes it explicitly.
    function submit(sender, price, sigPubkey) {
        round._handleMessage({
            type: 'ORACLE_PRICE_SUBMIT',
            sender: sender,
            sig_pubkey: sigPubkey || pubkeyForTestSender(sender),
            timestamp: Date.now(),
            data: { round: 7, prices: [{ coinPair: 'BTC/USD', price: price }], sources: 2 }
        });
    }

    it('drops a second submission from a different addr bound to the same pubkey', function () {
        let twinAddr = 'ws://validator-2-twin:10001';
        pm.validatorPubkeys.set(twinAddr, VALIDATORS_3[1].pubkey);
        submit(VALIDATORS_3[1].addr, '100000');
        submit(twinAddr, '999999', VALIDATORS_3[1].pubkey);   // second addr, SAME key
        let subs = round.getSubmissions(7);
        expect(subs.size).to.equal(1);
        expect(subs.has(VALIDATORS_3[1].addr)).to.be.true;
        expect(subs.has(twinAddr)).to.be.false;
    });

    it('stamps the verified pubkey on recorded submissions', function () {
        submit(VALIDATORS_3[1].addr, '100000');
        let sub = round.getSubmissions(7).get(VALIDATORS_3[1].addr);
        expect(sub.pubkey).to.equal(VALIDATORS_3[1].pubkey.toLowerCase());
    });

    it('still accepts distinct validators normally', function () {
        submit(VALIDATORS_3[1].addr, '100000');
        submit(VALIDATORS_3[2].addr, '100050');
        expect(round.getSubmissions(7).size).to.equal(2);
    });
});
