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
 * XChain Hub - Reorg Handler
 *
 * Handles cross-chain reorg propagation. When a blockchain reorg is
 * detected, the hub rolls back its own cross-chain state (attestations,
 * price snapshots) and coordinates rollback across affected chains.
 *
 * Flow: REORG_ALERT → PBFT consensus → hub rollback → reorg attestation stored
 *
 ********************************************************************/

const crypto       = require('crypto');
const EventEmitter = require('events');

const REORG_ALERT          = 'REORG_ALERT';
const XCHAIN_REORG_PREPARE = 'XCHAIN_REORG_PREPARE';
const XCHAIN_REORG_COMMIT  = 'XCHAIN_REORG_COMMIT';

const DEFAULT_REORG_TIMEOUT = 60000; // 60 seconds

class ReorgHandler extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Validator set
        this.validatorSet = [];

        // Pending reorg consensus: Map<reorgId, pending>
        this.pendingReorgs = new Map();

        // Processed reorg IDs (prevent duplicate processing)
        this.processed = new Set();

        // Message handler
        this._messageHandler = null;

        // Config
        this.timeout = parseInt(process.env.REORG_TIMEOUT) || DEFAULT_REORG_TIMEOUT;
    }

    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Reorg handler started');
    }

    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for (let [id, pending] of this.pendingReorgs) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        this.pendingReorgs.clear();
    }

    // Report a reorg (called via JSON-RPC or internally)
    async reportReorg(chain, reorgHeight, timestamp) {
        let reorgId = chain + ':' + reorgHeight + ':' + timestamp;

        if (this.processed.has(reorgId)) return;

        // Single-node fallback
        let quorum = this._getQuorum();
        if (quorum === 0) {
            await this._executeRollback(chain, reorgHeight, timestamp, reorgId, 1, '[]');
            return;
        }

        // Broadcast REORG_ALERT
        this.peerManager.broadcast(REORG_ALERT, {
            chain, reorgHeight, timestamp, reorgId
        });

        // Determine affected chains (any chain that had cross-chain interactions with the source)
        let affectedChains = this._getAffectedChains(chain);

        // Start consensus
        this._initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains);
    }

    // Get reorg history
    async getReorgHistory(limit) {
        let query = "SELECT * FROM reorg_attestations ORDER BY created_at DESC LIMIT ?";
        return await this.db.doQuery(query, [limit || 50]);
    }

    // --- Message handlers ---

    _handleMessage(envelope) {
        switch (envelope.type) {
            case REORG_ALERT:          this._handleAlert(envelope);   break;
            case XCHAIN_REORG_PREPARE: this._handlePrepare(envelope); break;
            case XCHAIN_REORG_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    _handleAlert(envelope) {
        let { chain, reorgHeight, timestamp, reorgId } = envelope.data;
        if (!chain || !reorgHeight || !timestamp || !reorgId) return;
        if (this.processed.has(reorgId)) return;

        let affectedChains = this._getAffectedChains(chain);

        // If we don't already have this reorg pending, start consensus
        if (!this.pendingReorgs.has(reorgId)) {
            this._initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains);
        }
    }

    _initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains) {
        if (this.pendingReorgs.has(reorgId)) return;

        let digest = this._digest(reorgId, chain, reorgHeight, timestamp);

        let pending = {
            reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
            prepares: new Set(),
            commits:  new Set(),
            finalized: false,
            timer:    null
        };

        pending.prepares.add(this.peerManager.validatorAddr);
        this.pendingReorgs.set(reorgId, pending);

        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                console.warn('Reorg: Consensus timeout for ' + reorgId);
                this.pendingReorgs.delete(reorgId);
            }
        }, this.timeout);

        // Broadcast PREPARE
        this.peerManager.broadcast(XCHAIN_REORG_PREPARE, {
            reorgId, chain, reorgHeight, timestamp,
            affectedChains, digest
        });

        this._checkPrepareQuorum(reorgId);
    }

    _handlePrepare(envelope) {
        let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest } = envelope.data;
        if (!reorgId || !digest) return;

        if (!this.pendingReorgs.has(reorgId)) {
            // Create pending from the received data
            let pending = {
                reorgId, chain, reorgHeight, timestamp,
                affectedChains: affectedChains || [],
                digest,
                prepares: new Set(),
                commits:  new Set(),
                finalized: false,
                timer: setTimeout(() => {
                    this.pendingReorgs.delete(reorgId);
                }, this.timeout * 2)
            };
            this.pendingReorgs.set(reorgId, pending);
        }

        let pending = this.pendingReorgs.get(reorgId);
        if (pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        this._checkPrepareQuorum(reorgId);
    }

    _handleCommit(envelope) {
        let { reorgId, digest } = envelope.data;
        if (!reorgId || !digest) return;

        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.digest !== digest) return;

        pending.commits.add(envelope.sender);
        this._checkCommitQuorum(reorgId);
    }

    _checkPrepareQuorum(reorgId) {
        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.prepares.size >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            this.peerManager.broadcast(XCHAIN_REORG_COMMIT, {
                reorgId: reorgId,
                digest:  pending.digest
            });

            this._checkCommitQuorum(reorgId);
        }
    }

    _checkCommitQuorum(reorgId) {
        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.commits.size >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let proof = JSON.stringify([...pending.commits]);

            this._executeRollback(
                pending.chain, pending.reorgHeight, pending.timestamp,
                reorgId, pending.prepares.size, proof
            ).then(() => {
                this.pendingReorgs.delete(reorgId);
            }).catch(err => {
                console.error('Reorg: Error executing rollback for ' + reorgId + ':', err.message);
                this.pendingReorgs.delete(reorgId);
            });
        }
    }

    // --- Rollback execution ---

    async _executeRollback(chain, reorgHeight, timestamp, reorgId, validatorCount, proof) {
        console.log('Reorg: Rolling back cross-chain state for ' + chain + ' at height ' + reorgHeight);

        // 1. Delete attestations created after the reorg timestamp for the affected chain
        await this.db.doQuery(
            "DELETE FROM attestations WHERE source_chain = ? AND created_at > FROM_UNIXTIME(? / 1000)",
            [chain, timestamp]
        );

        // 2. Invalidate price snapshots finalized after the reorg timestamp
        await this.db.doQuery(
            "UPDATE price_snapshots SET status = 'disputed' WHERE block_timestamp > ? AND status = 'finalized'",
            [timestamp]
        );

        // 3. Store the reorg attestation
        let affectedChains = this._getAffectedChains(chain);
        await this.db.doQuery(
            `INSERT INTO reorg_attestations
                (reorg_id, source_chain, reorg_height, reorg_timestamp, affected_chains,
                 validator_count, consensus_proof, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')
             ON DUPLICATE KEY UPDATE status = 'confirmed', updated_at = NOW()`,
            [reorgId, chain, reorgHeight, timestamp,
             JSON.stringify(affectedChains), validatorCount, proof]
        );

        this.processed.add(reorgId);

        console.log('Reorg: Rollback complete for ' + reorgId +
            ' — attestations and snapshots after timestamp ' + timestamp + ' invalidated');

        // Emit event for indexers/consumers
        this.emit('reorg:confirmed', {
            reorgId, sourceChain: chain, reorgHeight, timestamp, affectedChains
        });
    }

    // Determine which chains are affected by a reorg on the source chain
    // For now, returns all other supported chains (Phase 4C will be smarter about this)
    _getAffectedChains(sourceChain) {
        let allChains = ['BTC', 'LTC', 'DOGE'];
        return allChains.filter(c => c !== sourceChain);
    }

    // --- Utilities ---

    _getQuorum() {
        let N = this.validatorSet.length;
        if (N <= 0) {
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        if (N <= 1) return 0;
        let f = Math.floor((N - 1) / 3);
        return 2 * f + 1;
    }

    _digest(reorgId, chain, reorgHeight, timestamp) {
        let payload = JSON.stringify({ reorgId, chain, reorgHeight, timestamp });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = ReorgHandler;
