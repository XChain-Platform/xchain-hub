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
 * XChain Hub - Validator Registry
 *
 * The transport registry of validators: registering, rotating and
 * deregistering a signing key, pushing the set into every consensus engine,
 * the per-chain-pair subsets, and the per-validator status read.
 *
 ********************************************************************/

const coins = require('../coins');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

class Validators {

    async registerValidator(signingPubkey, addr){
        if(!signingPubkey || !/^[0-9a-fA-F]{64}$/.test(signingPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        // Addr-keyed: each addr has exactly ONE active pubkey, so retire any other
        // active row for this addr BEFORE the upsert. Without it loadValidatorPubkeys'
        // Map<addr, pubkey> resolves the collision by signing_pubkey sort order.
        await this.db.updateValidatorByAddr(addr, signingPubkey);

        await this.db.setValidator(signingPubkey, addr, addr);

        // The new set must reach EVERY consensus engine, not just config-PBFT: a
        // runtime registration has to enter oracle leader rotation too, or hubs hold
        // divergent leader views and silently miss rounds.
        await this.loadValidatorPubkeys();
        await this.propagateValidatorSet();

        logger.info('Validator registered: ' + addr + ' (pubkey: ' + signingPubkey.substring(0, 16) + '...)');
        return true;
    }

    // Rotate the signing key at `addr`: retire the current active key, activate the new
    // one, reload and propagate. The manual transport-registry equivalent of the
    // on-chain DELEGATE path. Rejects an addr with no active validator; use
    // registerValidator for a fresh addr.
    async rotateValidator(addr, newSigningPubkey){
        if(!newSigningPubkey || !/^[0-9a-fA-F]{64}$/.test(newSigningPubkey))
            throw new Error('Invalid signing pubkey (must be 64 hex chars)');
        if(!addr)
            throw new Error('Validator addr is required');

        let current = await this.db.findValidatorsByAddr(addr);
        if(!current || current.length === 0)
            throw new Error('No active validator at addr ' + addr + ' to rotate');

        await this.db.updateValidatorByAddr(addr, newSigningPubkey);
        await this.db.setValidator(newSigningPubkey, addr, addr);

        await this.loadValidatorPubkeys();
        await this.propagateValidatorSet();

        logger.info('Validator rotated at ' + addr + ' → ' + newSigningPubkey.substring(0, 16) + '...');
        return true;
    }

    // Deregister by signing_pubkey OR addr: mark the active row(s) 'removed', then
    // reload and propagate the new set.
    async deregisterValidator({ signingPubkey, addr }){
        if(!signingPubkey && !addr)
            throw new Error('signing_pubkey or addr is required');
        // The key wins when both are given; each identifier has its own statement, so
        // neither column name is ever assembled into SQL here.
        let res;
        if(signingPubkey){
            if(!/^[0-9a-fA-F]{64}$/.test(signingPubkey))
                throw new Error('Invalid signing pubkey (must be 64 hex chars)');
            res = await this.db.updateValidatorRemovedBySigningPubkey(signingPubkey);
        } else {
            res = await this.db.updateValidatorRemovedByAddr(addr);
        }
        await this.loadValidatorPubkeys();
        await this.propagateValidatorSet();

        let n = (res && res.affectedRows != null) ? res.affectedRows : '?';
        logger.info('Validator deregistered (' +
            (signingPubkey ? 'pubkey ' + signingPubkey.substring(0, 16) + '...' : 'addr ' + addr) + '), rows=' + n);
        return true;
    }

    // Load the active set once and push it into every running consensus engine, so
    // runtime membership changes reach ALL PBFT subsystems.
    async propagateValidatorSet(){
        let validators = await this._loadValidatorSet();
        if (this.consensus)       this.consensus.setValidatorSet(validators);
        if (this.oracleConsensus) this.oracleConsensus.setValidatorSet(validators);
        if (this.crossChain) {
            this.crossChain.setValidatorSet(validators);
            this.crossChain.setChainPairValidators(await this.loadChainPairValidators());
        }
        if (this.reorgHandler)    this.reorgHandler.setValidatorSet(validators);
        if (this.governance)      this.governance.setValidatorSet(validators);
        return validators;
    }

    async loadValidatorPubkeys(){
        if(!this.peerManager) return;
        try {
            let rows = await this.db.findActiveValidators();
            let pubkeyMap = new Map();
            for(let row of rows){
                pubkeyMap.set(row.addr, row.signing_pubkey);
            }
            this.peerManager.setValidatorPubkeys(pubkeyMap);
        } catch(e){
            logger.error(nodeUtil.format('Error loading validator pubkeys:', e));
            // Fail closed: propagate so the startup path never opens the P2P listener with a
            // null registry. Swallowing here leaves validatorPubkeys null on a TRANSIENT DB
            // failure, and a null registry makes verifySignature accept any signed message.
            // Reload callers already hold a non-null registry, so a failed reload there surfaces
            // as an error without reopening the null-registry window.
            throw e;
        }
    }

    async _loadValidatorSet(){
        try {
            let rows = await this.db.findActiveValidators();
            return rows.map(r => ({ pubkey: r.signing_pubkey, addr: r.addr }));
        } catch(e){
            logger.error(nodeUtil.format('Error loading validator set:', e));
            return [];
        }
    }

    // Per-chain-pair validator subsets for cross-chain quorum. A validator's
    // comma-separated 'chains' column filters it; NULL/empty means all chains.
    async loadChainPairValidators(){
        let chainPairMap = new Map();
        try {
            // db.js verifyTables reconciles 'chains' onto the table at startup.
            let rows = await this.db.findActiveValidatorChains();

            let allChains = [...coins.ALLOWED_COINS];
            let chainPairs = ['BTC-LTC', 'BTC-DOGE', 'LTC-DOGE'];

            for (let pair of chainPairs) {
                let [chainA, chainB] = pair.split('-');
                let pairValidators = [];
                for (let row of rows) {
                    let supportedChains = row.chains ? row.chains.split(',').map(c => c.trim()) : allChains;
                    if (supportedChains.includes(chainA) && supportedChains.includes(chainB)) {
                        pairValidators.push({ pubkey: row.signing_pubkey, addr: row.addr });
                    }
                }
                if (pairValidators.length > 0) {
                    chainPairMap.set(pair, pairValidators);
                }
            }
        } catch(e) {
            logger.error(nodeUtil.format('Error loading chain-pair validators:', e));
        }
        return chainPairMap;
    }

    // validators: [{ signing_pubkey, addr }] from an external source, the indexer's
    // staking data being the usual one. Upsert-only: this never retires a row, so it
    // cannot drain the set to empty.
    async syncValidators(validators) {
        if (!Array.isArray(validators)) throw new Error('validators must be an array');

        for (let v of validators) {
            if (!v.signing_pubkey || !/^[0-9a-fA-F]{64}$/.test(v.signing_pubkey)) continue;
            if (!v.addr) continue;

            await this.db.setValidator(v.signing_pubkey, v.addr, v.addr);
        }

        // Reloads every subsystem, including reorg and governance, which otherwise
        // keep serving the boot-time set.
        await this.loadValidatorPubkeys();
        await this.propagateValidatorSet();

        logger.info('Validators synced: ' + validators.length + ' entries');
        return true;
    }

    // `chains` rides along with addr/status: the documented getvalidators response has
    // always carried it, and omitting it left the explorer's chains column blank.
    async getValidators() {
        return await this.db.findActiveValidatorRoster();
    }

    async getValidatorStatus(signingPubkey) {
        let vRows = await this.db.findValidatorsBySigningPubkey(signingPubkey);
        if (vRows.length === 0) return null;

        let unclaimed = this.rewardTracker ? await this.rewardTracker.getUnclaimedRewards(signingPubkey) : '0';
        let rewards = this.rewardTracker ? await this.rewardTracker.getRewardHistory(signingPubkey, 20) : [];
        let slashes = this.slashDetector ? await this.slashDetector.getProposalsForValidator(signingPubkey) : [];

        return {
            validator:       vRows[0],
            unclaimedRewards: unclaimed,
            recentRewards:   rewards,
            slashProposals:  slashes
        };
    }
}

module.exports = Validators;
