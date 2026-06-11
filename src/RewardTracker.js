/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Reward Tracker
 *
 * Tracks validator participation in oracle rounds and distributes
 * XCHAIN rewards. Rewards are recorded in the hub DB and collectable
 * via COLLECT action on the BTC chain.
 *
 ********************************************************************/

const axios = require('axios');

class RewardTracker {

    constructor(hub) {
        this.hub = hub;
        this.db  = hub.db;

        // Config
        this.rewardPerRound = hub.p2pConfig.ORACLE_REWARD_PER_ROUND || '10.00000000';
        this.anchorReward   = process.env.ANCHOR_REWARD_PER_PUBLISH || hub.p2pConfig.ANCHOR_REWARD_PER_PUBLISH || '10.00000000';

        // BTC indexer push config (for replicating rewards to indexer's validator_rewards table)
        this.btcIndexerApiUrl = process.env.BTC_INDEXER_API_URL || '';
        this.btcIndexerApiKey = process.env.BTC_INDEXER_API_KEY || '';
    }

    // Distribute rewards for a finalized oracle round
    // participants: array of validator pubkeys that submitted valid prices
    // btcBlockHeight: the BTC chain tip when this round was triggered (used as block_index in indexer)
    async distributeRewards(round, participants, btcBlockHeight) {
        if (!participants || participants.length === 0) return;

        // Validate reward amount
        let totalReward = parseFloat(this.rewardPerRound);
        if (!Number.isFinite(totalReward) || totalReward <= 0)
            throw new Error('Invalid reward amount: ' + this.rewardPerRound);

        // Filter to valid pubkeys (64 hex chars)
        let validParticipants = participants.filter(pk =>
            typeof pk === 'string' && /^[0-9a-fA-F]{64}$/.test(pk)
        );
        if (validParticipants.length === 0) return;

        // Calculate per-validator reward (equal split)
        let perValidator = (totalReward / validParticipants.length).toFixed(8);

        for (let pubkey of validParticipants) {
            // INSERT IGNORE relies on the UNIQUE KEY (validator_pubkey, round_number, reward_type)
            // so concurrent writes from multiple hubs collapse to one row per (validator, round).
            let query = `INSERT IGNORE INTO validator_rewards (validator_pubkey, round_number, reward_type, amount)
                         VALUES (?, ?, 'oracle_round', ?)`;
            await this.db.doQuery(query, [pubkey, round, perValidator])
                .catch(e => console.error('Error recording reward for ' + pubkey + ':', e));
        }

        console.log('Rewards: Round ' + round + ' — ' + perValidator + ' XCHAIN each to ' + validParticipants.length + ' validators');

        // Push rewards to the BTC indexer so COLLECT can find them (best-effort)
        this._pushRewardsToBtcIndexer(round, validParticipants, perValidator, btcBlockHeight || round)
            .catch(e => console.warn('Rewards: failed to push to BTC indexer:', e));
    }

    // Record a single anchor-publish reward (ANCHOR v0 per-chain or v1 archive).
    // rewardType: 'anchor_<chain>' / 'anchor_archive'; roundNumber: checkpoint_seq /
    // batch_seq. The elected publisher paid the DOGE, so it earns the reward —
    // INSERT IGNORE on (pubkey, round, type) makes retries and re-flushes idempotent.
    async recordAnchorReward(rewardType, roundNumber, pubkey, blockIndex) {
        if (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey)) return;
        let amount = parseFloat(this.anchorReward);
        if (!Number.isFinite(amount) || amount <= 0) return;
        let amountStr = amount.toFixed(8);

        let query = `INSERT IGNORE INTO validator_rewards (validator_pubkey, round_number, reward_type, amount)
                     VALUES (?, ?, ?, ?)`;
        await this.db.doQuery(query, [pubkey, roundNumber, rewardType, amountStr])
            .catch(e => console.error('Error recording anchor reward for ' + pubkey + ':', e));

        console.log('Rewards: ' + rewardType + ' #' + roundNumber + ' — ' + amountStr + ' XCHAIN to ' + pubkey.substring(0, 16) + '…');

        this._pushRewardsToBtcIndexer(roundNumber, [pubkey], amountStr, blockIndex || roundNumber, rewardType)
            .catch(e => console.warn('Rewards: failed to push anchor reward to BTC indexer:', e));
    }

    // Push validator rewards to the BTC indexer's local DB via JSON-RPC
    // Called fire-and-forget — failures are logged but never block the consensus path
    async _pushRewardsToBtcIndexer(round, pubkeys, amount, blockIndex, rewardType) {
        if (!this.btcIndexerApiUrl) return;
        let rewards = pubkeys.map(pk => ({ pubkey: pk, amount: amount }));
        let body = {
            jsonrpc: '2.0',
            id:      Date.now(),
            method:  'pushvalidatorrewards',
            params:  {
                round:       round,
                reward_type: rewardType || 'oracle_round',
                block_index: blockIndex,
                rewards:     rewards
            }
        };
        let headers = { 'Content-Type': 'application/json' };
        if (this.btcIndexerApiKey) headers['x-api-key'] = this.btcIndexerApiKey;
        try {
            await axios.post(this.btcIndexerApiUrl, body, { headers: headers, timeout: 5000 });
        } catch (err) {
            console.warn('Rewards: BTC indexer push failed:', err);
        }
    }

    // Get total unclaimed rewards for a validator
    async getUnclaimedRewards(validatorPubkey) {
        let query = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(40,8))), 0) AS total
                     FROM validator_rewards
                     WHERE validator_pubkey = ? AND claimed = 0`;
        let rows = await this.db.doQuery(query, [validatorPubkey]);
        return rows.length > 0 ? rows[0].total.toString() : '0';
    }

    // Get reward history for a validator
    async getRewardHistory(validatorPubkey, limit) {
        let query = `SELECT round_number, reward_type, amount, claimed, created_at
                     FROM validator_rewards
                     WHERE validator_pubkey = ?
                     ORDER BY round_number DESC
                     LIMIT ?`;
        return await this.db.doQuery(query, [validatorPubkey, limit || 50]);
    }

    // Get total rewards distributed across all validators
    async getTotalDistributed() {
        let query = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(40,8))), 0) AS total FROM validator_rewards`;
        let rows = await this.db.doQuery(query);
        return rows.length > 0 ? rows[0].total.toString() : '0';
    }
}

module.exports = RewardTracker;
