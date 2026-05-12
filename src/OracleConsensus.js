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

const crypto            = require('crypto');
const EventEmitter      = require('events');
const PriceFetcher      = require('./PriceFetcher.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');

const ORACLE_PROPOSE = 'ORACLE_PROPOSE';
const ORACLE_PREPARE = 'ORACLE_PREPARE';
const ORACLE_COMMIT  = 'ORACLE_COMMIT';

const TRIM_PERCENT = 0.15;  // Discard top and bottom 15% of submissions
const DEFAULT_FINALIZATION_TIMEOUT = 120000; // 2 minutes
const FALLBACK_GRACE_MS = 3000;  // brief grace before fallback proposer takes over

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
        this.minSubmissions      = parseInt(process.env.ORACLE_MIN_SUBMISSIONS) || 1;
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

    // Finalize a round — called by OracleRound after the submission window closes.
    // btcBlockHeight and btcBlockTime are the BTC chain tip at the time the round was
    // triggered (used for the on-chain PRICE v0 anchor).
    //
    // If we're the deterministic leader, propose immediately. If we're a follower
    // and the leader is missing from submissions (e.g. its CoinGecko fetch failed),
    // the hub with the lowest addr (lex) among submitters takes over as fallback
    // proposer after a brief grace period — salvages rounds where the leader has
    // no prices but other hubs do.
    async finalizeRound(round, btcBlockHeight, btcBlockTime) {
        if (this.finalized.has(round)) return;

        // Default to round number if BTC tip is unavailable (early bootstrap)
        btcBlockHeight = btcBlockHeight || round;
        btcBlockTime   = btcBlockTime   || Math.floor(Date.now() / 1000);

        let submissions = this.oracleRound.getSubmissions(round);
        if (!submissions || submissions.size === 0) {
            // No submissions — skip the round
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime);
            return;
        }

        // Enforce minimum submission count
        if (submissions.size < this.minSubmissions) {
            console.warn('Oracle: Round ' + round + ' has only ' + submissions.size +
                ' submission(s); minimum is ' + this.minSubmissions + ' — skipping');
            await this._storeSkippedRound(round, btcBlockHeight, btcBlockTime);
            return;
        }

        // Single-node fallback: no peers → store directly
        let quorum = this._getQuorum();
        if (quorum === 0) {
            let aggregated = this._aggregateAll(submissions);
            // Sign locally and embed in the proof so the publisher can include the sig in PRICE v0
            let mySig = this._signPriceV0(round, btcBlockTime, aggregated);
            let sigsArray = mySig ? [{ pubkey: mySig.pubkey, sig: mySig.sig }] : [];
            await this._storeSnapshot(round, aggregated, 1, JSON.stringify(sigsArray), btcBlockHeight, btcBlockTime);
            // Emit finalization event for single-node mode
            let selfAddr = this.peerManager.validatorAddr;
            this.emit('round:finalized', {
                round:          round,
                btcBlockHeight: btcBlockHeight,
                btcBlockTime:   btcBlockTime,
                prices:         aggregated,
                participants:   [selfAddr],
                signatures:     sigsArray,
                submissions:    submissions
            });
            return;
        }

        let leader   = this._getLeader(round);
        let myAddr   = this.peerManager.validatorAddr;
        let isLeader = leader && leader.addr === myAddr;

        if (isLeader) {
            this._proposeRound(round, submissions, false, btcBlockHeight, btcBlockTime);
            return;
        }

        // Follower path.
        let leaderSubmitted = leader && submissions.has(leader.addr);
        if (leaderSubmitted) {
            // Leader will propose — wait for ORACLE_PROPOSE.
            return;
        }

        // Leader has no submission. Lowest addr (lex) among submitters takes over.
        let fallbackAddr = [...submissions.keys()].sort()[0];
        if (fallbackAddr !== myAddr) {
            // Someone else is the fallback. Wait for their PROPOSE.
            return;
        }

        // I'm the fallback. Grace period in case a real-leader PROPOSE is in flight;
        // if pendingRounds gets populated during the grace, abort.
        setTimeout(() => {
            if (this.pendingRounds.has(round) || this.finalized.has(round)) return;
            let subs = this.oracleRound.getSubmissions(round);
            if (!subs || subs.size === 0) return;
            this._proposeRound(round, subs, true, btcBlockHeight, btcBlockTime);
        }, FALLBACK_GRACE_MS);
    }

    // Propose a round (used both by the real leader and the fallback proposer)
    _proposeRound(round, submissions, isFallback, btcBlockHeight, btcBlockTime) {
        let aggregated = this._aggregateAll(submissions);
        if (aggregated.length === 0) {
            this._storeSkippedRound(round, btcBlockHeight, btcBlockTime).catch(err =>
                console.error('Oracle: Error storing skipped round ' + round + ':', err.message));
            return;
        }

        let digest = this._digest(round, aggregated);

        // Sign the canonical PRICE v0 payload locally (this validator's contribution
        // to the on-chain anchor). Embedded in the published PRICE v0 transaction along
        // with sigs from other validators.
        let mySig = this._signPriceV0(round, btcBlockTime, aggregated);

        let pending = {
            round:          round,
            prices:         aggregated,
            digest:         digest,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            prepares:       new Set(),
            commits:        new Set(),
            signatures:     new Map(),  // pubkey (hex) -> sig (hex)
            finalized:      false,
            timer:          null
        };

        // Add own PREPARE vote and signature
        pending.prepares.add(this.peerManager.validatorAddr);
        if (mySig) pending.signatures.set(mySig.pubkey, mySig.sig);
        this.pendingRounds.set(round, pending);

        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                console.warn('Oracle: Finalization timeout for round ' + round);
                this.pendingRounds.delete(round);
            }
        }, this.finalizationTimeout);

        // Broadcast ORACLE_PROPOSE (includes proposer's signature on the canonical PRICE v0 payload)
        this.peerManager.broadcast(ORACLE_PROPOSE, {
            round:          round,
            prices:         aggregated,
            digest:         digest,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            sig_pubkey:     mySig ? mySig.pubkey : null,
            sig:            mySig ? mySig.sig    : null
        });

        let tag = isFallback ? '[FALLBACK] ' : '';
        console.log('Oracle: ' + tag + 'Proposed round ' + round + ' with ' + aggregated.length +
            ' prices (' + submissions.size + ' submissions)');

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
        let { round, prices, digest, btcBlockHeight, btcBlockTime, sig_pubkey, sig } = envelope.data;
        if (!round || !prices || !digest) return;
        if (this.finalized.has(round)) return;

        // Verify digest
        let computedDigest = this._digest(round, prices);
        if (computedDigest !== digest) {
            console.warn('Oracle: PROPOSE digest mismatch from ' + envelope.sender + ' for round ' + round);
            return;
        }

        // Accept PROPOSE if sender is the deterministic leader OR an authorized
        // fallback (lowest-addr submitter when the leader has no submission in
        // our local view). The fallback path salvages rounds where the leader's
        // price fetch failed but other hubs have prices.
        let leader       = this._getLeader(round);
        let submissions  = this.oracleRound.getSubmissions(round);
        let isRealLeader = leader && leader.addr === envelope.sender;
        let isFallback   = false;

        if (!isRealLeader && submissions && submissions.size > 0) {
            let leaderSubmitted = leader && submissions.has(leader.addr);
            if (!leaderSubmitted) {
                let fallbackAddr = [...submissions.keys()].sort()[0];
                if (fallbackAddr === envelope.sender) isFallback = true;
            }
        }

        if (!isRealLeader && !isFallback) {
            console.warn('Oracle: PROPOSE from non-leader ' + envelope.sender + ' for round ' + round);
            return;
        }

        if (isFallback) {
            console.log('Oracle: Accepting [FALLBACK] PROPOSE from ' + envelope.sender +
                ' for round ' + round + ' (leader ' + (leader ? leader.addr : 'unknown') + ' has no submission)');
        }

        // Create or update pending round
        if (!this.pendingRounds.has(round)) {
            let pending = {
                round:          round,
                prices:         prices,
                digest:         digest,
                btcBlockHeight: btcBlockHeight || round,
                btcBlockTime:   btcBlockTime   || Math.floor(Date.now() / 1000),
                prepares:       new Set(),
                commits:        new Set(),
                signatures:     new Map(),  // pubkey (hex) -> sig (hex)
                finalized:      false,
                timer:          setTimeout(() => {
                    this.pendingRounds.delete(round);
                }, this.finalizationTimeout)
            };
            this.pendingRounds.set(round, pending);
        }

        let pending = this.pendingRounds.get(round);
        pending.prepares.add(envelope.sender);
        pending.prepares.add(this.peerManager.validatorAddr);

        // Verify and store the proposer's signature on the canonical PRICE v0 payload
        if (sig_pubkey && sig) {
            this._verifyAndStoreSig(pending, sig_pubkey, sig);
        }

        // Sign the canonical PRICE v0 payload locally with this validator's identity
        let mySig = this._signPriceV0(round, pending.btcBlockTime, prices);
        if (mySig && !pending.signatures.has(mySig.pubkey)) {
            pending.signatures.set(mySig.pubkey, mySig.sig);
        }

        // Send ORACLE_PREPARE (includes this validator's signature on the canonical PRICE v0 payload)
        this.peerManager.broadcast(ORACLE_PREPARE, {
            round:      round,
            digest:     digest,
            sig_pubkey: mySig ? mySig.pubkey : null,
            sig:        mySig ? mySig.sig    : null
        });

        this._checkPrepareQuorum(round);
    }

    _handlePrepare(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!round || !digest) return;

        let pending = this.pendingRounds.get(round);
        if (!pending || pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        if (sig_pubkey && sig) this._verifyAndStoreSig(pending, sig_pubkey, sig);
        this._checkPrepareQuorum(round);
    }

    _handleCommit(envelope) {
        let { round, digest, sig_pubkey, sig } = envelope.data;
        if (!round || !digest) return;

        let pending = this.pendingRounds.get(round);
        if (!pending || pending.digest !== digest) return;

        pending.commits.add(envelope.sender);
        if (sig_pubkey && sig) this._verifyAndStoreSig(pending, sig_pubkey, sig);
        this._checkCommitQuorum(round);
    }

    _checkPrepareQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        let quorum = this._getQuorum();
        if (pending.prepares.size >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            // Include this validator's signature in the COMMIT message so late-joining nodes
            // can collect signatures from any of the three phases (PROPOSE, PREPARE, COMMIT)
            let mySig = this._signPriceV0(round, pending.btcBlockTime, pending.prices);
            if (mySig && !pending.signatures.has(mySig.pubkey)) {
                pending.signatures.set(mySig.pubkey, mySig.sig);
            }

            this.peerManager.broadcast(ORACLE_COMMIT, {
                round:      round,
                digest:     pending.digest,
                sig_pubkey: mySig ? mySig.pubkey : null,
                sig:        mySig ? mySig.sig    : null
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

            this._storeSnapshot(round, pending.prices, validatorCount, proof, pending.btcBlockHeight, pending.btcBlockTime)
                .then(() => {
                    this.finalized.add(round);
                    this.pendingRounds.delete(round);
                    console.log('Oracle: Round ' + round + ' finalized (' +
                        pending.prepares.size + ' prepares, ' +
                        pending.commits.size + ' commits)');

                    // Convert collected signatures to the [{pubkey, sig}, ...] array format used by OraclePublisher
                    let sigsArray = [];
                    for (let [pubkey, sig] of pending.signatures) {
                        sigsArray.push({ pubkey: pubkey, sig: sig });
                    }

                    // Emit finalization event for RewardTracker, SlashDetector, and OraclePublisher
                    this.emit('round:finalized', {
                        round:          round,
                        btcBlockHeight: pending.btcBlockHeight,
                        btcBlockTime:   pending.btcBlockTime,
                        prices:         pending.prices,
                        participants:   [...pending.prepares],
                        signatures:     sigsArray,
                        submissions:    this.oracleRound.getSubmissions(round)
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
                        if (isFinite(val) && val > 0 && val < 10000000) {
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
    // btcBlockHeight is the BTC chain tip when this round was triggered (used as reference_block)
    // btcBlockTime is the BTC block_time of that block (used as block_timestamp)
    async _storeSnapshot(round, prices, validatorCount, proof, btcBlockHeight, btcBlockTime) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        for (let p of prices) {
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES (?, ?, ?, ?, 'BTC', ?, ?, 1, ?, 'finalized')
                ON DUPLICATE KEY UPDATE price = ?, reference_block = ?, block_timestamp = ?, validator_count = ?, consensus_proof = ?, status = 'finalized'`;
            await this.db.doQuery(query, [
                round, p.coinPair, p.price, referenceBlock, blockTimestamp,
                validatorCount, proof,
                p.price, referenceBlock, blockTimestamp, validatorCount, proof
            ]);
        }
    }

    // Store a skipped round
    async _storeSkippedRound(round, btcBlockHeight, btcBlockTime) {
        let referenceBlock = btcBlockHeight || round;
        let blockTimestamp = btcBlockTime   || Math.floor(Date.now() / 1000);
        let coinPairs = PriceFetcher.getCoinPairs();
        for (let pair of coinPairs) {
            let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES (?, ?, NULL, ?, 'BTC', ?, 0, 1, '[]', 'skipped')
                ON DUPLICATE KEY UPDATE reference_block = ?, block_timestamp = ?, status = 'skipped'`;
            await this.db.doQuery(query, [round, pair, referenceBlock, blockTimestamp, referenceBlock, blockTimestamp]);
        }
        this.finalized.add(round);
        console.log('Oracle: Round ' + round + ' skipped (no submissions)');
    }

    // --- Signature collection (PRICE v0 anchor) ---

    // Build the canonical signable payload for a PRICE v0 round.
    // MUST match xchain-indexer/src/ed25519.js buildPriceV0Payload exactly so signatures
    // produced here verify against the same canonical bytes when indexers parse on-chain PRICE v0 actions.
    _buildPriceV0Payload(round, btcBlockTime, prices) {
        let pairs = prices.map(p => ({ pair: p.coinPair || p.pair, price: String(p.price) }));
        let sortedPairs = [...pairs].sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        return JSON.stringify({
            round:     parseInt(round),
            timestamp: parseInt(btcBlockTime),
            pairs:     sortedPairs
        });
    }

    // Sign the canonical PRICE v0 payload with the local validator identity
    // Returns { pubkey, sig } or null if no identity is configured
    _signPriceV0(round, btcBlockTime, prices) {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (!identity) return null;
        try {
            let payload = this._buildPriceV0Payload(round, btcBlockTime, prices);
            let sigHex  = identity.sign(payload);
            return { pubkey: identity.getPubkeyHex(), sig: sigHex };
        } catch (e) {
            console.warn('Oracle: failed to sign PRICE v0 payload:', e.message);
            return null;
        }
    }

    // Verify a (pubkey, sig) pair against the pending round's canonical PRICE v0 payload,
    // and store it on the pending round's signatures map if valid.
    // The pending object must have a `round` field set when it's created.
    _verifyAndStoreSig(pending, pubkeyHex, sigHex) {
        if (!pending || !pubkeyHex || !sigHex) return false;
        if (pending.signatures.has(pubkeyHex)) return false; // already collected
        if (pending.round === undefined || pending.round === null) {
            console.warn('Oracle: cannot verify sig — pending round has no round number');
            return false;
        }
        try {
            let payload = this._buildPriceV0Payload(pending.round, pending.btcBlockTime, pending.prices);
            let ok = ValidatorIdentity.verify(payload, sigHex, pubkeyHex);
            if (ok) {
                pending.signatures.set(pubkeyHex, sigHex);
                return true;
            } else {
                console.warn('Oracle: invalid PRICE v0 signature from ' + pubkeyHex.substring(0, 16) + '... for round ' + pending.round);
                return false;
            }
        } catch (e) {
            console.warn('Oracle: signature verification error:', e.message);
            return false;
        }
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
