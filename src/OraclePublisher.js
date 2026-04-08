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
 * XChain Hub - Oracle Publisher (Tier 3)
 *
 * Tier 3 validators publish finalized PRICE v0 rounds to the DOGE chain
 * as the immutable backup/audit trail. Leader rotation is deterministic:
 *   leader_index = round % active_tier3_count
 *
 * Active Tier 3 validators are sorted by signing_pubkey for stable
 * ordering across all nodes. If the leader misses their window
 * (1 BTC block), the next validator in rotation becomes eligible.
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
        this.queuePath          = process.env.PUBLISHER_QUEUE_PATH || './data/publisher-queue.jsonl';
        this.dogeAddress        = process.env.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        this.dogePubkeyHex      = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10'); // DOGE
        this.maxAttempts        = parseInt(process.env.PUBLISHER_MAX_ATTEMPTS || '5');

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
            pubkey:   this.dogePubkeyHex,
            data:     payload,
            change:   this.dogeAddress,
            encoding: 'p2sh'
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
            console.warn('OraclePublisher: failed to create queue directory ' + dir + ':', e.message);
        }

        // Touch queue file
        try {
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            console.warn('OraclePublisher: queue file unwritable at ' + this.queuePath + ':', e.message);
        }

        // Subscribe to oracle finalization events
        if (this.hub.oracleConsensus) {
            this.hub.oracleConsensus.on('round:finalized', (event) => {
                this.onRoundFinalized(event).catch(err => {
                    console.error('OraclePublisher: onRoundFinalized error:', err.message);
                });
            });
        }

        console.log('OraclePublisher started (queue: ' + this.queuePath + ', address: ' + (this.dogeAddress || '<unset>') + ')');
    }

    // Called when a round is finalized — enqueue if this node is the leader
    async onRoundFinalized(event) {
        let round = event.round;
        let myRank = await this._getMyRank(event.btcBlockHeight);
        if (myRank === null) return; // not a Tier 3 publisher (or stake not active)

        let tier3Count = await this._getActiveTier3Count(event.btcBlockHeight);
        if (tier3Count === 0) return;

        let leaderRank = round % tier3Count;
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

    // Determine this node's rank in the sorted Tier 3 validator list, or null if not a publisher
    // Sort order: signing_pubkey ascending (deterministic across all nodes)
    async _getMyRank(blockIndex) {
        if (!this.identity) return null;
        let myPubkey = this.identity.getPubkeyHex();
        let pubkeys = await this._getActiveTier3Pubkeys(blockIndex);
        let idx = pubkeys.indexOf(myPubkey);
        return idx >= 0 ? idx : null;
    }

    // Get the count of active Tier 3 validators at a given BTC block height
    async _getActiveTier3Count(blockIndex) {
        let pubkeys = await this._getActiveTier3Pubkeys(blockIndex);
        return pubkeys.length;
    }

    // Get the sorted list of active Tier 3 validator signing pubkeys at a given BTC block height
    // Reads from the synced `stakes` table in the hub's local copy of indexer state
    // Returns: array of 64-hex pubkey strings, sorted ascending
    async _getActiveTier3Pubkeys(blockIndex) {
        // The hub's local copy of the BTC indexer's stakes table is populated via xchain-indexer-sync
        // (Phase 3.12). For now, return an empty list if the table doesn't exist or is empty.
        try {
            let query = `SELECT ip.pubkey
                         FROM stakes s
                         INNER JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
                         INNER JOIN index_statuses st ON st.id = s.status_id
                         WHERE s.tier = 3 AND st.status = 'valid'`;
            let args = [];
            if (blockIndex !== undefined && blockIndex !== null) {
                query += ' AND s.activation_block <= ? AND (s.deactivation_block IS NULL OR s.deactivation_block > ?)';
                args.push(blockIndex);
                args.push(blockIndex);
            }
            query += ' ORDER BY ip.pubkey ASC';
            let rows = await this.db.doQuery(query, args);
            return rows.map(r => String(r.pubkey).toLowerCase());
        } catch (err) {
            // Table not present in hub DB yet (selective sync not configured)
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
            console.warn('OraclePublisher: failed to build local sig:', e.message);
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
            console.error('OraclePublisher: failed to enqueue round ' + round.round + ':', e.message);
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
            console.error('OraclePublisher: failed to rewrite queue:', e.message);
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
                console.error('OraclePublisher: publish failed for round ' + entry.round + ' (attempt ' + entry.attempts + '/' + this.maxAttempts + '): ' + err.message);
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
                console.warn('OraclePublisher: custom balance check failed:', err.message);
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
                console.warn('OraclePublisher: encoder balance check failed:', err.message);
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
