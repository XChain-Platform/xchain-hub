/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Hub - Reward Tracker
 *
 * Tracks validator participation in oracle rounds and distributes
 * XCHAIN rewards. Rewards are recorded in the hub DB and claimable
 * via CLAIM_REWARDS action on the BTC chain.
 *
 ********************************************************************/

const axios = require('axios');

class RewardTracker {

    constructor(hub) {
        this.hub = hub;
        this.db  = hub.db;

        // Config
        this.rewardPerRound = hub.p2pConfig.ORACLE_REWARD_PER_ROUND || '10.00000000';

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
            let query = `INSERT INTO validator_rewards (validator_pubkey, round_number, reward_type, amount)
                         VALUES (?, ?, 'oracle_round', ?)`;
            await this.db.doQuery(query, [pubkey, round, perValidator])
                .catch(e => console.error('Error recording reward for ' + pubkey + ':', e.message));
        }

        console.log('Rewards: Round ' + round + ' — ' + perValidator + ' XCHAIN each to ' + validParticipants.length + ' validators');

        // Push rewards to the BTC indexer so CLAIM_REWARDS can find them (best-effort)
        this._pushRewardsToBtcIndexer(round, validParticipants, perValidator, btcBlockHeight || round)
            .catch(e => console.warn('Rewards: failed to push to BTC indexer:', e.message));
    }

    // Push validator rewards to the BTC indexer's local DB via JSON-RPC
    // Called fire-and-forget — failures are logged but never block the consensus path
    async _pushRewardsToBtcIndexer(round, pubkeys, amount, blockIndex) {
        if (!this.btcIndexerApiUrl) return;
        let rewards = pubkeys.map(pk => ({ pubkey: pk, amount: amount }));
        let body = {
            jsonrpc: '2.0',
            id:      Date.now(),
            method:  'pushvalidatorrewards',
            params:  {
                round:       round,
                reward_type: 'oracle_round',
                block_index: blockIndex,
                rewards:     rewards
            }
        };
        let headers = { 'Content-Type': 'application/json' };
        if (this.btcIndexerApiKey) headers['x-api-key'] = this.btcIndexerApiKey;
        try {
            await axios.post(this.btcIndexerApiUrl, body, { headers: headers, timeout: 5000 });
        } catch (err) {
            console.warn('Rewards: BTC indexer push failed:', err.message);
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
