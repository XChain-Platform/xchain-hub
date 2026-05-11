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
 * XChain Hub - Oracle Round Manager
 *
 * Manages the price oracle round lifecycle. Each round:
 * 1. Fetches prices from external APIs via PriceFetcher
 * 2. Broadcasts the local price submission via gossip
 * 3. Collects other validators' submissions
 * 4. Stores submissions in MariaDB
 *
 * Phase 3A: Submission collection only.
 * Phase 3B will add aggregation, consensus, and finalization.
 *
 ********************************************************************/

const PriceFetcher = require('./PriceFetcher.js');

const ORACLE_PRICE_SUBMIT = 'ORACLE_PRICE_SUBMIT';

class OracleRound {

    constructor(hub) {
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;
        this.identity    = hub.getIdentity();
        this.config      = hub.p2pConfig || {};

        // Price fetcher
        this.priceFetcher = new PriceFetcher(this.config);

        // Round state
        this.currentRound    = 0;
        this.roundStartTime  = 0;
        this.roundTimer      = null;

        // Submissions per round: Map<round, Map<sender, { prices, sources, timestamp }>>
        this.submissions = new Map();

        // Oracle consensus engine (set via setConsensus after creation)
        this.oracleConsensus = null;

        // Finalization timer
        this.finalizationTimer = null;

        // Message handler reference
        this._messageHandler = null;

        // Config
        this.roundInterval    = this.config.ORACLE_ROUND_INTERVAL || 600000;     // 10 minutes
        this.submissionWindow = this.config.ORACLE_SUBMISSION_WINDOW || 180000;   // 3 minutes
    }

    // Set the oracle consensus engine (called by XChainHub after both are created)
    setConsensus(oracleConsensus) {
        this.oracleConsensus = oracleConsensus;
    }

    // Start the oracle round system
    async start() {
        // Subscribe to gossip messages
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Start the round timer
        this._startRoundTimer();

        console.log('Oracle round system started (interval: ' + (this.roundInterval / 1000) + 's, window: ' + (this.submissionWindow / 1000) + 's)');

        // Run the first round immediately (after a short delay for peer connections)
        setTimeout(() => this._executeRound(), 5000);
    }

