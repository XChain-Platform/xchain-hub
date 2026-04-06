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
 * XChain Hub - PBFT Consensus Engine
 *
 * Implements a simplified PBFT (Practical Byzantine Fault Tolerance)
 * consensus protocol for config writes. Ensures all hub instances
 * agree on config state before applying changes.
 *
 * Flow: PRE_PREPARE → PREPARE (2f+1) → COMMIT (2f+1) → Apply
 *
 * Single-node fallback: when no peers are connected, writes are
 * applied directly without consensus.
 *
 ********************************************************************/

const crypto = require('crypto');

const PBFT_PRE_PREPARE = 'PBFT_PRE_PREPARE';
const PBFT_PREPARE     = 'PBFT_PREPARE';
const PBFT_COMMIT      = 'PBFT_COMMIT';

const DEFAULT_TIMEOUT = 30000; // 30 seconds

class Consensus {

    constructor(hub) {
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Sequence counter (loaded from DB on start)
        this.seq = 0;

        // Pending proposals: Map<seq, proposal>
        // proposal = { config, digest, prepares: Set<sender>, commits: Set<sender>,
        //              resolved: bool, timer, resolve, reject, applied: bool }
        this.pendingProposals = new Map();

        // Digests already applied (prevents double-apply from late COMMIT messages)
        this.applied = new Set();

        // Message handler reference (for cleanup)
        this._messageHandler = null;

        // Config
        this.timeout = parseInt(process.env.PBFT_TIMEOUT) || DEFAULT_TIMEOUT;
    }

    // Start the consensus engine
    async start() {
        // Load last sequence number from DB
        await this._loadSeq();

        // Subscribe to P2P messages
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        console.log('Consensus engine started (seq: ' + this.seq + ')');
    }

