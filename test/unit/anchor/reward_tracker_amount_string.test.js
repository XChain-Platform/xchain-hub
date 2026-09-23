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

// The anchor reward amount is a decimal string end to end: the recorded row carries a
// frozen consensus constant byte-for-byte (the indexer credits and signs it verbatim),
// and the archive co-sign expectation agrees with the recorder on both branches.
//
// The frozen constant is respelled to '12.5' here on purpose: '10.00000000' survives a
// float round-trip unchanged, so with the shipped spelling these assertions prove nothing.

const { expect }           = require('chai');
const ar                   = require('../../../src/consensus/gates/anchor_reward_gate.js');
const RewardTracker        = require('../../../src/anchor/reward_tracker');
const StateAnchorPublisher = require('../../../src/anchor/publisher');
const { createMockHub }    = require('../../helpers/mockHub');

const PK      = 'ab'.repeat(32);
const NETWORK = 'testnet';   // every anchor-reward flag-day is 0 on testnet
const BLOCK   = 970000;

function expectedOnArchive(rewardType, knob) {
    const self = { hub: { rewardTracker: { anchorReward: knob } } };
    return StateAnchorPublisher.prototype.expectedArchivedRewardAmount.call(
        self, { reward_type: rewardType, block_index: BLOCK }, NETWORK);
}

async function recordedAmount(rewardType, knob, network) {
    const rt = new RewardTracker(createMockHub({ p2pConfig: { ANCHOR_REWARD_PER_PUBLISH: knob } }));
    await rt.recordAnchorReward(rewardType, 5, PK, BLOCK, network);
    const insert = rt.db.doQuery.getCalls().find(c => String(c.args[0]).includes('INSERT IGNORE INTO validator_rewards'));
    return insert ? insert.args[1][3] : null;
}

describe('RewardTracker anchor reward amount (decimal string)', function () {
    let savedAnchor, savedArchive;
    beforeEach(function () {
        savedAnchor  = ar.ANCHOR_REWARD_AMOUNT;
        savedArchive = ar.ARCHIVE_REWARD_AMOUNT;
        ar.ANCHOR_REWARD_AMOUNT  = '12.5';
        ar.ARCHIVE_REWARD_AMOUNT = '12.5';
    });
    afterEach(function () {
        ar.ANCHOR_REWARD_AMOUNT  = savedAnchor;
        ar.ARCHIVE_REWARD_AMOUNT = savedArchive;
    });

    for (const rewardType of ['anchor_BTC', 'anchor_bundle', 'anchor_archive']) {
        it(`records the frozen constant verbatim for a derived ${rewardType} reward`, async function () {
            expect(await recordedAmount(rewardType, '7.5', NETWORK)).to.equal('12.5');
            expect(expectedOnArchive(rewardType, '7.5'), 'co-sign expectation').to.equal('12.5');
        });
    }

    it('renders the legacy knob on the 8-decimal grid, identically on both sides', async function () {
        expect(await recordedAmount('anchor_BTC', '2.5', '')).to.equal('2.50000000');
        expect(RewardTracker.legacyAnchorRewardAmount('2.5')).to.equal('2.50000000');
    });

    it('records nothing for a prefix-numeric knob, and co-signs no legacy amount for it', async function () {
        expect(await recordedAmount('anchor_BTC', '10abc', '')).to.equal(null);
        expect(RewardTracker.legacyAnchorRewardAmount('10abc')).to.equal('0.00000000');
    });
});
