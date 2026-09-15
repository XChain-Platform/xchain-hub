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
 * XChain Hub - Cross-Chain Attestation Engine
 *
 * PBFT-based consensus for cross-chain action attestation. When an
 * action on Chain A needs to trigger an action on Chain B, validators
 * attest that the source action exists with sufficient confirmations.
 *
 * Flow: PROPOSE → PREPARE (2f+1) → COMMIT (2f+1) → store attestation
 *
 ********************************************************************/

const axios        = require('axios');
const EventEmitter = require('events');
const coins        = require('../coins');
const { positiveIntConfig } = require('../lib/config_int.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const logger = getLogger();
const { installParts } = require('./prototype_parts.js');
const { ALLOWED_CHAINS, DEFAULT_CONFIRMATIONS, DEFAULT_ATTESTATION_TIMEOUT, DEFAULT_STORE_RETRY_ATTEMPTS, DEFAULT_STORE_RETRY_BASE_MS, STORE_RETRY_MAX_DELAY_MS } = require('./attest/constants.js');
const roundsPart     = require('./attest/rounds.js');
const membershipPart = require('./attest/membership.js');
const tallyPart      = require('./attest/tally.js');

class CrossChainEngine extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        this.initRoundState();

        // Config
        this.timeout = parseInt(hubConfig.ATTESTATION_TIMEOUT) || DEFAULT_ATTESTATION_TIMEOUT;

        // Persistence retry for a quorum-finalized attestation. The
        // INSERT is idempotent (ON DUPLICATE KEY UPDATE), so re-running it after
        // a partial failure is safe.
        this.storeRetryAttempts = positiveIntConfig(hubConfig.XCHAIN_ATTEST_STORE_RETRIES,
            DEFAULT_STORE_RETRY_ATTEMPTS, 'XCHAIN_ATTEST_STORE_RETRIES');
        this.storeRetryBaseMs   = positiveIntConfig(hubConfig.XCHAIN_ATTEST_STORE_RETRY_MS,
            DEFAULT_STORE_RETRY_BASE_MS, 'XCHAIN_ATTEST_STORE_RETRY_MS');

        // Per-chain cross-chain confirmation thresholds (env/p2pConfig overridable;
        // mainnet floor-clamped, see coins.resolveConfirmations).
        this.confirmations = coins.resolveConfirmations(
            this.hub && this.hub.p2pConfig, this.hub && this.hub.network);

        // Per-coin indexer JSON-RPC endpoints used to verify a proposed source
        // action against this hub's own view of the source chain (federation
        // read methods need the api key): <COIN>_INDEXER_URL,
        // <COIN>_INDEXER_API_KEY. Same idiom as CrossChainDexEngine /
        // StateCheckpointEngine.
        let cfg = (this.hub && this.hub.p2pConfig) || {};
        this.indexers = {};
        for (let coin of ALLOWED_CHAINS) {
            this.indexers[coin] = {
                url: hubConfig.env()[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: hubConfig.env()[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }
    }

    // Set the validator set for quorum and leader calculation
    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    // Set per-chain-pair validator subsets for cross-chain quorum
    // chainPairMap: Map<'BTC-DOGE', [{pubkey, addr}]>
    setChainPairValidators(chainPairMap) {
        this.chainPairValidators = chainPairMap;
    }

    // Start listening for cross-chain attestation messages
    async start() {
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, so a standard configs-provisioned hub reaches
        // the indexer instead of falling through to the empty-URL guard.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        logger.info('Cross-chain attestation engine started');
    }

    // Stop the engine
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        // Reject all pending attestations
        for (let [id, pending] of this.pendingAttestations) {
            if (pending.timer) clearTimeout(pending.timer);
            if (pending.reject) pending.reject(new Error('Cross-chain engine stopped'));
        }
        this.pendingAttestations.clear();
    }

    // Get stored attestations
    async getAttestations(status, limit) {
        // Two statements, not one built string: an absent status drops the WHERE
        // clause entirely rather than matching on a null.
        if (status) return await this.db.findAttestationsByStatus(status, limit || 50);
        return await this.db.findAttestations(limit || 50);
    }

    // Get a specific attestation
    async getAttestation(sourceChain, sourceActionIndex) {
        let rows = await this.db.getAttestationBySourceAction(sourceChain, sourceActionIndex);
        return rows.length > 0 ? rows[0] : null;
    }

    // --- Source-action verification ---

    // Confirm the proposed source action exists in this hub's own indexer for
    // the source chain and has reached that chain's confirmation threshold.
    // Fails closed: no endpoint configured, indexer unreachable, action not
    // found, or depth below threshold all return false; the caller must then
    // refuse to co-sign. Availability is deliberately traded away here: a hub
    // that cannot see the source chain has no business attesting actions on it.
    async verifySourceAction(sourceChain, sourceActionIndex) {
        let idx = parseInt(sourceActionIndex, 10);
        if (!Number.isInteger(idx) || idx <= 0) return false;

        let ix = this.indexers[sourceChain];
        if (!ix || !ix.url) {
            logger.warn('CrossChain: no indexer endpoint for ' + sourceChain +
                ' (set ' + sourceChain + '_INDEXER_URL): cannot verify source action');
            return false;
        }

        let required = this.confirmations[sourceChain] || DEFAULT_CONFIRMATIONS[sourceChain];
        if (!Number.isFinite(required) || required <= 0) return false;

        let res;
        try {
            res = await this._indexerCall(sourceChain, 'getactionconfirmations', { action_index: idx });
        } catch (err) {
            logger.warn('CrossChain: source action lookup failed for ' + sourceChain + ':' + idx +
                ': ' + (err && err.message));
            return false;
        }
        if (!res || res.error || res.exists !== true) return false;

        let depth = Number(res.confirmations);
        return Number.isFinite(depth) && depth >= required;
    }

    async _indexerCall(coin, method, params) {
        let ix = this.indexers[coin];
        if (!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if (ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url,
            { jsonrpc: '2.0', method, params: params || {}, id: 1 },
            { headers, timeout: parseInt(hubConfig.CROSS_CHAIN_INDEXER_TIMEOUT) || 15000 });
        if (resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // --- Storage ---

    // Persist a quorum-finalized attestation, retrying a transient DB failure
    // with exponential backoff before giving up. Safe to re-run:
    // storeAttestation upserts on attestation_id.
    async storeWithRetry(attestation) {
        let delay = this.storeRetryBaseMs;
        for (let attempt = 1; ; attempt++) {
            try {
                await this.storeAttestation(attestation);
                return;
            } catch (err) {
                if (attempt >= this.storeRetryAttempts) throw err;
                logger.warn('CrossChain: attestation store attempt ' + attempt + '/' +
                    this.storeRetryAttempts + ' failed for ' + attestation.attestationId +
                    ' (' + err.message + '); retrying in ' + delay + 'ms');
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, STORE_RETRY_MAX_DELAY_MS);
            }
        }
    }

    async storeAttestation(attestation) {
        await this.db.setAttestation(
            attestation.attestationId, attestation.sourceChain, attestation.sourceActionIndex,
            attestation.destChain, attestation.confirmations, attestation.status,
            attestation.validatorCount, attestation.consensusProof,
            attestation.status, attestation.validatorCount, attestation.consensusProof
        );
    }

    async getStoredAttestation(attestationId) {
        let rows = await this.db.getAttestation(attestationId);
        return rows.length > 0 ? rows[0] : null;
    }

}

installParts(CrossChainEngine.prototype, [
    roundsPart, membershipPart, tallyPart
]);

module.exports = CrossChainEngine;