    // Stop the consensus engine
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }

        // Reject all pending proposals
        for (let [seq, proposal] of this.pendingProposals) {
            if (!proposal.resolved) {
                proposal.resolved = true;
                if (proposal.timer) clearTimeout(proposal.timer);
                if (proposal.reject) proposal.reject(new Error('Consensus engine stopped'));
            }
        }
        this.pendingProposals.clear();
    }

    // Propose a config change — returns a Promise that resolves when consensus is reached
    async propose(config) {
        // Single-node fallback: no peers connected → apply directly
        let quorum = this._getQuorum();
        if (quorum === 0) {
            await this._applyConfig(config);
            return true;
        }

        // Increment sequence
        this.seq++;
        let seq = this.seq;
        let digest = this._digest(config);

        // Create proposal
        return new Promise((resolve, reject) => {
            let proposal = {
                config:   config,
                digest:   digest,
                prepares: new Set(),
                commits:  new Set(),
                resolved: false,
                applied:  false,
                timer:    null,
                resolve:  resolve,
                reject:   reject
            };

            // Add own PREPARE vote
            proposal.prepares.add(this.peerManager.validatorAddr);

            this.pendingProposals.set(seq, proposal);

            // Set timeout
            proposal.timer = setTimeout(() => {
                if (!proposal.resolved) {
                    proposal.resolved = true;
                    this.pendingProposals.delete(seq);
                    reject(new Error('Consensus timeout for seq ' + seq + ' (received ' +
                        proposal.prepares.size + ' prepares, ' + proposal.commits.size + ' commits, need ' + quorum + ')'));
                }
            }, this.timeout);

            // Broadcast PRE_PREPARE with the full config
            this.peerManager.broadcast(PBFT_PRE_PREPARE, {
                seq:          seq,
                configDigest: digest,
                config:       config
            });

            // Check if we already have quorum (unlikely but handles edge case)
            this._checkPrepareQuorum(seq);
        });
    }

    // --- Private methods ---

    // Handle incoming P2P messages
    _handleMessage(envelope) {
        switch (envelope.type) {
            case PBFT_PRE_PREPARE: this._handlePrePrepare(envelope); break;
            case PBFT_PREPARE:     this._handlePrepare(envelope);    break;
            case PBFT_COMMIT:      this._handleCommit(envelope);     break;
        }
    }

    // Handle PRE_PREPARE: validate and respond with PREPARE
    _handlePrePrepare(envelope) {
        let { seq, configDigest, config } = envelope.data;

        // Validate
        if (!seq || !configDigest || !config) return;
        if (typeof seq !== 'number' || seq <= 0) return;

        // Verify digest matches the config
        let computedDigest = this._digest(config);
        if (computedDigest !== configDigest) {
            console.warn('PBFT: PRE_PREPARE digest mismatch from ' + envelope.sender + ' (seq ' + seq + ')');
            return;
        }

        // If we already have this proposal, don't create a duplicate
        if (!this.pendingProposals.has(seq)) {
            // Create a follower proposal (no resolve/reject — we didn't initiate it)
            let proposal = {
                config:   config,
                digest:   configDigest,
                prepares: new Set(),
                commits:  new Set(),
                resolved: false,
                applied:  false,
                timer:    null,
                resolve:  null,
                reject:   null
            };

            // Set cleanup timeout (follower proposals expire too)
            proposal.timer = setTimeout(() => {
                if (!proposal.resolved) {
                    proposal.resolved = true;
                    this.pendingProposals.delete(seq);
                }
            }, this.timeout * 2); // Followers wait longer — they don't report to a client

            this.pendingProposals.set(seq, proposal);
        }

        let proposal = this.pendingProposals.get(seq);

        // Add proposer's implicit PREPARE
        proposal.prepares.add(envelope.sender);
        // Add our own PREPARE
        proposal.prepares.add(this.peerManager.validatorAddr);

        // Broadcast PREPARE
        this.peerManager.broadcast(PBFT_PREPARE, {
            seq:          seq,
            configDigest: configDigest
        });

        // Check quorum
        this._checkPrepareQuorum(seq);
    }

    // Handle PREPARE: collect votes and check quorum
    _handlePrepare(envelope) {
        let { seq, configDigest } = envelope.data;
        if (!seq || !configDigest) return;

        let proposal = this.pendingProposals.get(seq);
        if (!proposal) return;

        // Verify digest matches
        if (configDigest !== proposal.digest) return;

        // Record the PREPARE vote
        proposal.prepares.add(envelope.sender);

        // Check if we have enough PREPAREs to move to COMMIT
        this._checkPrepareQuorum(seq);
    }

    // Check if PREPARE quorum is reached → broadcast COMMIT
    _checkPrepareQuorum(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (!proposal || proposal.resolved) return;

        let quorum = this._getQuorum();
        if (proposal.prepares.size >= quorum) {
            // Only broadcast COMMIT once
            if (!proposal._commitSent) {
                proposal._commitSent = true;

                // Add own COMMIT vote
                proposal.commits.add(this.peerManager.validatorAddr);

                this.peerManager.broadcast(PBFT_COMMIT, {
                    seq:          seq,
                    configDigest: proposal.digest
                });

                // Check if commit quorum is already met
                this._checkCommitQuorum(seq);
            }
        }
    }

    // Handle COMMIT: collect votes and check quorum
    _handleCommit(envelope) {
        let { seq, configDigest } = envelope.data;
        if (!seq || !configDigest) return;

        let proposal = this.pendingProposals.get(seq);
        if (!proposal) return;

        // Verify digest matches
        if (configDigest !== proposal.digest) return;

        // Record the COMMIT vote
        proposal.commits.add(envelope.sender);

        // Check if we have enough COMMITs to apply
        this._checkCommitQuorum(seq);
    }

    // Check if COMMIT quorum is reached → apply the config
    _checkCommitQuorum(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (!proposal || proposal.applied) return;

        let quorum = this._getQuorum();
        if (proposal.commits.size >= quorum) {
            proposal.applied = true;

            // Apply the config
            this._applyConfig(proposal.config).then(() => {
                // Update sequence in DB
                this._saveSeq(seq);

                // Resolve the proposer's promise (if we initiated)
                if (!proposal.resolved && proposal.resolve) {
                    proposal.resolved = true;
                    if (proposal.timer) clearTimeout(proposal.timer);
                    proposal.resolve(true);
                }

                // Track applied digest
                this.applied.add(proposal.digest);
                this.pendingProposals.delete(seq);

                console.log('PBFT: Config applied (seq ' + seq + ', ' +
                    proposal.prepares.size + ' prepares, ' +
                    proposal.commits.size + ' commits)');

            }).catch((err) => {
                console.error('PBFT: Error applying config (seq ' + seq + '):', err.message);
                if (!proposal.resolved && proposal.reject) {
                    proposal.resolved = true;
                    if (proposal.timer) clearTimeout(proposal.timer);
                    proposal.reject(err);
                }
                this.pendingProposals.delete(seq);
            });
        }
    }

    // Apply a config blob to the database
    async _applyConfig(config) {
        await this.hub.applyConfig(config);
    }

    // Calculate quorum size
    _getQuorum() {
        if (!this.peerManager) return 0;
        let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
        let N = peers.length + 1; // +1 for self
        if (N === 1) return 0;    // Single node — no consensus needed
        let f = Math.floor((N - 1) / 3);
        return 2 * f + 1;
    }

    // Compute SHA-256 digest of a config object
    _digest(config) {
        let json = JSON.stringify(config);
        return crypto.createHash('sha256').update(json).digest('hex');
    }

    // Load sequence number from DB
    async _loadSeq() {
        try {
            let rows = await this.db.doQuery(
                "SELECT value FROM consensus_state WHERE key_name = ?",
                ['last_seq']
            );
            if (rows.length > 0) {
                this.seq = parseInt(rows[0].value) || 0;
            }
        } catch (e) {
            console.error('Error loading consensus sequence:', e.message);
        }
    }

    // Save sequence number to DB
    async _saveSeq(seq) {
        try {
            await this.db.doQuery(
                "INSERT INTO consensus_state (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()",
                ['last_seq', String(seq), String(seq)]
            );
        } catch (e) {
            console.error('Error saving consensus sequence:', e.message);
        }
    }
}

module.exports = Consensus;
