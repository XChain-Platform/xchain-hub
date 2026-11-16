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
// A retracted PRICE batch window that carries its landing's clock clears only the rounds
// holding that clock. A round keeps the earliest clock of every landing that carried it,
// so a round stamped earlier by a landing that is still canonical (an overlapping batch,
// or the same rounds landed on another chain) keeps its stamp and is not re-emitted.

const sinon                = require('sinon');
const { expect }           = require('chai');
const {
    HELD_ROUND, ACTION_INDEX, BLOCK_TIME, BATCH_SIGNERS,
    copy, pushPriceBatch, stamps, makeHubs
} = require('../../../../../helpers/follower_landing_hubs.js');
const { buildFeedReorgRpc } = require('../../../../../../src/api/rpc/feed_reorg.js');

// The retracted landing came later than the one whose clock the round holds.
const LATER_CLOCK = BLOCK_TIME + 600;

let follower;

// Every round of the batch is one the hub already finalized, so the stamp sits on a
// self-finalized row and only the window path can reach it.
async function landHeldRound() {
    sinon.restore();
    ({ follower } = makeHubs());
    let push = pushPriceBatch(follower.agg);
    let round = push.rounds[0];
    let payload = follower.agg.buildPriceBatchPayload(HELD_ROUND, HELD_ROUND, round.btc_block_height, [{
        round: round.round, timestamp: round.timestamp, btcBlockHeight: round.btc_block_height, pairs: round.pairs
    }]);
    Object.assign(push, {
        last_round: HELD_ROUND, btc_block_height: round.btc_block_height, rounds: [round],
        sigs: BATCH_SIGNERS.map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
    });
    await follower.agg.receiveValidatedBatch('DOGE', copy(push));
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
}

async function retractWindow(window) {
    let emitted = [];
    follower.agg.on('row:inserted', evt => emitted.push(evt.row.round_number));
    let result = await follower.agg.retractFromActionIndex('DOGE', ACTION_INDEX, undefined, 0, [window]);
    expect(result.error).to.equal(undefined);
    return emitted;
}

async function survivingEarlierClockIsKept() {
    await landHeldRound();
    let emitted = await retractWindow({ first_round: HELD_ROUND, last_round: HELD_ROUND, block_time: LATER_CLOCK });
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
    expect(emitted).to.deep.equal([]);
}

async function retractedOwnClockIsCleared() {
    await landHeldRound();
    let emitted = await retractWindow({ first_round: HELD_ROUND, last_round: HELD_ROUND, block_time: BLOCK_TIME });
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([0, 0]);
    expect(emitted).to.deep.equal([HELD_ROUND, HELD_ROUND]);
}

async function unusableClockClearsTheWindow() {
    for (let bad of [0, -5, 1.5, 'x', '12abc', true, {}]) {
        await landHeldRound();
        let emitted = await retractWindow({ first_round: HELD_ROUND, last_round: HELD_ROUND, block_time: bad });
        expect(stamps(follower, HELD_ROUND), String(bad)).to.deep.equal([0, 0]);
        expect(emitted).to.deep.equal([HELD_ROUND, HELD_ROUND]);
    }
}

async function digitStringClockIsHonoured() {
    await landHeldRound();
    await retractWindow({ first_round: HELD_ROUND, last_round: HELD_ROUND, block_time: String(LATER_CLOCK) });
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
}

async function rpcForwardsTheClock() {
    await landHeldRound();
    let rpc = buildFeedReorgRpc({ hub: { priceAggregator: follower.agg } });
    let result = await rpc.pushpricereorg({ source_chain: 'DOGE', from_action_index: ACTION_INDEX, retraction_generation: 0,
        batches: [{ first_round: HELD_ROUND, last_round: HELD_ROUND, block_time: LATER_CLOCK }] });
    expect(result.error).to.equal(undefined);
    expect(stamps(follower, HELD_ROUND)).to.deep.equal([BLOCK_TIME, BLOCK_TIME]);
}

describe('PriceAggregator retracted batch window landing clock', function () {
    afterEach(function () { sinon.restore(); });
    it('keeps a round stamped earlier by a landing that is still canonical and does not re-emit it', survivingEarlierClockIsKept);
    it('clears and re-emits a round holding the retracted landing clock', retractedOwnClockIsCleared);
    it('treats an unusable clock as absent and clears the whole window without refusing', unusableClockClearsTheWindow);
    it('reads a digit-string clock as the number it spells', digitStringClockIsHonoured);
    it('pushpricereorg forwards each window clock to the retraction', rpcForwardsTheClock);
});
