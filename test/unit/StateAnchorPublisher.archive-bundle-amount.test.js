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

// Regression guard for the frozen-amount predicate in
// StateAnchorPublisher._verifyArchiveAgainstLocal (finding #6126).
//
// RewardTracker._recordAnchorRewardLocked derives THREE frozen forms
// (anchor_<CHAIN>, anchor_bundle, anchor_archive); the archive co-sign verifier
// carried only two, so an anchor_bundle row fell through to the operator-tunable
// ANCHOR_REWARD_PER_PUBLISH. anchor_bundle is the only per-anchor reward the v0 bundle
// rail records, so on any hub whose knob is not the frozen '10.00000000' every
// follower refused to co-sign a correct archive and the round stalled below quorum.
//
// The knob is deliberately set to a NON-frozen value here: that is what makes the
// two branches distinguishable. With the fixture's knob equal to the frozen
// constant these assertions pass either way and prove nothing.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');

const PK        = 'cc'.repeat(32);
const ROUND     = 970000;   // snapshot_block, at/above every testnet flag-day (threshold 0)
const BLOCK     = 970000;
const FROZEN    = '10.00000000';
const KNOB      = '7.50000000';   // an operator override that is NOT the frozen constant
const NETWORK   = 'testnet';

function srcOf(pk) { return 'src_' + String(pk).toLowerCase().substring(0, 12); }

function makePublisher(rewardType, localAmount) {
    const localRows = [{
        validator_pubkey: PK, reward_type: rewardType, round_number: ROUND,
        amount: localAmount, block_index: BLOCK
    }];
    const db = {
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT validator_pubkey, amount, block_index FROM validator_rewards')) {
                return localRows.filter(r =>
                    r.reward_type === params[0] && Number(r.round_number) === Number(params[1]));
            }
            return [];
        }
    };
    const setRows = [{ pubkey: PK, amount: '1', weight: '1', source: srcOf(PK) }];
    const hub = {
        db,
        network: NETWORK,
        p2pConfig: { ANCHOR_ENABLED: 'false' },
        capabilitySnapshot: {
            async getSnapshot()       { return { validators: setRows }; },
            async getWeightSnapshot() { return { validators: setRows }; }
        },
        rewardTracker: {
            anchorReward: KNOB,
            resolveSourceByPubkey: async (pk) => srcOf(pk)
        }
    };
    return new StateAnchorPublisher(hub);
}

const verify = async (pub, reward) => {
    let set   = await pub._resolveCapabilitySet('oracle_publish', BLOCK, NETWORK);
    let snaps = set.map(v => ({ snapshot_block: BLOCK, capability: 'oracle_publish',
                                signing_pubkey: v.pubkey, amount: v.amount, source: v.source }));
    return pub._verifyArchiveAgainstLocal({
        network: NETWORK, matches: [], calls: [], rewards: [reward], capability_snapshots: snaps
    });
};

function archivedReward(rewardType, amount) {
    return {
        validator_pubkey: PK, source: srcOf(PK), round_number: ROUND,
        reward_type: rewardType, amount: amount, block_index: BLOCK
    };
}

describe('StateAnchorPublisher #6126 archive frozen-amount predicate covers anchor_bundle', function () {

    it('co-signs a frozen-amount anchor_bundle row on a hub whose reward knob is overridden', async function () {
        // The producer wrote ar.ANCHOR_REWARD_AMOUNT; the verifier must expect the
        // same constant, not this hub's ANCHOR_REWARD_PER_PUBLISH.
        const pub = makePublisher('anchor_bundle', FROZEN);
        expect(await verify(pub, archivedReward('anchor_bundle', FROZEN))).to.equal(true);
    });

    it('refuses an anchor_bundle row carrying the operator knob instead of the frozen amount', async function () {
        // The inverse direction: a leader running the override must not get the
        // non-frozen amount sanctioned into COLLECT-relevant archived bookkeeping.
        const pub = makePublisher('anchor_bundle', KNOB);
        expect(await verify(pub, archivedReward('anchor_bundle', KNOB))).to.equal(false);
    });

    it('still holds the same rule for the per-chain form it replaced', async function () {
        const pub = makePublisher('anchor_BTC', FROZEN);
        expect(await verify(pub, archivedReward('anchor_BTC', FROZEN))).to.equal(true);
    });

    it('still holds the same rule for anchor_archive', async function () {
        const pub = makePublisher('anchor_archive', FROZEN);
        expect(await verify(pub, archivedReward('anchor_archive', FROZEN))).to.equal(true);
    });
});
