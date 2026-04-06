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
 * XChain Hub - Cross-Chain Attestation Engine
 *
 * PBFT-based consensus for cross-chain action attestation. When an
 * action on Chain A needs to trigger an action on Chain B, validators
 * attest that the source action exists with sufficient confirmations.
 *
 * Flow: PROPOSE → PREPARE (2f+1) → COMMIT (2f+1) → store attestation
 *
 ********************************************************************/

const crypto       = require('crypto');
const EventEmitter = require('events');

const XCHAIN_ATTEST_PROPOSE = 'XCHAIN_ATTEST_PROPOSE';
const XCHAIN_ATTEST_PREPARE = 'XCHAIN_ATTEST_PREPARE';
const XCHAIN_ATTEST_COMMIT  = 'XCHAIN_ATTEST_COMMIT';

// Confirmation thresholds per chain
const CONFIRMATIONS = { BTC: 3, LTC: 3, DOGE: 6 };

const DEFAULT_ATTESTATION_TIMEOUT = 60000; // 60 seconds

class CrossChainEngine extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Validator set (shared with consensus/oracle)
        this.validatorSet = [];

        // Per-chain-pair validator sets: Map<'BTC-DOGE', [{pubkey, addr}]>
        this.chainPairValidators = new Map();

        // Pending attestations: Map<attestationId, pending>
        this.pendingAttestations = new Map();

        // Finalized attestation IDs
        this.finalized = new Set();

        // Message handler
        this._messageHandler = null;

        // Sequence counter for attestation ordering
        this.seq = 0;

        // Config
        this.timeout = parseInt(process.env.ATTESTATION_TIMEOUT) || DEFAULT_ATTESTATION_TIMEOUT;
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
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Cross-chain attestation engine started');
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

    // Request an attestation — returns a Promise that resolves when consensus is reached
    async requestAttestation(sourceChain, sourceActionIndex, destChain) {
        let attestationId = sourceChain + ':' + sourceActionIndex + ':' + destChain;
        let confirmations = CONFIRMATIONS[sourceChain] || 3;

        // Check if already attested
        if (this.finalized.has(attestationId)) {
            return await this._getStoredAttestation(attestationId);
        }

        // Single-node fallback
        let quorum = this._getQuorum(sourceChain, destChain);
        if (quorum === 0) {
            let attestation = {
                attestationId, sourceChain, sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, status: 'attested',
                validatorCount: 1, consensusProof: '[]'
            };
            await this._storeAttestation(attestation);
            return attestation;
        }

        // Check if this node is the leader for this chain pair
        this.seq++;
        let leader = this._getLeader(this.seq, sourceChain, destChain);
        if (leader && leader.addr !== this.peerManager.validatorAddr) {
            throw new Error('Not the leader for attestation (leader: ' + leader.addr + ')');
        }

        let digest = this._digest(attestationId, confirmations);

        return new Promise((resolve, reject) => {
            let pending = {
                attestationId, sourceChain, sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, digest,
                prepares: new Set(),
                commits:  new Set(),
                finalized: false,
                timer:    null,
                resolve, reject
            };

            // Add own PREPARE
            pending.prepares.add(this.peerManager.validatorAddr);
            this.pendingAttestations.set(attestationId, pending);

            // Timeout
            pending.timer = setTimeout(() => {
                if (!pending.finalized) {
                    pending.finalized = true;
                    this.pendingAttestations.delete(attestationId);
                    reject(new Error('Attestation timeout for ' + attestationId));
                }
            }, this.timeout);

            // Broadcast PROPOSE
            this.peerManager.broadcast(XCHAIN_ATTEST_PROPOSE, {
                attestationId, sourceChain,
                sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, digest
            });

            this._checkPrepareQuorum(attestationId);
        });
    }

    // Get stored attestations
    async getAttestations(status, limit) {
        let query = "SELECT * FROM attestations";
        let args = [];
        if (status) {
            query += " WHERE status = ?";
            args.push(status);
        }
        query += " ORDER BY created_at DESC LIMIT ?";
        args.push(limit || 50);
        return await this.db.doQuery(query, args);
    }

    // Get a specific attestation
    async getAttestation(sourceChain, sourceActionIndex) {
        let query = "SELECT * FROM attestations WHERE source_chain = ? AND source_action_index = ? ORDER BY created_at DESC LIMIT 1";
        let rows = await this.db.doQuery(query, [sourceChain, sourceActionIndex]);
        return rows.length > 0 ? rows[0] : null;
    }

    // --- Message handlers ---

    _handleMessage(envelope) {
        switch (envelope.type) {
            case XCHAIN_ATTEST_PROPOSE: this._handlePropose(envelope); break;
            case XCHAIN_ATTEST_PREPARE: this._handlePrepare(envelope); break;
            case XCHAIN_ATTEST_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    _handlePropose(envelope) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest } = envelope.data;
        if (!attestationId || !digest) return;
        if (this.finalized.has(attestationId)) return;

        // Verify digest
        let computedDigest = this._digest(attestationId, confirmations);
        if (computedDigest !== digest) return;

        // TODO (Phase 4C): Verify the source action exists in our synced indexer DB
        // For now, trust the proposer's claim

        // Create pending if not exists
        if (!this.pendingAttestations.has(attestationId)) {
            this.pendingAttestations.set(attestationId, {
                attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest,
                prepares: new Set(),
                commits:  new Set(),
                finalized: false,
                timer: setTimeout(() => {
                    this.pendingAttestations.delete(attestationId);
                }, this.timeout * 2),
                resolve: null, reject: null
            });
        }

        let pending = this.pendingAttestations.get(attestationId);
        pending.prepares.add(envelope.sender);
        pending.prepares.add(this.peerManager.validatorAddr);

        // Send PREPARE
        this.peerManager.broadcast(XCHAIN_ATTEST_PREPARE, {
            attestationId, digest
        });

        this._checkPrepareQuorum(attestationId);
    }

    _handlePrepare(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        this._checkPrepareQuorum(attestationId);
    }

    _handleCommit(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        pending.commits.add(envelope.sender);
        this._checkCommitQuorum(attestationId);
    }

    _checkPrepareQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.prepares.size >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            this.peerManager.broadcast(XCHAIN_ATTEST_COMMIT, {
                attestationId:  attestationId,
                digest:         pending.digest
            });

            this._checkCommitQuorum(attestationId);
        }
    }

    _checkCommitQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.commits.size >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let attestation = {
                attestationId:     pending.attestationId,
                sourceChain:       pending.sourceChain,
                sourceActionIndex: pending.sourceActionIndex,
                destChain:         pending.destChain,
                confirmations:     pending.confirmations,
                status:            'attested',
                validatorCount:    pending.prepares.size,
                consensusProof:    JSON.stringify([...pending.commits])
            };

            this._storeAttestation(attestation)
                .then(() => {
                    this.finalized.add(attestationId);
                    this.pendingAttestations.delete(attestationId);

                    console.log('CrossChain: Attestation finalized — ' + attestationId +
                        ' (' + pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits)');

                    // Emit for downstream processing
                    this.emit('attestation:finalized', attestation);

                    if (pending.resolve) pending.resolve(attestation);
                })
                .catch(err => {
                    console.error('CrossChain: Error storing attestation:', err.message);
                    this.pendingAttestations.delete(attestationId);
                    if (pending.reject) pending.reject(err);
                });
        }
    }

    // --- Storage ---

    async _storeAttestation(attestation) {
        let query = `INSERT INTO attestations
            (attestation_id, source_chain, source_action_index, dest_chain,
             confirmations, status, validator_count, consensus_proof)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, validator_count = ?, consensus_proof = ?, updated_at = NOW()`;
        await this.db.doQuery(query, [
            attestation.attestationId, attestation.sourceChain, attestation.sourceActionIndex,
            attestation.destChain, attestation.confirmations, attestation.status,
            attestation.validatorCount, attestation.consensusProof,
            attestation.status, attestation.validatorCount, attestation.consensusProof
        ]);
    }

    async _getStoredAttestation(attestationId) {
        let rows = await this.db.doQuery(
            "SELECT * FROM attestations WHERE attestation_id = ? LIMIT 1",
            [attestationId]
        );
        return rows.length > 0 ? rows[0] : null;
    }

    // --- Utilities ---

    // Get the validator set for a specific chain pair, or fall back to the full set
    _getChainPairSet(sourceChain, destChain) {
        if (this.chainPairValidators.size > 0) {
            // Try both orderings of the chain pair
            let key1 = sourceChain + '-' + destChain;
            let key2 = destChain + '-' + sourceChain;
            let set = this.chainPairValidators.get(key1) || this.chainPairValidators.get(key2);
            if (set && set.length > 0) return set;
        }
        // Fall back to full validator set
        return this.validatorSet;
    }

    _getLeader(seq, sourceChain, destChain) {
        let set = (sourceChain && destChain)
            ? this._getChainPairSet(sourceChain, destChain)
            : this.validatorSet;
        if (set.length === 0) return null;
        return set[seq % set.length];
    }

    _getQuorum(sourceChain, destChain) {
        let N;
        if (sourceChain && destChain) {
            let set = this._getChainPairSet(sourceChain, destChain);
            N = set.length;
        } else {
            N = this.validatorSet.length;
        }
        if (N <= 0) {
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        if (N <= 1) return 0;
        let f = Math.floor((N - 1) / 3);
        return 2 * f + 1;
    }

    _digest(attestationId, confirmations) {
        let payload = JSON.stringify({ attestationId, confirmations });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = CrossChainEngine;
