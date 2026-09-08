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

// Pins the archive selector's chain-derived filter and the round's verdict when nothing
// else is pending. Without the filter each archive publish recorded an anchor_archive
// reward that the next flush archived alone: one reward-only ANCHOR per hub restart.

const { expect }           = require('chai');
const StateAnchorPublisher = require('../../src/StateAnchorPublisher');
const ValidatorIdentity    = require('../../src/ValidatorIdentity');
const ar                   = require('../../src/anchor_reward_activation');

const BLOCK = 100;

function mkPub(network, rewardRows, hits){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: {
            async doQuery(sql, params){
                hits.push(sql);
                if(sql.indexOf('FROM validator_rewards WHERE reward_type LIKE') !== -1) return rewardRows;
                return [];
            }
        },
        network, p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ on(){}, removeListener(){}, broadcast(){} }),
        _resolveBtcLatestBlock: async () => BLOCK
    });
    const me = identity.getPubkeyHex().toLowerCase();
    pub._getActiveOraclePublishPubkeys = async () => [me];
    return pub;
}

function row(type, block){
    return { validator_pubkey: 'aa'.repeat(32), reward_type: type, round_number: 1,
             amount: '10.00000000', block_index: block, batch_seq: null };
}

describe('StateAnchorPublisher: chain-derived rewards are not archive cargo', () => {

    describe('_isChainDerivedReward', () => {
        it('marks every anchor reward type derived at/above its flag-day (regtest activates at 0)', () => {
            const pub = mkPub('regtest', [], []);
            for(const t of ['anchor_BTC', 'anchor_LTC', 'anchor_DOGE', 'anchor_bundle', 'anchor_archive'])
                expect(pub._isChainDerivedReward(row(t, 5)), t).to.equal(true);
        });

        it('keeps a row below its flag-day as hub-pushed cargo', () => {
            const pub = mkPub('mainnet', [], []);
            const belowChain   = ar.ANCHOR_REWARD_ACTIVATION.mainnet - 1;
            const belowArchive = ar.ARCHIVE_REWARD_ACTIVATION.mainnet - 1;
            expect(pub._isChainDerivedReward(row('anchor_BTC', belowChain))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_bundle', belowChain))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_archive', belowArchive))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_BTC', ar.ANCHOR_REWARD_ACTIVATION.mainnet))).to.equal(true);
            expect(pub._isChainDerivedReward(row('anchor_archive', ar.ARCHIVE_REWARD_ACTIVATION.mainnet))).to.equal(true);
        });

        it('never marks a non-anchor type, a row without a block, or an unscoped hub', () => {
            const pub = mkPub('regtest', [], []);
            expect(pub._isChainDerivedReward(row('oracle_round', 5))).to.equal(false);
            expect(pub._isChainDerivedReward(row('anchor_archive', null))).to.equal(false);
            const unscoped = mkPub('', [], []);
            expect(unscoped._isChainDerivedReward(row('anchor_archive', 5))).to.equal(false);
        });
    });

    describe('_startArchiveRound', () => {
        it('answers none, and never reaches the checkpoint wrapper, when only derived rows are pending', async () => {
            const hits = [];
            const pub = mkPub('regtest', [row('anchor_archive', 5), row('anchor_bundle', 6)], hits);
            const verdict = await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            expect(verdict).to.equal('none');
            expect(hits.some(s => s.indexOf('FROM validator_rewards WHERE reward_type LIKE') !== -1),
                'the pending-reward query ran').to.equal(true);
            expect(hits.some(s => s.indexOf('FROM state_checkpoints') !== -1),
                'the round went on to select a checkpoint wrapper for cargo that is not cargo').to.equal(false);
            expect(pub._pendingMatches).to.equal(0);
        });

        it('still carries a hub-pushed row below the flag-day into the round', async () => {
            const hits = [];
            const below = ar.ARCHIVE_REWARD_ACTIVATION.mainnet - 1;
            const pub = mkPub('mainnet', [row('anchor_archive', below)], hits);
            await pub._startArchiveRound({ broadcastFn: () => {} }, BLOCK, false);
            expect(hits.some(s => s.indexOf('FROM state_checkpoints') !== -1),
                'a below-flag-day row must reach the checkpoint wrapper selection').to.equal(true);
        });
    });
});