    // Stop the oracle round system
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if (this.roundTimer) {
            clearInterval(this.roundTimer);
            this.roundTimer = null;
        }
        if (this.finalizationTimer) {
            clearTimeout(this.finalizationTimer);
            this.finalizationTimer = null;
        }
    }

    // Get the current round number
    getCurrentRound() {
        return this.currentRound;
    }

    // Get submissions for a given round
    // Returns: Map<sender, { prices, sources, timestamp }> or undefined
    getSubmissions(round) {
        return this.submissions.get(round || this.currentRound);
    }

    // Get all submissions as a serializable object (for JSON-RPC diagnostics)
    getSubmissionsInfo() {
        let info = {};
        for (let [round, subs] of this.submissions) {
            info[round] = {};
            for (let [sender, data] of subs) {
                info[round][sender] = data;
            }
        }
        return {
            currentRound:    this.currentRound,
            roundStartTime:  this.roundStartTime,
            roundInterval:   this.roundInterval,
            submissionWindow: this.submissionWindow,
            submissions:     info
        };
    }

    // --- Private methods ---

    // Start the periodic round timer
    _startRoundTimer() {
        this.roundTimer = setInterval(() => {
            this._executeRound();
        }, this.roundInterval);
    }

    // Execute a single round: fetch prices, broadcast submission
    async _executeRound() {
        this.currentRound++;
        this.roundStartTime = Date.now();

        // Prune old submissions (keep current and previous round only)
        this._pruneSubmissions();

        // Initialize submission map for this round
        if (!this.submissions.has(this.currentRound)) {
            this.submissions.set(this.currentRound, new Map());
        }

        // Fetch prices from external sources
        let prices;
        try {
            prices = await this.priceFetcher.fetchPrices();
        } catch (err) {
            console.error('Oracle: Price fetch failed for round ' + this.currentRound + ':', err.message);
            return;
        }

        if (!prices || prices.length === 0) {
            console.warn('Oracle: No prices available for round ' + this.currentRound);
            return;
        }

        // Count total sources across all pairs
        let totalSources = prices.reduce((sum, p) => sum + p.sources, 0);

        console.log('Oracle: Round ' + this.currentRound + ' — fetched ' + prices.length +
            ' pairs from ' + totalSources + ' source queries');

        // Broadcast our submission via gossip
        this.peerManager.broadcast(ORACLE_PRICE_SUBMIT, {
            round:   this.currentRound,
            prices:  prices,
            sources: totalSources
        });

        // Record our own submission
        let myAddr = this.peerManager.validatorAddr;
        this.submissions.get(this.currentRound).set(myAddr, {
            prices:    prices,
            sources:   totalSources,
            timestamp: Date.now()
        });

        // Persist to DB (fire and forget)
        this._persistSubmissions(this.currentRound, myAddr, prices);

        // Schedule finalization after the submission window closes
        this._scheduleFinalization(this.currentRound);
    }

    // Schedule finalization for a round after the submission window
    _scheduleFinalization(round) {
        if (this.finalizationTimer) clearTimeout(this.finalizationTimer);
        this.finalizationTimer = setTimeout(() => {
            if (this.oracleConsensus) {
                this.oracleConsensus.finalizeRound(round).catch(err => {
                    console.error('Oracle: Finalization error for round ' + round + ':', err.message);
                });
            }
        }, this.submissionWindow);
    }

    // Handle incoming gossip messages
    _handleMessage(envelope) {
        if (envelope.type !== ORACLE_PRICE_SUBMIT) return;

        let { round, prices, sources } = envelope.data;
        if (!round || !prices || !Array.isArray(prices)) return;

        // Only accept submissions for current or next round
        if (round < this.currentRound - 1 || round > this.currentRound + 1) return;

        // Check if we're still within the submission window
        let elapsed = Date.now() - this.roundStartTime;
        if (round === this.currentRound && elapsed > this.submissionWindow) {
            // Late submission — still record it but log
            console.log('Oracle: Late submission from ' + envelope.sender + ' for round ' + round);
        }

        // Initialize submission map for this round if needed
        if (!this.submissions.has(round)) {
            this.submissions.set(round, new Map());
        }

        // Record the submission (first submission per sender per round wins)
        let roundSubs = this.submissions.get(round);
        if (roundSubs.has(envelope.sender)) return; // Already have a submission from this sender

        roundSubs.set(envelope.sender, {
            prices:    prices,
            sources:   sources || 0,
            timestamp: envelope.timestamp
        });

        console.log('Oracle: Received submission from ' + envelope.sender +
            ' for round ' + round + ' (' + roundSubs.size + ' total)');

        // Resolve sender's validator pubkey. Drop the DB persist if unresolved —
        // keeps the in-memory submission for aggregation but avoids placeholder rows.
        let validatorPubkey = null;
        if (this.peerManager.validatorPubkeys) {
            let pk = this.peerManager.validatorPubkeys.get(envelope.sender);
            if (pk) validatorPubkey = pk;
        }
        if (!validatorPubkey) {
            console.warn('Oracle: skipping DB persist for unregistered sender ' + envelope.sender +
                ' (call syncvalidators to register the peer)');
            return;
        }
        this._persistSubmissions(round, envelope.sender, prices, validatorPubkey);
    }

    // Persist price submissions to the database
    _persistSubmissions(round, sender, prices, validatorPubkey) {
        // Resolve pubkey for self
        if (!validatorPubkey && this.identity) {
            validatorPubkey = this.identity.getPubkeyHex();
        }
        if (!validatorPubkey) {
            validatorPubkey = '0000000000000000000000000000000000000000000000000000000000000000';
        }

        for (let p of prices) {
            let query = `INSERT INTO oracle_submissions (round_number, coin_pair, validator_pubkey, price, sources)
                         VALUES (?, ?, ?, ?, ?)`;
            this.db.doQuery(query, [round, p.coinPair, validatorPubkey, p.price, p.sources])
                .catch(e => {
                    // Ignore duplicate entries (same round + pair + validator)
                    if (e.code !== 'ER_DUP_ENTRY') {
                        console.error('Oracle: Error persisting submission:', e.message);
                    }
                });
        }
    }

    // Prune old submission data (keep current and previous round only)
    _pruneSubmissions() {
        for (let [round] of this.submissions) {
            if (round < this.currentRound - 1) {
                this.submissions.delete(round);
            }
        }
    }
}

module.exports = OracleRound;
