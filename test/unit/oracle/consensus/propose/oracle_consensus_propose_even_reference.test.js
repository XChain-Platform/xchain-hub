'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: in an odd round a follower drops the proposer's submission and is left
// with an even set. An honest leader's median of the full set is the lower middle, the
// upper middle, or its own value between them, never their mean, so the follower measures
// the band to both middles. Measured to the mean, a leader whose own submission is the
// median stalled the round: N=3 with 1.0 (leader), 1.0, 1.104 had every follower withhold.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../../src/oracle/consensus');
const devband          = require('../../../../../src/consensus/deviation_band.js');
const { ORACLE_DEVIATION_THRESHOLD } = require('../../../../../src/constants.js');
const { createMockHub } = require('../../../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, buildSubmissions, makeCapabilitySnapshotStub } =
    require('../../../../helpers/fixtures');

const PAIR  = 'BTC/USD';
const ROUND = 1;

function makeEngine(validators, lastFinalized) {
    let hub = createMockHub();
    hub._peerManager.validatorPubkeys = new Set();
    hub.capabilitySnapshot = makeCapabilitySnapshotStub(validators);
    let oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
    let oc = new OracleConsensus(hub, oracleRound);
    oc.setValidatorSet(validators);
    if (lastFinalized) oc._lastFinalizedPrices = new Map([[PAIR, lastFinalized]]);
    return { hub, oc, oracleRound };
}

// The round's submissions: the leader holds prices[0], the other validators the rest in order.
function roundSubmissions(validators, prices) {
    let leader = makeEngine(validators).oc.getLeader(ROUND);
    let others = validators.filter(v => v.addr !== leader.addr);
    let entries = [{ sender: leader.addr, pubkey: leader.pubkey, prices: [{ coinPair: PAIR, price: prices[0] }] }]
        .concat(others.map((v, i) => ({ sender: v.addr, pubkey: v.pubkey, prices: [{ coinPair: PAIR, price: prices[i + 1] }] })));
    return { leader, others, subs: buildSubmissions(entries) };
}

// One follower's verdict on `proposed`: whether it co-signed, and every reject event.
async function followerVerdict(validators, round, follower, proposed, lastFinalized) {
    let { hub, oc, oracleRound } = makeEngine(validators, lastFinalized);
    hub._peerManager.validatorAddr = follower.addr;
    oracleRound.getSubmissions.returns(round.subs);
    let rejects = [];
    oc.on('oracle:propose-rejected', e => rejects.push(e));
    let prices = [{ coinPair: PAIR, price: proposed }];
    await oc.handlePropose({ sender: round.leader.addr, sig_pubkey: round.leader.pubkey, data: {
        round: ROUND, prices, digest: oc.digest(ROUND, prices), btcBlockHeight: 100, btcBlockTime: 1700000000 } });
    return { cosigned: oc.pendingRounds.has(ROUND), rejects };
}

// What the honest leader proposes for these submissions, and how many followers co-sign it.
async function honestRound(validators, prices, lastFinalized) {
    let round = roundSubmissions(validators, prices);
    let leaderOc = makeEngine(validators, lastFinalized).oc;
    let proposed = leaderOc.aggregateAll(round.subs).map(a => a.price)[0];
    let verdicts = [];
    for (let f of round.others) verdicts.push(await followerVerdict(validators, round, f, proposed, lastFinalized));
    return { proposed, cosigners: verdicts.filter(v => v.cosigned).length, verdicts };
}

describe('OracleConsensus co-sign gate: an even reference set is measured to both middles', function () {
    afterEach(function () { sinon.restore(); });

    it('co-signs an honest N=3 leader whose own submission is the median', async function () {
        let r = await honestRound(VALIDATORS_3, ['1.00000000', '1.00000000', '1.10400000']);
        expect(r.proposed).to.equal('1.00000000');
        expect(r.verdicts.map(v => v.rejects.map(e => e.reason))).to.deep.equal([[], []]);
        expect(r.cosigners).to.equal(2);
    });

    it('co-signs an honest N=7 leader in the larger camp of a 4-vs-3 split', async function () {
        let r = await honestRound(VALIDATORS_7, ['1.00000000', '1.00000000', '1.10400000', '1.00000000',
            '1.10400000', '1.00000000', '1.10400000'], '1.00000000');
        expect(r.proposed).to.equal('1.00000000');
        expect(r.cosigners).to.equal(6);
    });

    it('co-signs every honest N=3 proposal up to the follower even-split edge, with or without history', async function () {
        for (let hist of [null, '1.00000000']) {
            for (let k = 0; k <= 10500; k += 250) {
                let third = (1 + k / 100000).toFixed(8);
                for (let order of [['1.00000000', '1.00000000', third], [third, '1.00000000', third]]) {
                    let r = await honestRound(VALIDATORS_3, order, hist);
                    sinon.restore();   // each round builds fresh mock hubs; release the last ones
                    expect(r.cosigners, order.join(',') + ' hist=' + hist + ' proposed ' + r.proposed).to.equal(2);
                }
            }
        }
    });
});

describe('OracleConsensus co-sign gate: the both-middles band still bounds a dishonest proposal', function () {
    afterEach(function () { sinon.restore(); });

    // Follower set {1.00000000, 1.10400000}: an honest leader publishes a value in
    // [1.0, 1.104], so the accept window is [1.0/1.05, 1.104/0.95] at the 5% band.
    async function verdictOn(proposed) {
        let round = roundSubmissions(VALIDATORS_3, ['1.00000000', '1.00000000', '1.10400000']);
        return followerVerdict(VALIDATORS_3, round, round.others[0], proposed);
    }

    it('accepts the window edges and refuses one ulp beyond each', async function () {
        expect((await verdictOn('0.95238096')).cosigned, 'just inside 1.0/1.05').to.be.true;
        expect((await verdictOn('1.16210526')).cosigned, 'just inside 1.104/0.95').to.be.true;
        let low  = await verdictOn('0.95238095');
        let high = await verdictOn('1.16210527');
        expect(low.cosigned).to.be.false;
        expect(high.cosigned).to.be.false;
        expect(low.rejects.map(e => [e.reason, e.local])).to.deep.equal([['deviation', '1.00000000']]);
        expect(high.rejects.map(e => [e.reason, e.local])).to.deep.equal([['deviation', '1.10400000']]);
    });

    it('accepts nothing outside the band of a value an honest leader could publish', async function () {
        // Honest medians for this follower set: every 8-decimal value in [1.0, 1.104].
        for (let k = 90000; k <= 120000; k += 137) {
            let proposed = (k / 100000).toFixed(8);
            let v = await verdictOn(proposed);
            sinon.restore();
            let nearestHonest = Number(proposed) < 1 ? '1.00000000'
                : (Number(proposed) > 1.104 ? '1.10400000' : proposed);
            let inBand = !devband.exceedsBand(nearestHonest, proposed, ORACLE_DEVIATION_THRESHOLD, 18);
            expect(v.cosigned, proposed).to.equal(inBand);
        }
    });

    it('keeps an odd reference set measured to its own median (N=4, follower set 1, 1, 1.104)', async function () {
        let round = roundSubmissions(VALIDATORS_4, ['1.00000000', '1.00000000', '1.00000000', '1.10400000']);
        let v = await followerVerdict(VALIDATORS_4, round, round.others[0], '1.06000000');
        expect(v.cosigned).to.be.false;
        expect(v.rejects.map(e => [e.reason, e.local])).to.deep.equal([['deviation', '1.00000000']]);
    });

    it('clamps each middle like the aggregate, so a clamped honest median still co-signs', async function () {
        let r = await honestRound(VALIDATORS_3, ['140.00000000', '140.00000000', '141.00000000'], '100.00000000');
        expect(r.proposed).to.equal('125.00000000');
        expect(r.cosigners).to.equal(2);
    });
});

describe('OracleConsensus co-sign gate: a pair the leader did not submit keeps the mean reference', function () {
    afterEach(function () { sinon.restore(); });

    // Followers hold 1.0 and 1.104 for BTC/USD and the leader priced only LTC/USD, so an
    // honest leader aggregates this same even set and publishes its mean, 1.052. The
    // both-middles window would let a dishonest leader reach 1.104/0.95 with no liveness gain.
    async function verdictOn(proposed) {
        let leader = makeEngine(VALIDATORS_3).oc.getLeader(ROUND);
        let others = VALIDATORS_3.filter(v => v.addr !== leader.addr);
        let subs = buildSubmissions([
            { sender: leader.addr, pubkey: leader.pubkey, prices: [{ coinPair: 'LTC/USD', price: '80.00000000' }] },
            { sender: others[0].addr, pubkey: others[0].pubkey, prices: [{ coinPair: PAIR, price: '1.00000000' }] },
            { sender: others[1].addr, pubkey: others[1].pubkey, prices: [{ coinPair: PAIR, price: '1.10400000' }] }
        ]);
        return followerVerdict(VALIDATORS_3, { leader, others, subs }, others[0], proposed);
    }

    it('co-signs the honest mean and the band edge around it', async function () {
        expect((await verdictOn('1.05200000')).cosigned).to.be.true;
        expect((await verdictOn('1.10736842')).cosigned, 'just inside 1.052/0.95').to.be.true;
        expect((await verdictOn('1.00190477')).cosigned, 'just inside 1.052/1.05').to.be.true;
    });

    it('refuses beyond the band of the mean, where the both-middles window would still accept', async function () {
        for (let [proposed, nearest] of [['1.10736843', '1.05200000'], ['1.16210526', '1.05200000'],
            ['1.00190476', '1.05200000'], ['0.95238096', '1.05200000']]) {
            let v = await verdictOn(proposed);
            expect(v.cosigned, proposed).to.be.false;
            expect(v.rejects.map(e => [e.reason, e.local]), proposed).to.deep.equal([['deviation', nearest]]);
        }
    });
});
