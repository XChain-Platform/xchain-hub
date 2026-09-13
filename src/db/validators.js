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
    }
};
