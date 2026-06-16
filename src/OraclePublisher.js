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
 * XChain Hub - Oracle Publisher (`oracle_publish` capability)
 *
 * Validators with the `oracle_publish` capability active publish finalized
 * PRICE v0 rounds to the DOGE chain as the immutable backup/audit trail.
 * Leader rotation is deterministic:
 *   leader_index = round % active_oracle_publish_count
 *
 * Active validators are sorted by signing_pubkey for stable ordering
 * across all nodes. If the leader misses their window (1 BTC block),
 * the next validator in rotation becomes eligible.
 *
 * Failover publishers batch missed rounds. First valid PRICE tx on-chain
 * for a given round wins (and earns the reward).
 *
 * This module handles:
 *   - Leader rotation calculation
 *   - Persistent queue (JSONL with fsync)
 *   - PRICE v0 payload construction (matches indexer parser format)
 *   - DOGE balance monitoring with WARN/ERROR log thresholds
 *
 * The actual DOGE broadcast is delegated to a `broadcastFn` hook that
 * the operator wires up to their preferred signer (xchain-sdk, xchain-encoder
 * REST API, or local DOGE node). This keeps the publisher decoupled from
 * the underlying transport.
 *
 ********************************************************************/

const fs            = require('fs');
const path          = require('path');
const EncoderClient = require('./EncoderClient.js');

class OraclePublisher {

    constructor(hub) {
        this.hub      = hub;
        this.db       = hub.db;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        // Config (read from env or hub p2pConfig)
        let cfg = hub.p2pConfig || {};
        this.queuePath          = process.env.PUBLISHER_QUEUE_PATH || cfg.PUBLISHER_QUEUE_PATH || './data/publisher-queue.jsonl';
        this.dogeAddress        = process.env.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        this.dogePubkeyHex      = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10'); // DOGE
        this.maxAttempts        = parseInt(process.env.PUBLISHER_MAX_ATTEMPTS || cfg.PUBLISHER_MAX_ATTEMPTS || '5');

        // Per-round state
        this.failoverWindowBlocks = 1; // 1 BTC block before failover triggers

        // Auto-create EncoderClient if DOGE_ENCODER_URL env var is set
        // This is the JSON-RPC endpoint of an xchain-encoder instance configured for DOGE.
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks (wired by the operator at startup)
        // broadcastFn(payload) → Promise<{txid}>      — full custom broadcast pipeline (overrides default)
        // walletSignFn(psbtHex) → Promise<txHex>      — sign a PSBT with the DOGE_ADDRESS private key
        // getBalanceFn() → Promise<number>            — return DOGE balance for the configured address
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;
    }

    // Set a custom broadcast hook (overrides the default encoder-based pipeline)
    // The function receives the PRICE v0 wire payload string and should return { txid }
    setBroadcastHook(fn) {
        this.broadcastFn = fn;
    }

    // Set the wallet signing hook — required for the default broadcast pipeline
    // The function receives a PSBT hex string and should return a signed transaction hex string
    // Operators wire this to xchain-sdk's wallet.signPsbt() or any equivalent signer
    setWalletSignHook(fn) {
        this.walletSignFn = fn;
    }

    // Set the balance query hook
    setBalanceHook(fn) {
        this.getBalanceFn = fn;
    }

