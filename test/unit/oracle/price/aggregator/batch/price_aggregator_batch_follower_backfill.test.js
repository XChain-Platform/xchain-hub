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
//
// A follower whose price rounds predate the batch push fan-out holds batch_block_time 0
// where the leader stamped. Before judging an archive it back-fills those clocks from the
// DOGE indexer's getpricebatches (the landing block and its protocol time, paged) through
// stampBatchLanding, and samePriceRow then agrees; the compare itself stays strict.

const sinon                = require('sinon');
const { expect }           = require('chai');
const {
    HELD_ROUND, BATCH_ROUND, BLOCK_INDEX, ACTION_INDEX, BLOCK_TIME,
    pushPriceBatch, leaderArchive, stamps, makeHubs: makeTwoHubs
} = require('../../../../../helpers/follower_landing_hubs.js');

let leader, follower;

function makeHubs() {
    ({ leader, follower } = makeTwoHubs());
}

// The DOGE indexer's getpricebatches answer for the one landed batch, as a page.
function landedBatchesAnswer(overrides) {
    return Object.assign({
        block_index: BLOCK_INDEX + 5, first_round: HELD_ROUND, last_round: HELD_ROUND,
        batches: [{ action_index: ACTION_INDEX, first_round: HELD_ROUND, last_round: BATCH_ROUND,
                    round_count: 2, block_index: BLOCK_INDEX, block_time: BLOCK_TIME }],
        truncated: false
    }, overrides || {});
}

// A follower whose rounds predate the push fan-out: the leader got the push, it did not.
async function aLeaderStampedArchive() {
    let push = pushPriceBatch(leader.agg);
    expect((await leader.agg.receiveValidatedBatch('DOGE', push)).accepted).to.equal(true);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);
    return leaderArchive(leader);
}

async function aFollowerHoldingPreTest5() {
    let archived = await aLeaderStampedArchive();
    let call = sinon.stub(follower.pub, 'indexerCall').resolves(landedBatchesAnswer());

    expect(await follower.pub.verifyArchivedPriceSnapshots(archived, { network: 'regtest' })).to.equal(true);
    expect(call.args).to.deep.equal([['DOGE', 'getpricebatches',
        { first_round: HELD_ROUND, last_round: HELD_ROUND, limit: 1000 }]]);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal(stamps(leader, HELD_ROUND));
    // A second archive finds nothing at 0 and asks the indexer nothing.
    expect(await follower.pub.verifyArchivedPriceSnapshots(archived, { network: 'regtest' })).to.equal(true);
    expect(call.callCount).to.equal(1);
}

async function theBackFillKeepsTheTest6() {
    let archived = await aLeaderStampedArchive();
    sinon.stub(follower.pub, 'indexerCall').resolves(landedBatchesAnswer());
    let row = follower.table.rows.find(r => r.round_number === HELD_ROUND);
    row.price = String(row.price) + '1';

    expect(await follower.pub.verifyArchivedPriceSnapshots(archived, { network: 'regtest' })).to.equal(false);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
    expect(console.warn.args.flat().join(' ')).to.match(/archive price 200\/\S+ differs from our row/);
}

async function anAnswerWithoutTheTest7() {
    let archived = await aLeaderStampedArchive();
    let unresolved = landedBatchesAnswer();
    delete unresolved.batches[0].block_time;
    sinon.stub(follower.pub, 'indexerCall').resolves(unresolved);

    expect(await follower.pub.verifyArchivedPriceSnapshots(archived, { network: 'regtest' })).to.equal(false);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);

    follower.pub.indexerCall.rejects(new Error('indexer down'));
    expect(await follower.pub.verifyArchivedPriceSnapshots(archived, { network: 'regtest' })).to.equal(false);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);
}

async function aTruncatedPageIsTest8() {
    let page = (first, last, truncated) => landedBatchesAnswer({ truncated, batches: [first, first + 50].map((f, i) => ({
        action_index: 10 + i, first_round: f, last_round: f + 1, round_count: 2,
        block_index: BLOCK_INDEX + f, block_time: BLOCK_TIME + f })) });
    let call = sinon.stub(follower.pub, 'indexerCall');
    call.onCall(0).resolves(page(100, 300, true));
    call.onCall(1).resolves(page(200, 300, false));

    let landings = await follower.pub.fetchPriceBatchLandings(100, 300);
    expect(call.args.map(c => c[2].first_round)).to.deep.equal([100, 150]);
    expect(landings.batches.map(b => b.first)).to.deep.equal([100, 150, 200, 250]);
    expect(landings.completeBelow).to.equal(301);

    // A full page that cannot advance answers only below where it started.
    call.resetHistory();
    call.resolves(page(100, 300, true));
    expect((await follower.pub.fetchPriceBatchLandings(150, 300)).completeBelow).to.equal(150);
}

function followerHubLandingBackfillSuite1() {
    beforeEach(makeHubs);
    afterEach(function () { sinon.restore(); });
    it('a follower holding pre-push rounds back-fills the landing clock from the indexer and co-signs the leader archive', aFollowerHoldingPreTest5);
    it('the back-fill keeps the strict compare: a row differing in another column is still refused', theBackFillKeepsTheTest6);
    it('an indexer answer without the landing clock, or no answer, stamps nothing and the follower still refuses', anAnswerWithoutTheTest7);
    it('a truncated getpricebatches page is followed by the next page, and a page that cannot advance stops there', aTruncatedPageIsTest8);
}

describe('PriceAggregator batch landing clock back-fill on a follower hub @regression', followerHubLandingBackfillSuite1);
