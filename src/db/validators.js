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
 * XChain Hub - query methods for the validator registry, capability and reward tables.
 *
 * Owns src/sql/validators.sql, src/sql/validator_capabilities.sql, src/sql/validator_rewards.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Deletes from validator_rewards.
    // Moved here from src/RewardTracker.js:212.
    async deleteValidatorReward(roundNumber, rewardType, qualifier) {
        return this.doQuery('DELETE FROM validator_rewards WHERE round_number = ? AND reward_type = ? AND round_qualifier = ? AND batch_seq IS NULL', [roundNumber, rewardType, qualifier]);
    },

    // Reads rows from validators.
    // Moved here from src/XChainHub.js:961.
    async findActiveValidatorChains() {
        return this.doQuery(`SELECT signing_pubkey, addr, chains FROM validators WHERE status = 'active' ORDER BY signing_pubkey`);
    },

    // Reads rows from validators.
    // Moved here from src/XChainHub.js:926, src/XChainHub.js:945.
    async findActiveValidators() {
        return this.doQuery(`SELECT signing_pubkey, addr FROM validators WHERE status = 'active' ORDER BY signing_pubkey`);
    },

    // Reads rows from validator_rewards.
    // Moved here from src/StateAnchorPublisher.js:3723.
    async findValidatorRewardsByRewardType(reward_type, round_number, round_qualifier) {
        return this.doQuery('SELECT validator_pubkey, amount, block_index FROM validator_rewards WHERE reward_type = ? AND round_number = ? AND round_qualifier = ?', [reward_type, round_number, round_qualifier]);
    },

    // Reads rows from validator_rewards.
    // Moved here from src/RewardTracker.js:195.
    async findValidatorRewardsByRoundNumber(roundNumber, rewardType, qualifier) {
        return this.doQuery('SELECT validator_pubkey, batch_seq FROM validator_rewards WHERE round_number = ? AND reward_type = ? AND round_qualifier = ?', [roundNumber, rewardType, qualifier]);
    },

    // Reads rows from validators.
    // Moved here from src/XChainHub.js:862.
    async findValidatorsByAddr(addr) {
        return this.doQuery(`SELECT signing_pubkey FROM validators WHERE addr = ? AND status = 'active'`, [addr]);
    },

    // Reads rows from validators.
    // Moved here from src/XChainHub.js:1147.
    async findValidatorsBySigningPubkey(signingPubkey) {
        return this.doQuery('SELECT * FROM validators WHERE signing_pubkey = ?', [signingPubkey]);
    },

    // Inserts or updates a row in validators.
    // Moved here from src/XChainHub.js:836, src/XChainHub.js:871, src/XChainHub.js:1122.
    async setValidator(signingPubkey, addr, addr2) {
        return this.doQuery(`INSERT INTO validators (signing_pubkey, addr, status)
             VALUES (?, ?, 'active')
             ON DUPLICATE KEY UPDATE addr = ?, status = 'active', updated_at = NOW()`, [signingPubkey, addr, addr2]);
    },

    // Updates validators.
    // Moved here from src/XChainHub.js:830, src/XChainHub.js:867.
    async updateValidatorByAddr(addr, signingPubkey) {
        return this.doQuery(`UPDATE validators SET status = 'removed', updated_at = NOW() WHERE addr = ? AND signing_pubkey <> ? AND status = 'active'`, [addr, signingPubkey]);
    },

    // Updates validators.
    // Moved here from src/SlashGovernance.js:231.
    async updateValidatorBySigningPubkey(signing_pubkey) {
        return this.doQuery(`UPDATE validators SET status = 'suspended', updated_at = NOW() WHERE signing_pubkey = ? AND status = 'active'`, [signing_pubkey]);
    },

    // The validator_capabilities methods below take the CONNECTION as their first
    // argument instead of going through this.doQuery. CapabilityRegistry opens the
    // connection itself and releases it in a finally, and getConnection() hands back
    // the in-flight transaction connection when one is open, so the caller must keep
    // owning the connection for a registry write inside a transaction to stay in it.
    // The SQL is what moved here; the connection lifecycle stayed at the call site.

    // Inserts or updates a row in validator_capabilities.
    // Moved here from src/CapabilityRegistry.js:227.
    async setValidatorCapabilityQualification(conn, signingPubkey, capability, qualified, qualifiedAtBlock) {
        return conn.query(`INSERT INTO validator_capabilities
                    (signing_pubkey, capability, qualified, qualified_at_block)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    qualified=VALUES(qualified),
                    qualified_at_block=VALUES(qualified_at_block)`,
            [signingPubkey, capability, qualified, qualifiedAtBlock]);
    },

    // Inserts or updates a row in validator_capabilities.
    // Moved here from src/CapabilityRegistry.js:246.
    async setValidatorCapabilitySelfTestResult(conn, signingPubkey, capability, selfTestOk, selfTestMsg) {
        return conn.query(`INSERT INTO validator_capabilities
                    (signing_pubkey, capability, self_test_ok, self_test_at, self_test_msg)
                 VALUES (?, ?, ?, NOW(), ?)
                 ON DUPLICATE KEY UPDATE
                    self_test_ok=VALUES(self_test_ok),
                    self_test_at=VALUES(self_test_at),
                    self_test_msg=VALUES(self_test_msg)`,
            [signingPubkey, capability, selfTestOk, selfTestMsg]);
    },

    // Inserts or updates a row in validator_capabilities.
    // Moved here from src/CapabilityRegistry.js:266.
    async setValidatorCapabilityEnabled(conn, signingPubkey, capability, enabled) {
        return conn.query(`INSERT INTO validator_capabilities
                    (signing_pubkey, capability, enabled)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    enabled=VALUES(enabled)`,
            [signingPubkey, capability, enabled]);
    },

    // Reads one row from validator_capabilities: the three activation flags for
    // one (pubkey, capability) pair.
    // Moved here from src/CapabilityRegistry.js:287.
    async getValidatorCapabilityActivationFlags(conn, signingPubkey, capability) {
        return conn.query(`SELECT qualified, self_test_ok, enabled
                 FROM validator_capabilities
                 WHERE signing_pubkey=? AND capability=?
                 LIMIT 1`,
            [signingPubkey, capability]);
    },

    // Reads rows from validator_capabilities: every pubkey fully active for one capability.
    // Moved here from src/CapabilityRegistry.js:305.
    async findActiveValidatorPubkeysByCapability(conn, capability) {
        return conn.query(`SELECT signing_pubkey
                 FROM validator_capabilities
                 WHERE capability=? AND qualified=1 AND self_test_ok=1 AND enabled=1`,
            [capability]);
    },

    // Reads one row from validator_capabilities: how many pubkeys are fully active
    // for one capability.
    // Moved here from src/CapabilityRegistry.js:327.
    async getActiveValidatorCountByCapability(conn, capability) {
        return conn.query(`SELECT COUNT(*) AS cnt
                 FROM validator_capabilities
                 WHERE capability=? AND qualified=1 AND self_test_ok=1 AND enabled=1`,
            [capability]);
    },

    // Reads one row from validator_capabilities: the full flag set for one
    // (pubkey, capability) pair.
    // Moved here from src/CapabilityRegistry.js:342.
    async getValidatorCapabilityState(conn, signingPubkey, capability) {
        return conn.query(`SELECT signing_pubkey, capability, qualified, self_test_ok, enabled,
                        self_test_at, self_test_msg, qualified_at_block
                 FROM validator_capabilities
                 WHERE signing_pubkey=? AND capability=?
                 LIMIT 1`,
            [signingPubkey, capability]);
    },

    // Reads rows from validator_capabilities, optionally narrowed to one pubkey
    // and/or one capability. The WHERE clauses are built from which filters the
    // caller passed; the limit is parsed and clamped to 1..500 before it reaches
    // the statement, so the interpolated LIMIT can never carry caller text.
    // Moved here from src/CapabilityRegistry.js:361.
    async findValidatorCapabilityStates(conn, { signingPubkey, capability, limit } = {}) {
        let query = `SELECT id, signing_pubkey, capability, qualified, self_test_ok,
                            enabled, qualified_at_block, updated_at
                     FROM validator_capabilities`;
        let where = [];
        let args = [];
        if (signingPubkey) {
            where.push("signing_pubkey = ?");
            args.push(signingPubkey);
        }
        if (capability) {
            where.push("capability = ?");
            args.push(capability);
        }
        if (where.length) query += " WHERE " + where.join(" AND ");
        let lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
        query += " ORDER BY id DESC LIMIT " + lim;
        return conn.query(query, args);
    },

    // Reads rows from validator_capabilities: every capability row for one pubkey.
    // Moved here from src/CapabilityRegistry.js:389.
    async findValidatorCapabilitiesByPubkey(conn, signingPubkey) {
        return conn.query(`SELECT capability, qualified, self_test_ok, enabled, self_test_at, self_test_msg
                 FROM validator_capabilities
                 WHERE signing_pubkey=?`,
            [signingPubkey]);
    },

    // Inserts a row into validator_rewards for one oracle round.
    // INSERT IGNORE relies on the UNIQUE KEY (validator_pubkey, round_number, reward_type)
    // so concurrent writes from multiple hubs collapse to one row per (validator, round).
    // Moved here from src/RewardTracker.js:80.
    async createValidatorRoundReward(validatorPubkey, roundNumber, amount) {
        return this.doQuery(`INSERT IGNORE INTO validator_rewards (validator_pubkey, round_number, reward_type, amount)
                         VALUES (?, ?, 'oracle_round', ?)`, [validatorPubkey, roundNumber, amount]);
    },

    // Inserts a row into validator_rewards for one anchor publish. INSERT IGNORE for
    // the same reason as the round reward above: the same hub recording twice is a
    // no-op, and the cross-pubkey collapse is decided by the caller before this runs.
    // Moved here from src/RewardTracker.js:214.
    async createValidatorAnchorReward(validatorPubkey, roundNumber, rewardType, amount, blockIndex, roundQualifier) {
        return this.doQuery(`INSERT IGNORE INTO validator_rewards (validator_pubkey, round_number, reward_type, amount, block_index, round_qualifier)
                     VALUES (?, ?, ?, ?, ?, ?)`, [validatorPubkey, roundNumber, rewardType, amount, blockIndex, roundQualifier]);
    },

    // Reads one row from validator_rewards: what one validator is owed but has not claimed.
    // Moved here from src/RewardTracker.js:275.
    async getUnclaimedValidatorRewardTotal(validatorPubkey) {
        return this.doQuery(`SELECT COALESCE(SUM(CAST(amount AS DECIMAL(40,8))), 0) AS total
                     FROM validator_rewards
                     WHERE validator_pubkey = ? AND claimed = 0`, [validatorPubkey]);
    },

    // Reads rows from validator_rewards: one validator's most recent rewards.
    // Moved here from src/RewardTracker.js:283.
    async findValidatorRewardHistory(validatorPubkey, limit) {
        return this.doQuery(`SELECT round_number, reward_type, amount, claimed, created_at
                     FROM validator_rewards
                     WHERE validator_pubkey = ?
                     ORDER BY round_number DESC
                     LIMIT ?`, [validatorPubkey, limit]);
    },

    // Reads one row from validator_rewards: everything this hub has ever recorded.
    // Moved here from src/RewardTracker.js:292.
    async getValidatorRewardsDistributedTotal() {
        return this.doQuery(`SELECT COALESCE(SUM(CAST(amount AS DECIMAL(40,8))), 0) AS total FROM validator_rewards`);
    },

    // Marks the active validators row for one signing key 'removed'.
    // Moved here from src/XChainHub.js:879, the deregister branch keyed on the key.
    async updateValidatorRemovedBySigningPubkey(signingPubkey) {
        return this.doQuery("UPDATE validators SET status = 'removed', updated_at = NOW() WHERE signing_pubkey = ? AND status = 'active'", [signingPubkey]);
    },

    // Marks the active validators row(s) at one address 'removed'.
    // Moved here from src/XChainHub.js:879, the deregister branch keyed on the address.
    // Deliberately unbounded by key: deregistering by address retires whatever active
    // row that address currently carries, which is how a rotated-away key is cleared.
    async updateValidatorRemovedByAddr(addr) {
        return this.doQuery("UPDATE validators SET status = 'removed', updated_at = NOW() WHERE addr = ? AND status = 'active'", [addr]);
    },

    // Reads the active validator roster the getvalidators RPC answers with.
    // Moved here from src/XChainHub.js:1112. Wider than findActiveValidators and
    // findActiveValidatorChains: `chains` rides along with addr and status because
    // the documented response has always carried it.
    async findActiveValidatorRoster() {
        return this.doQuery("SELECT signing_pubkey, addr, chains, status, created_at, updated_at FROM validators WHERE status = 'active' ORDER BY signing_pubkey");
    },

    // Stamps the archive batch_seq on one not-yet-archived validator_rewards row.
    // Moved here from src/StateAnchorPublisher.js:4753, the branch for a FINALIZED from a
    // peer predating the round qualifier.
    async updateValidatorRewardArchiveBatchSeq(batchSeq, rewardType, roundNumber, validatorPubkey) {
        return this.doQuery('UPDATE validator_rewards SET batch_seq = ? WHERE reward_type = ? AND round_number = ? AND validator_pubkey = ? AND batch_seq IS NULL', [batchSeq, rewardType, roundNumber, validatorPubkey]);
    },

    // Stamps the archive batch_seq on one not-yet-archived validator_rewards row, matched
    // on its round qualifier too, so a rebase-reissued archive seq cannot mark its twin.
    // Moved here from src/StateAnchorPublisher.js:4753, the qualified branch.
    async updateValidatorRewardArchiveBatchSeqByQualifier(batchSeq, rewardType, roundNumber, validatorPubkey, roundQualifier) {
        return this.doQuery('UPDATE validator_rewards SET batch_seq = ? WHERE reward_type = ? AND round_number = ? AND validator_pubkey = ? AND round_qualifier = ? AND batch_seq IS NULL', [batchSeq, rewardType, roundNumber, validatorPubkey, roundQualifier]);
    },

    // Reads a page of pending anchor reward rows for the archive, for a hub with no
    // flag-days to bind (unscoped or unknown network). Moved here from
    // src/StateAnchorPublisher.js:2505, the branch with no exclusion clause.
    async findArchivableAnchorRewards(maxBatch) {
        return this.doQuery(
            "SELECT * FROM validator_rewards WHERE reward_type LIKE 'anchor\\_%' AND batch_seq IS NULL AND block_index IS NOT NULL" + " " +
            "ORDER BY reward_type ASC, round_number ASC, validator_pubkey ASC LIMIT ?",
            [maxBatch]);
    },

    // Reads a page of pending anchor reward rows for the archive, excluding every row the
    // indexer credits from on-chain bytes at or above this hub's two flag-days, so
    // eligibility applies BEFORE the LIMIT. The exclusion clause is built here beside the
    // query it filters, so StateAnchorPublisher passes only the bound values. The reward
    // types and both flag-days are bound; the anchor type count is all the list changes.
    async findArchivableAnchorRewardsBelowFlagDays(anchorRewardTypes, anchorFlagDay, archiveRewardType, archiveFlagDay, maxBatch) {
        return this.doQuery(
            "SELECT * FROM validator_rewards WHERE reward_type LIKE 'anchor\\_%' AND batch_seq IS NULL AND block_index IS NOT NULL" +
            " AND NOT (reward_type IN (" +
                anchorRewardTypes.map(() => '?').join(', ') +
            ") AND block_index >= ?)" +
            " AND NOT (reward_type = ? AND block_index >= ?)" + " " +
            "ORDER BY reward_type ASC, round_number ASC, validator_pubkey ASC LIMIT ?",
            anchorRewardTypes.concat([anchorFlagDay, archiveRewardType, archiveFlagDay, maxBatch]));
    }
};