    // Default broadcast pipeline: uses the EncoderClient + walletSignFn to construct, sign, and broadcast
    // a PRICE v0 transaction to the DOGE chain. Returns { txid } on success.
    // This is used automatically when no custom broadcastFn is set but encoder + walletSignFn are configured.
    async _defaultBroadcast(payload) {
        if (!this.encoder)         throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if (!this.walletSignFn)    throw new Error('no wallet sign hook configured (call setWalletSignHook)');
        if (!this.dogeAddress)     throw new Error('no DOGE_ADDRESS configured');
        if (!this.dogePubkeyHex)   throw new Error('no DOGE_PUBKEY_HEX configured');

        // 1. Fetch UTXOs for the publisher's DOGE address
        let utxos = await this.encoder.getUtxos(this.dogeAddress);
        if (!utxos || (Array.isArray(utxos) && utxos.length === 0)) {
            throw new Error('no UTXOs available for ' + this.dogeAddress);
        }

        // 2. Create an unsigned PSBT with the PRICE v0 payload
        // PRICE v0 payloads are typically ~900-1100 bytes (well above the 80-byte OP_RETURN limit),
        // so we use P2SH encoding which is what xchain-encoder supports for large payloads.
        let psbtResult = await this.encoder.createTx({
            utxos:    utxos,
            // The encoder's P2SH path runs bitcoin.address.fromBase58Check() on this
            // field, so it must be the base58check address — not the raw hex pubkey.
            pubkey:   this.dogeAddress,
            data:     payload,
            change:   this.dogeAddress,
            encoding: 'P2SH'
        });
        if (!psbtResult || !psbtResult.psbt) {
            throw new Error('encoder returned no PSBT');
        }

        // 3. Sign the PSBT via the operator-provided wallet hook
        let txHex = await this.walletSignFn(psbtResult.psbt);
        if (!txHex || typeof txHex !== 'string') {
            throw new Error('wallet sign hook returned invalid tx hex');
        }

        // 4. Broadcast the signed transaction
        let broadcastResult = await this.encoder.broadcastTx(txHex);
        return broadcastResult || { txid: null };
    }

    // Initialize the publisher: ensure queue directory exists, load any pending rounds
    async start() {
        // Ensure queue directory exists
        let dir = path.dirname(this.queuePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            console.warn('OraclePublisher: failed to create queue directory ' + dir + ':', e);
        }

        // Touch queue file
        try {
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            console.warn('OraclePublisher: queue file unwritable at ' + this.queuePath + ':', e);
        }

        // Subscribe to oracle finalization events
        if (this.hub.oracleConsensus) {
            this.hub.oracleConsensus.on('round:finalized', (event) => {
                this.onRoundFinalized(event).catch(err => {
                    console.error('OraclePublisher: onRoundFinalized error:', err);
                });
            });
        }

        console.log('OraclePublisher started (queue: ' + this.queuePath + ', address: ' + (this.dogeAddress || '<unset>') + ')');
    }

    // Called when a round is finalized — enqueue if this node is the leader
    async onRoundFinalized(event) {
        let round = event.round;
        let myRank = await this._getMyRank(event.btcBlockHeight);
        if (myRank === null) return; // not an active oracle_publish validator (capability not active)

        let publisherCount = await this._getActiveOraclePublishCount(event.btcBlockHeight);
        if (publisherCount === 0) return;

        let leaderRank = round % publisherCount;
        if (leaderRank !== myRank) {
            // Not our turn (yet) — but we may need to take over later if leader fails
            return;
        }

        // We are the leader for this round — enqueue and try to publish
        // Signatures are collected by OracleConsensus during PBFT prepare/commit and passed in event.signatures
        let sigs = (event.signatures && Array.isArray(event.signatures) && event.signatures.length > 0)
            ? event.signatures
            : this._buildLocalSigOnly(event);

        await this._enqueue({
            round:          round,
            btcBlockHeight: event.btcBlockHeight,
            btcBlockTime:   event.btcBlockTime,
            prices:         event.prices,
            sigs:           sigs
        });

        await this._processQueue();
    }

    // Determine this node's rank in the sorted oracle_publish validator list, or null if not active
    // Sort order: signing_pubkey ascending (deterministic across all nodes that share the active set)
    async _getMyRank(blockIndex) {
        if (!this.identity) return null;
        let myPubkey = String(this.identity.getPubkeyHex()).toLowerCase();
        let pubkeys = await this._getActiveOraclePublishPubkeys(blockIndex);
        let idx = pubkeys.indexOf(myPubkey);
        return idx >= 0 ? idx : null;
    }

