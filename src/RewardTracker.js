/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
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
const ar    = require('./anchor_reward_activation.js');

class RewardTracker {

    constructor(hub) {
        this.hub = hub;
        this.db  = hub.db;

        this.rewardPerRound = hub.p2pConfig.ORACLE_REWARD_PER_ROUND || '10.00000000';
        this.anchorReward   = process.env.ANCHOR_REWARD_PER_PUBLISH || hub.p2pConfig.ANCHOR_REWARD_PER_PUBLISH || '10.00000000';

        // BTC indexer push config (for replicating rewards to indexer's validator_rewards table)
        this.btcIndexerApiUrl = process.env.BTC_INDEXER_API_URL || '';
        this.btcIndexerApiKey = process.env.BTC_INDEXER_API_KEY || '';
    }

    // Distribute rewards for a finalized oracle round. HUB-LOCAL ONLY (ops
    // visibility: getRewardHistory / dashboards). The consensus oracle_round
    // rewards are derived by the BTC indexer from the published PRICE v0
    // action's verified signer set (a deterministic function of the chain, so
    // reindex/recovery replays them); the old push to the indexer is retired
    // because it credited the in-memory PBFT prepare set, which no offline
    // verifier could ever re-derive, and could race the indexer's own derivation.
    // participants: array of validator pubkeys that submitted valid prices
    // btcBlockHeight: the BTC chain tip when this round was triggered
    async distributeRewards(round, participants, btcBlockHeight) {
        if (!participants || participants.length === 0) return;

        let totalReward = parseFloat(this.rewardPerRound);
        if (!Number.isFinite(totalReward) || totalReward <= 0)
            throw new Error('Invalid reward amount: ' + this.rewardPerRound);

        let validParticipants = participants.filter(pk =>
            typeof pk === 'string' && /^[0-9a-fA-F]{64}$/.test(pk)
        );
        if (validParticipants.length === 0) return;

        let perValidator = (totalReward / validParticipants.length).toFixed(8);

        for (let pubkey of validParticipants) {
            // INSERT IGNORE relies on the UNIQUE KEY (validator_pubkey, round_number, reward_type)
            // so concurrent writes from multiple hubs collapse to one row per (validator, round).
            let query = `INSERT IGNORE INTO validator_rewards (validator_pubkey, round_number, reward_type, amount)
                         VALUES (?, ?, 'oracle_round', ?)`;
            await this.db.doQuery(query, [pubkey, round, perValidator])
                .catch(e => console.error('Error recording reward for ' + pubkey + ':', e));
        }

        console.log('Rewards: Round ' + round + ': ' + perValidator + ' XCHAIN each to ' + validParticipants.length + ' validators (hub-local; indexer derives the consensus rows from PRICE v0)');
    }

