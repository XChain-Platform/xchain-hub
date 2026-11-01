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
// A follower hub stamps batch_block_time exactly as the leader does once the same
// pushpricebatch reaches it, and the archive co-sign compare (samePriceRow) then agrees.
//
// The landing clock is written only by receiveValidatedBatch, from the push's own
// block_time, so a hub that never receives the push keeps 0 and refuses the leader's
// archive on that column alone. The indexer delivers every durable push (price_batch and
// price_retraction alike) to each unpinned HUB_SEED_URLS candidate; a node pinned to one
// HUB_API_URL feeds only that hub. These cases run the real ingest, stamp, retraction and
// archive verify code on two hubs, each over its own in-memory price_snapshots table, to
// pin that the push alone carries a follower to the leader's stamp and back to 0 on a
// reorg clear, while a row differing in any other column is still refused.

const sinon                = require('sinon');
const { expect }           = require('chai');
const {
    HELD_ROUND, BATCH_ROUND, ACTION_INDEX, BLOCK_TIME,
    copy, pushPriceBatch, leaderArchive, stamps, makeHubs: makeTwoHubs
} = require('../../../../../helpers/follower_landing_hubs.js');

let leader, follower;

function makeHubs() {
    ({ leader, follower } = makeTwoHubs());
}

async function anUnpushedFollowerRefusesTheTest1() {
    let push = pushPriceBatch(leader.agg);
    expect((await leader.agg.receiveValidatedBatch('DOGE', push)).accepted).to.equal(true);
    expect(stamps(leader, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);

    let archived = await leaderArchive(leader);
    expect(await follower.pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(false);
    expect(console.warn.args.flat().join(' ')).to.match(/archive price 200\/\S+ differs from our row/);
}

async function theSamePushStampsTheFollowerTest2() {
    let push = pushPriceBatch(leader.agg);
    expect((await leader.agg.receiveValidatedBatch('DOGE', push)).accepted).to.equal(true);
    let result = await follower.agg.receiveValidatedBatch('DOGE', copy(push));
    expect(result).to.deep.equal({ accepted: true, stored: 1, duplicates: 1, rejected: 0 });

    expect(stamps(follower, HELD_ROUND)).to.deep.equal(stamps(leader, HELD_ROUND));
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
    expect(stamps(follower, BATCH_ROUND)).to.deep.equal(stamps(leader, BATCH_ROUND));

    let archived = await leaderArchive(leader);
    expect(await follower.pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(true);
}

async function aRowDifferingInAnotherTest3() {
    let push = pushPriceBatch(leader.agg);
    await leader.agg.receiveValidatedBatch('DOGE', push);
    await follower.agg.receiveValidatedBatch('DOGE', copy(push));
    let archived = await leaderArchive(leader);

    let row = follower.table.rows.find(r => r.round_number === HELD_ROUND);
    row.price = String(row.price) + '1';
    expect(await follower.pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(false);

    row.price = archived.find(a => a.coin_pair === row.coin_pair).price;
    row.status = 'disputed';
    expect(await follower.pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(false);
}

async function aReorgClearResetsTheTest4() {
    let push = pushPriceBatch(leader.agg);
    await leader.agg.receiveValidatedBatch('DOGE', push);
    await follower.agg.receiveValidatedBatch('DOGE', copy(push));

    // The rollback's price_retraction, delivered to every candidate hub alike.
    for (let hub of [leader, follower]) {
        let result = await hub.agg.retractFromActionIndex('DOGE', ACTION_INDEX, undefined, 0);
        expect(result.error).to.equal(undefined);
    }

    expect(stamps(leader, HELD_ROUND)).to.deep.equal([0, 0]);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);
    expect(stamps(leader, BATCH_ROUND)).to.deep.equal([]);
    expect(stamps(follower, BATCH_ROUND)).to.deep.equal([]);

    let archived = await leaderArchive(leader);
    expect(await follower.pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(true);
}

function followerHubLandingClockSuite1() {
    beforeEach(makeHubs);
    afterEach(function () { sinon.restore(); });
    it('a follower the push never reached keeps 0 and refuses the leader archive on that column alone', anUnpushedFollowerRefusesTheTest1);
    it('the same push stamps the follower with the leader clock and samePriceRow agrees', theSamePushStampsTheFollowerTest2);
    it('a row differing in another column is still refused once the clocks agree', aRowDifferingInAnotherTest3);
    it('a reorg clear delivered to every hub resets the stamp on each and they still agree', aReorgClearResetsTheTest4);
}

describe('PriceAggregator batch landing clock on a follower hub @regression', followerHubLandingClockSuite1);