    // Get the count of active oracle_publish validators
    async _getActiveOraclePublishCount(blockIndex) {
        let pubkeys = await this._getActiveOraclePublishPubkeys(blockIndex);
        return pubkeys.length;
    }

    // Get the sorted list of active oracle_publish validator signing pubkeys at
    // the given block boundary. Uses the on-chain snapshot (via CapabilitySnapshot)
    // so every hub that has processed identical on-chain data through blockIndex
    // returns the same array — regardless of when gossip messages arrived.
    // Falls back to the live local registry when the indexer is unreachable.
    // Returns: array of 64-hex pubkey strings, sorted ascending.
    async _getActiveOraclePublishPubkeys(blockIndex) {
        if (!this.hub) return [];

        // Primary: deterministic on-chain snapshot at blockIndex
        if (this.hub.capabilitySnapshot && blockIndex !== undefined && blockIndex !== null) {
            try {
                let snapshot = await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                if (snapshot && Array.isArray(snapshot.validators)) {
                    return snapshot.validators
                        .map(v => String(v.pubkey).toLowerCase())
                        .sort();
                }
            } catch (err) {
                // fall through to live registry below
            }
        }

        // Fallback: live local registry (used when indexer is unreachable)
        if (!this.hub.capabilityRegistry) return [];
        try {
            let pubkeys = await this.hub.capabilityRegistry.getActiveValidators('oracle_publish');
            return pubkeys.map(p => String(p).toLowerCase()).sort();
        } catch (err) {
            console.error('OraclePublisher: failed to fetch active validators:', err);
            return [];
        }
    }

    // Fallback: build a single-validator signature locally if the round event didn't carry any
    // (only used in degenerate cases — normal operation collects sigs from consensus prepare/commit)
    _buildLocalSigOnly(event) {
        if (!this.identity) return [];
        try {
            let payload = this._buildSignablePayload(event.round, event.btcBlockTime, event.prices);
            let sigHex  = this.identity.sign(payload);
            return [{ pubkey: this.identity.getPubkeyHex(), sig: sigHex }];
        } catch (e) {
            console.warn('OraclePublisher: failed to build local sig:', e);
            return [];
        }
    }

    // Build the canonical signable payload — must match indexer's ed25519.buildPriceV0Payload
    _buildSignablePayload(round, timestamp, prices) {
        let pairs = prices.map(p => ({ pair: p.coinPair, price: String(p.price) }));
        let sortedPairs = pairs.sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        return JSON.stringify({
            round:     parseInt(round),
            timestamp: parseInt(timestamp),
            pairs:     sortedPairs
        });
    }

    // Build the on-wire PRICE v0 payload as a pipe-delimited string
    // Format: PRICE|0|ROUND|TIMESTAMP|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
    buildPriceV0Wire(round, timestamp, prices, sigs) {
        let parts = ['PRICE', '0', String(round), String(timestamp), String(prices.length)];
        for (let p of prices) {
            parts.push(p.coinPair || p.pair);
            parts.push(String(p.price));
        }
        parts.push(String(sigs.length));
        for (let s of sigs) {
            parts.push(s.pubkey);
            parts.push(s.sig);
        }
        return parts.join('|');
    }

    // Enqueue a round for publishing (durable, fsync'd)
    async _enqueue(round) {
        let entry = Object.assign({}, round, { attempts: 0, enqueuedAt: Date.now() });
        let line  = JSON.stringify(entry) + '\n';
        try {
            let fd = fs.openSync(this.queuePath, 'a');
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('OraclePublisher: failed to enqueue round ' + round.round + ':', e);
            // Fail loud — refuse to ack if queue is unwritable
            throw e;
        }
    }

