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
// A price_retraction names the round window of each PRICE batch the indexer rolled back.
// A hub that finalized every round of a batch itself holds no row stored from it, so the
// batch-row join finds nothing there; the window clears the landing clock on every round
// inside it, whatever path stored the round, on every hub the retraction reaches.

const sinon                = require('sinon');
const { expect }           = require('chai');
const {
    HELD_ROUND, BATCH_ROUND, ACTION_INDEX, BLOCK_TIME, BATCH_SIGNERS,
    copy, isBatchProof, pushPriceBatch, leaderArchive, stamps, makeHubs: makeTwoHubs
} = require('../../../../../helpers/follower_landing_hubs.js');
const { buildFeedReorgRpc } = require('../../../../../../src/api/rpc/feed_reorg.js');

let leader, follower;

function makeHubs() {
    ({ leader, follower } = makeTwoHubs());
}

// A batch carrying only the round both hubs already finalized over P2P: every round is a
// duplicate on every hub, so no hub stores a row from the batch itself.
function pushFullyFinalizedBatch(agg) {
    let push = pushPriceBatch(agg);
    let round = push.rounds[0];
    let payload = agg.buildPriceBatchPayload(HELD_ROUND, HELD_ROUND, round.btc_block_height, [{
        round: round.round, timestamp: round.timestamp, btcBlockHeight: round.btc_block_height, pairs: round.pairs
    }]);
    return Object.assign(push, {
        last_round: HELD_ROUND, btc_block_height: round.btc_block_height, rounds: [round],
        sigs: BATCH_SIGNERS.map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
    });
}

async function landFullyFinalizedBatchOnBoth() {
    let push = pushFullyFinalizedBatch(leader.agg);
    for (let hub of [leader, follower]) {
        expect(await hub.agg.receiveValidatedBatch('DOGE', copy(push)))
            .to.deep.equal({ accepted: true, stored: 0, duplicates: 1, rejected: 0 });
        expect(stamps(hub, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
        expect(hub.table.rows.some(r => isBatchProof(r.consensus_proof))).to.equal(false);
    }
}

async function aFullyFinalizedBatchThenTest9() {
    await landFullyFinalizedBatchOnBoth();
    // A retraction naming no window cannot find the batch: no hub holds a row from it.
    for (let hub of [leader, follower]) {
        expect((await hub.agg.retractFromActionIndex('DOGE', ACTION_INDEX, undefined, 0)).error).to.equal(undefined);
        expect(stamps(hub, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
    }

    // The rollback's price_retraction names the batch window, on every hub alike.
    for (let hub of [leader, follower]) {
        let emitted = [];
        hub.agg.on('row:inserted', evt => emitted.push(evt));
        let result = await hub.agg.retractFromActionIndex('DOGE', ACTION_INDEX, undefined, 0,
            [{ first_round: HELD_ROUND, last_round: HELD_ROUND }]);
        expect(result.error).to.equal(undefined);
        expect(stamps(hub, HELD_ROUND)).to.deep.equal([0, 0]);
        // The reset rows are re-emitted whole so every mirror clears them too.
        expect(emitted.map(e => [e.row.round_number, e.row.batch_block_time])).to.deep.equal([[HELD_ROUND, 0], [HELD_ROUND, 0]]);
    }

    let archived = await leaderArchive(leader);
    expect(await follower.pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(true);
}

async function aWindowResetLeavesRoundsTest10() {
    let push = pushPriceBatch(leader.agg);
    for (let hub of [leader, follower]) await hub.agg.receiveValidatedBatch('DOGE', copy(push));
    // A window naming only the batch-only round leaves the held round's stamp alone.
    let result = await follower.agg.retractFromActionIndex('DOGE', ACTION_INDEX + 1, undefined, 0,
        [{ first_round: BATCH_ROUND, last_round: BATCH_ROUND }]);
    expect(result.error).to.equal(undefined);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
}

async function aMalformedWindowListIsTest11() {
    await landFullyFinalizedBatchOnBoth();
    for (let bad of [{}, 'x', [{ first_round: 5, last_round: 4 }], [{ first_round: 'a', last_round: 9 }], [null],
                     new Array(1001).fill({ first_round: 1, last_round: 1 })]) {
        expect(await follower.agg.retractFromActionIndex('DOGE', ACTION_INDEX, undefined, 0, bad))
            .to.deep.equal({ error: 'invalid batches' });
    }
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
}

async function pushpricereorgHandsTheTest12() {
    await landFullyFinalizedBatchOnBoth();
    let rpc = buildFeedReorgRpc({ hub: { priceAggregator: follower.agg } });
    let result = await rpc.pushpricereorg({ source_chain: 'DOGE', from_action_index: ACTION_INDEX,
        retraction_generation: 0, batches: [{ first_round: HELD_ROUND, last_round: HELD_ROUND }] });
    expect(result.error).to.equal(undefined);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);
}

function retractedBatchWindowSuite1() {
    beforeEach(makeHubs);
    afterEach(function () { sinon.restore(); });
    it('a fully finalized batch then a retraction naming its window resets the stamp on every hub', aFullyFinalizedBatchThenTest9);
    it('a retracted window clears only the rounds inside it', aWindowResetLeavesRoundsTest10);
    it('a malformed retracted batch window list is refused and resets nothing', aMalformedWindowListIsTest11);
    it('pushpricereorg hands the batch windows to the retraction', pushpricereorgHandsTheTest12);
}

describe('PriceAggregator batch landing clock retraction windows @regression', retractedBatchWindowSuite1);