    // Record a single anchor-publish reward (ANCHOR v0 per-chain or v1 archive).
    // rewardType: 'anchor_<chain>' / 'anchor_archive'; roundNumber: checkpoint_seq /
    // batch_seq. The publisher that paid the DOGE earns it. Called on EVERY hub
    // (the publisher at publish time; peers from the signature-verified
    // V0_DONE/FINALIZED announcements), and blockIndex MUST be the quorum-agreed
    // snapshot_block of the rewarded checkpoint, so all hubs record identical
    // row bytes and the ANCHOR archive's rewards section verifies by
    // re-derivation.
    //
    // One logical anchor → exactly ONE reward, even across DISTINCT publisher
    // pubkeys. The table's UNIQUE KEY includes validator_pubkey, so a bare INSERT
    // IGNORE cannot collapse a failover race: when a late rank-0 and an early
    // rank-1 both publish the same checkpoint, each records its own pubkey for the
    // same (round_number, reward_type) and BOTH rows would land, minting the
    // reward twice and inflating the COLLECT rail. We collapse them
    // deterministically: the lexicographically smallest pubkey keeps the credit.
    // Every hub computes the identical winner from the same set of rows, so the
    // surviving row stays byte-identical fleet-wide (the ANCHOR archive's
    // re-derivation invariant holds and recovery restores a single reward). A row
    // that has already ridden an on-chain archive (batch_seq IS NOT NULL) is
    // immutable and is never displaced. Retries / re-flushes / multi-hub recording
    // of the SAME pubkey remain idempotent (UNIQUE KEY + the existence check below).
    async recordAnchorReward(rewardType, roundNumber, pubkey, blockIndex) {
        if (typeof pubkey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(pubkey)) return;
        let amount = parseFloat(this.anchorReward);
        if (!Number.isFinite(amount) || amount <= 0) return;
        let amountStr = amount.toFixed(8);
        let lcPubkey  = pubkey.toLowerCase();

        // Cross-pubkey dedup guard: inspect any rows already holding this logical
        // anchor (round_number, reward_type) regardless of pubkey.
        let existing = await this.db.doQuery(
            'SELECT validator_pubkey, batch_seq FROM validator_rewards WHERE round_number = ? AND reward_type = ?',
            [roundNumber, rewardType])
            .catch(e => { console.error('Error reading anchor reward for ' + lcPubkey + ':', e); return null; });
        existing = existing || [];

        if (existing.some(r => String(r.validator_pubkey).toLowerCase() === lcPubkey)) return;   // already ours (idempotent)
        if (existing.length > 0) {
            // A row already rode an on-chain archive → immutable, the canonical
            // winner fleet-wide. Never insert a competing pubkey behind it.
            if (existing.some(r => r.batch_seq != null)) return;
            // Otherwise the deterministic winner is the smallest pubkey. If an
            // incumbent sorts at or below ours, ours is the duplicate; drop it.
            let minIncumbent = existing.map(r => String(r.validator_pubkey).toLowerCase()).sort()[0];
            if (minIncumbent <= lcPubkey) return;
            // Our pubkey sorts strictly lower and nothing is archived yet, so it
            // supersedes the local-only incumbent(s); every hub makes the same call.
            await this.db.doQuery(
                'DELETE FROM validator_rewards WHERE round_number = ? AND reward_type = ? AND batch_seq IS NULL',
                [roundNumber, rewardType])
                .catch(e => console.error('Error consolidating anchor reward for ' + lcPubkey + ':', e));
        }

        let query = `INSERT IGNORE INTO validator_rewards (validator_pubkey, round_number, reward_type, amount, block_index)
                     VALUES (?, ?, ?, ?, ?)`;
        await this.db.doQuery(query, [lcPubkey, roundNumber, rewardType, amountStr, blockIndex || 0])
            .catch(e => console.error('Error recording anchor reward for ' + lcPubkey + ':', e));

        console.log('Rewards: ' + rewardType + ' #' + roundNumber + ': ' + amountStr + ' XCHAIN to ' + lcPubkey.substring(0, 16) + '…');

        // #5311: at/above the anchor-reward flag-day, the indexer DERIVES the per-chain
        // anchor reward from the on-chain ANCHOR v4/v5 publisher attestation, so the
        // unauthenticated, forgeable push is retired for those reward types. The hub still
        // RECORDS the reward locally (ops visibility + the archive recovery transport). The
        // push survives below the flag-day, and for anchor_archive (which the indexer does
        // not derive from v4/v5) it survives always; oracle_round never pushes here.
        let network  = (this.hub && this.hub.network) ? this.hub.network : '';
        let isDerived = /^anchor_(BTC|LTC|DOGE)$/.test(String(rewardType)) &&
                        ar.isAnchorRewardActive(Number(blockIndex), network);
        if(!isDerived)
            this._pushRewardsToBtcIndexer(roundNumber, [lcPubkey], amountStr, blockIndex || roundNumber, rewardType)
                .catch(e => console.warn('Rewards: failed to push anchor reward to BTC indexer:', e));
    }

    // Resolve the staking source address that owns a signing pubkey at a block,
    // via the BTC indexer (stakes first, then DELEGATE v0 delegations); the
    // archive builder pins this earn-time source into the ANCHOR archive and
    // followers re-resolve it before co-signing. Block-scoped, so every hub gets
    // the same answer regardless of when it asks. Returns the address string or
    // null (unreachable indexer / unknown pubkey).
    async resolveSourceByPubkey(pubkey, blockIndex) {
        if (!this.btcIndexerApiUrl) return null;
        let body = {
            jsonrpc: '2.0',
            id:      Date.now(),
            method:  'getstakesourcebypubkey',
            params:  { pubkey: String(pubkey).toLowerCase(), block_index: Number(blockIndex) }
        };
        let headers = { 'Content-Type': 'application/json' };
        if (this.btcIndexerApiKey) headers['x-api-key'] = this.btcIndexerApiKey;
        try {
            let res = await axios.post(this.btcIndexerApiUrl, body, { headers: headers, timeout: 5000 });
            let result = res && res.data ? res.data.result : null;
            return (result && result.source) ? String(result.source) : null;
        } catch (err) {
            console.warn('Rewards: source resolution failed for ' + String(pubkey).substring(0, 16) + '…:', err && err.message);
            return null;
        }
    }

    // Push validator rewards to the BTC indexer's local DB via JSON-RPC
    // Called fire-and-forget; failures are logged but never block the consensus path
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

    async getUnclaimedRewards(validatorPubkey) {
        let query = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(40,8))), 0) AS total
                     FROM validator_rewards
                     WHERE validator_pubkey = ? AND claimed = 0`;
        let rows = await this.db.doQuery(query, [validatorPubkey]);
        return rows.length > 0 ? rows[0].total.toString() : '0';
    }

    async getRewardHistory(validatorPubkey, limit) {
        let query = `SELECT round_number, reward_type, amount, claimed, created_at
                     FROM validator_rewards
                     WHERE validator_pubkey = ?
                     ORDER BY round_number DESC
                     LIMIT ?`;
        return await this.db.doQuery(query, [validatorPubkey, limit || 50]);
    }

    async getTotalDistributed() {
        let query = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(40,8))), 0) AS total FROM validator_rewards`;
        let rows = await this.db.doQuery(query);
        return rows.length > 0 ? rows[0].total.toString() : '0';
    }
}

module.exports = RewardTracker;