    // Read all queue entries (used by _processQueue and on restart)
    _readQueue() {
        try {
            let raw = fs.readFileSync(this.queuePath, 'utf8');
            return raw.split('\n').filter(line => line.trim().length > 0).map(line => {
                try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(e => e !== null);
        } catch (e) {
            return [];
        }
    }

    // Rewrite the queue with the given entries (used after successful publishes)
    _rewriteQueue(entries) {
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.queuePath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('OraclePublisher: failed to rewrite queue:', e);
        }
    }

    // Process pending rounds in the queue: build payload, check balance, broadcast
    async _processQueue() {
        let entries = this._readQueue();
        if (entries.length === 0) return;

        // Check DOGE balance before attempting any publish
        let balance = await this._checkBalance();

        let remaining = [];
        for (let entry of entries) {
            // Skip entries that have exceeded max attempts (failover publisher will pick them up)
            if (entry.attempts >= this.maxAttempts) {
                console.error('OraclePublisher: round ' + entry.round + ' exceeded max attempts (' + this.maxAttempts + '), abandoning to failover');
                continue;
            }

            let payload = this.buildPriceV0Wire(entry.round, entry.btcBlockTime, entry.prices, entry.sigs);

            // Choose broadcast strategy: custom hook overrides, otherwise use the default encoder pipeline
            let broadcaster = this.broadcastFn || ((p) => this._defaultBroadcast(p));
            let canBroadcast = this.broadcastFn || (this.encoder && this.walletSignFn);

            try {
                if (!canBroadcast) {
                    console.warn('OraclePublisher: no broadcast pipeline configured (set DOGE_ENCODER_URL + setWalletSignHook, or setBroadcastHook), round ' + entry.round + ' will remain queued');
                    entry.attempts++;
                    remaining.push(entry);
                    continue;
                }
                let result = await broadcaster(payload);
                console.log('OraclePublisher: published round ' + entry.round + ' (txid: ' + (result && result.txid) + ')');
                // Successfully published — drop from queue (do not add to remaining)
            } catch (err) {
                entry.attempts++;
                console.error('OraclePublisher: publish failed for round ' + entry.round + ' (attempt ' + entry.attempts + '/' + this.maxAttempts + '): ', err);
                if (balance !== null && balance < 0.01) {
                    console.error('OraclePublisher: insufficient DOGE balance for round ' + entry.round);
                }
                remaining.push(entry);
            }
        }

        this._rewriteQueue(remaining);
    }

    // Check DOGE balance and log warnings if below threshold
    // Uses the operator's getBalanceFn if set, otherwise falls back to summing UTXOs from the encoder.
    // Returns the balance (in DOGE) or null if no source is available.
    async _checkBalance() {
        let balance = null;
        if (this.getBalanceFn) {
            try {
                balance = await this.getBalanceFn();
            } catch (err) {
                console.warn('OraclePublisher: custom balance check failed:', err);
                return null;
            }
        } else if (this.encoder && this.dogeAddress) {
            // Default: sum UTXO values for the configured DOGE address
            try {
                let utxos = await this.encoder.getUtxos(this.dogeAddress);
                if (Array.isArray(utxos)) {
                    let total = 0;
                    for (let u of utxos) {
                        let val = parseFloat(u.value || u.amount || 0);
                        if (Number.isFinite(val)) total += val;
                    }
                    balance = total;
                }
            } catch (err) {
                console.warn('OraclePublisher: encoder balance check failed:', err);
                return null;
            }
        }

        if (balance !== null && balance !== undefined) {
            if (balance < this.lowBalanceThreshold) {
                // Estimate rounds remaining at typical fee rate (~0.003 DOGE per tx)
                let est = Math.floor(balance / 0.003);
                console.warn('OraclePublisher: DOGE balance LOW (' + balance.toFixed(4) + ' DOGE, ~' + est + ' rounds remaining)');
            }
        }
        return balance;
    }
}

module.exports = OraclePublisher;
