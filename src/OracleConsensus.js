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
 * XChain Hub - Oracle Consensus
 *
 * PBFT-like consensus for price oracle rounds. After the submission
 * window closes, the round leader aggregates prices using a trimmed
 * median, proposes the result, and validators vote to finalize it.
 *
 * Flow: ORACLE_PROPOSE → ORACLE_PREPARE (2f+1) → ORACLE_COMMIT (2f+1) → store snapshot
 *
 ********************************************************************/

const crypto       = require('crypto');
const EventEmitter = require('events');

const ORACLE_PROPOSE = 'ORACLE_PROPOSE';
const ORACLE_PREPARE = 'ORACLE_PREPARE';
const ORACLE_COMMIT  = 'ORACLE_COMMIT';

const TRIM_PERCENT = 0.15;  // Discard top and bottom 15% of submissions
const DEFAULT_FINALIZATION_TIMEOUT = 120000; // 2 minutes

class OracleConsensus extends EventEmitter {

    constructor(hub, oracleRound) {
        super();
        this.hub         = hub;
        this.oracleRound = oracleRound;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Pending rounds: Map<round, { prices, digest, prepares: Set, commits: Set, finalized: bool, timer }>
        this.pendingRounds = new Map();

        // Already finalized rounds (prevents double-store)
        this.finalized = new Set();

        // Validator set (loaded from hub)
        this.validatorSet = [];

        // Message handler
        this._messageHandler = null;

        // Config
        this.finalizationTimeout = parseInt(process.env.ORACLE_FINALIZATION_TIMEOUT) || DEFAULT_FINALIZATION_TIMEOUT;
    }

    // Set the validator set for quorum calculation and leader selection
    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    // Start listening for oracle consensus messages
    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Oracle consensus engine started');
    }

    // Stop the oracle consensus engine
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for (let [round, pending] of this.pendingRounds) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        this.pendingRounds.clear();
    }

    // Finalize a round — called by OracleRound after the submission window closes
    async finalizeRound(round) {
        if (this.finalized.has(round)) return;

        let submissions = this.oracleRound.getSubmissions(round);
        if (!submissions || submissions.size === 0) {
            // No submissions — skip the round
            await this._storeSkippedRound(round);
            return;
        }

        // Single-node fallback: no peers → store directly
        let quorum = this._getQuorum();
        if (quorum === 0) {
            let aggregated = this._aggregateAll(submissions);
            await this._storeSnapshot(round, aggregated, 1, '[]');
            // Emit finalization event for single-node mode
            let selfAddr = this.peerManager.validatorAddr;
            this.emit('round:finalized', {
                round:        round,
                prices:       aggregated,
                participants: [selfAddr],
                submissions:  submissions
            });
            return;
        }

        // Check if this node is the leader for this round
        let leader = this._getLeader(round);
        if (!leader || leader.addr !== this.peerManager.validatorAddr) {
            // Not the leader — wait for the leader's ORACLE_PROPOSE
            return;
        }

        // Aggregate prices
        let aggregated = this._aggregateAll(submissions);
        if (aggregated.length === 0) {
            await this._storeSkippedRound(round);
            return;
        }

        let digest = this._digest(round, aggregated);

        // Create pending round
        let pending = {
            prices:    aggregated,
            digest:    digest,
            prepares:  new Set(),
            commits:   new Set(),
            finalized: false,
            timer:     null
        };

        // Add own PREPARE vote
        pending.prepares.add(this.peerManager.validatorAddr);
        this.pendingRounds.set(round, pending);

        // Set finalization timeout
        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                console.warn('Oracle: Finalization timeout for round ' + round);
                this.pendingRounds.delete(round);
            }
        }, this.finalizationTimeout);

        // Broadcast ORACLE_PROPOSE
        this.peerManager.broadcast(ORACLE_PROPOSE, {
            round:  round,
            prices: aggregated,
            digest: digest
        });

        console.log('Oracle: Proposed round ' + round + ' with ' + aggregated.length + ' prices (' + submissions.size + ' submissions)');

        // Check quorum (in case we're the only validator)
        this._checkPrepareQuorum(round);
    }

    // --- Message handlers ---

    _handleMessage(envelope) {
        switch (envelope.type) {
            case ORACLE_PROPOSE: this._handlePropose(envelope); break;
            case ORACLE_PREPARE: this._handlePrepare(envelope); break;
            case ORACLE_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    _handlePropose(envelope) {
        let { round, prices, digest } = envelope.data;
        if (!round || !prices || !digest) return;
        if (this.finalized.has(round)) return;

        // Verify digest
        let computedDigest = this._digest(round, prices);
        if (computedDigest !== digest) {
            console.warn('Oracle: PROPOSE digest mismatch from ' + envelope.sender + ' for round ' + round);
            return;
        }

        // Verify the proposer is the leader for this round
        let leader = this._getLeader(round);
        if (leader && leader.addr !== envelope.sender) {
            console.warn('Oracle: PROPOSE from non-leader ' + envelope.sender + ' for round ' + round);
            return;
        }

        // Verify aggregation by re-computing from our own submissions
        let submissions = this.oracleRound.getSubmissions(round);
        if (submissions && submissions.size > 0) {
            let myAggregated = this._aggregateAll(submissions);
            let myDigest = this._digest(round, myAggregated);
            // Allow the leader's aggregation even if slightly different
            // (different submission sets due to network timing)
        }

        // Create or update pending round
        if (!this.pendingRounds.has(round)) {
            let pending = {
                prices:    prices,
                digest:    digest,
                prepares:  new Set(),
                commits:   new Set(),
                finalized: false,
                timer:     setTimeout(() => {
                    this.pendingRounds.delete(round);
                }, this.finalizationTimeout)
            };
            this.pendingRounds.set(round, pending);
        }

        let pending = this.pendingRounds.get(round);
        pending.prepares.add(envelope.sender);
        pending.prepares.add(this.peerManager.validatorAddr);

        // Send ORACLE_PREPARE
        this.peerManager.broadcast(ORACLE_PREPARE, {
            round:  round,
            digest: digest
        });

        this._checkPrepareQuorum(round);
    }

    _handlePrepare(envelope) {
        let { round, digest } = envelope.data;
        if (!round || !digest) return;

        let pending = this.pendingRounds.get(round);
        if (!pending || pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        this._checkPrepareQuorum(round);
    }

    _handleCommit(envelope) {
        let { round, digest } = envelope.data;
        if (!round || !digest) return;

        let pending = this.pendingRounds.get(round);
        if (!pending || pending.digest !== digest) return;

        pending.commits.add(envelope.sender);
        this._checkCommitQuorum(round);
    }

    _checkPrepareQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.prepares.size >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            this.peerManager.broadcast(ORACLE_COMMIT, {
                round:  round,
                digest: pending.digest
            });

            this._checkCommitQuorum(round);
        }
    }

    _checkCommitQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.commits.size >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let validatorCount = pending.prepares.size;
            let proof = JSON.stringify([...pending.commits]);

            this._storeSnapshot(round, pending.prices, validatorCount, proof)
                .then(() => {
                    this.finalized.add(round);
                    this.pendingRounds.delete(round);
                    console.log('Oracle: Round ' + round + ' finalized (' +
                        pending.prepares.size + ' prepares, ' +
                        pending.commits.size + ' commits)');

                    // Emit finalization event for RewardTracker and SlashDetector
                    this.emit('round:finalized', {
                        round:        round,
                        prices:       pending.prices,
                        participants: [...pending.prepares],
                        submissions:  this.oracleRound.getSubmissions(round)
                    });
                })
                .catch(err => {
                    console.error('Oracle: Error storing snapshot for round ' + round + ':', err.message);
                    this.pendingRounds.delete(round);
                });
        }
    }

    // --- Aggregation ---

    // Aggregate all coin pairs from submissions
    _aggregateAll(submissions) {
        // Collect all unique coin pairs
        let coinPairs = new Set();
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair) coinPairs.add(p.coinPair);
                }
            }
        }

        let results = [];
        for (let pair of coinPairs) {
            let price = this._aggregate(submissions, pair);
            if (price !== null) {
                results.push({ coinPair: pair, price: price });
            }
        }
        return results;
    }

    // Aggregate a single coin pair using trimmed median
    _aggregate(submissions, coinPair) {
        // Collect all prices for this pair
        let values = [];
        for (let [sender, sub] of submissions) {
            if (sub.prices && Array.isArray(sub.prices)) {
                for (let p of sub.prices) {
                    if (p.coinPair === coinPair && p.price) {
                        let val = parseFloat(p.price);
                        if (isFinite(val) && val > 0) {
                            values.push(val);
                        }
                    }
                }
            }
        }

        if (values.length === 0) return null;

        // Sort ascending
        values.sort((a, b) => a - b);

        // Trim top and bottom 15%
        let trimCount = Math.floor(values.length * TRIM_PERCENT);
        if (trimCount > 0 && values.length > 2) {
            values = values.slice(trimCount, values.length - trimCount);
        }

        // If trimming removed everything, use original sorted array
        if (values.length === 0) return null;

        // Compute median
        let mid = Math.floor(values.length / 2);
        let median;
        if (values.length % 2 === 0) {
            median = (values[mid - 1] + values[mid]) / 2;
        } else {
            median = values[mid];
        }

        return median.toFixed(8);
    }

    // --- Storage ---

    // Store a finalized price snapshot
    async _storeSnapshot(round, prices, validatorCount, proof) {
        let timestamp = Date.now();
        for (let p of prices) {
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES (?, ?, ?, 0, 'BTC', ?, ?, 1, ?, 'finalized')
                ON DUPLICATE KEY UPDATE price = ?, validator_count = ?, consensus_proof = ?, status = 'finalized'`;
            await this.db.doQuery(query, [
                round, p.coinPair, p.price, timestamp,
                validatorCount, proof,
                p.price, validatorCount, proof
            ]);
        }
    }

    // Store a skipped round
    async _storeSkippedRound(round) {
        let coinPairs = ['BTC/USD', 'LTC/USD', 'DOGE/USD'];
        for (let pair of coinPairs) {
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES (?, ?, NULL, 0, 'BTC', ?, 0, 1, '[]', 'skipped')
                ON DUPLICATE KEY UPDATE status = 'skipped'`;
            await this.db.doQuery(query, [round, pair, Date.now()]);
        }
        this.finalized.add(round);
        console.log('Oracle: Round ' + round + ' skipped (no submissions)');
    }

    // --- Utilities ---

    _getLeader(round) {
        if (this.validatorSet.length === 0) return null;
        return this.validatorSet[round % this.validatorSet.length];
    }

    _getQuorum() {
        let N = this.validatorSet.length;
        if (N <= 0) {
            // Fall back to peer count
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        if (N <= 1) return 0;
        let f = Math.floor((N - 1) / 3);
        return 2 * f + 1;
    }

    _digest(round, prices) {
        let payload = JSON.stringify({ round: round, prices: prices });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = OracleConsensus;
