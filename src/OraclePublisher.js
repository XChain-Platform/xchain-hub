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
 * the next validator in rotation becomes eligible. First valid PRICE tx
 * on-chain for a given round wins (and earns the reward).
 *
 * A round that exhausts its broadcast attempts is written to an append-only
 * dead-letter file (never silently dropped) so the finalized round can be
 * inspected and replayed by hand rather than vanishing from the durable queue.
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
const SpendGuard    = require('./lib/spend_guard.js');
const { AtMostOnce, isAmbiguousSendError } = require('./lib/idempotent_broadcast.js');

// PRICE v0 wire ceiling. Must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js
// (mirrors ATTEST_WIRE_MAX_BYTES in AttestationPublisher.js): an oversized wire is
// rejected by createTx with a RangeError, so we drop it before it lands on the durable
// queue rather than letting the failover sweep retry it forever.
const PRICE_WIRE_MAX_BYTES = 8189;

class OraclePublisher {

    constructor(hub) {
        this.hub      = hub;
        this.db       = hub.db;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        // Config (read from env or hub p2pConfig)
        let cfg = hub.p2pConfig || {};
        this.queuePath          = process.env.PUBLISHER_QUEUE_PATH || cfg.PUBLISHER_QUEUE_PATH || './data/publisher-queue.jsonl';
        // Append-only sink for rounds that exhaust maxAttempts. Kept next to the
        // queue so operators find both together; never truncated (open 'a').
        this.deadLetterPath     = this.queuePath.replace(/\.jsonl$/, '') + '.deadletter.jsonl';
        // Lifetime counter of rounds moved to the dead-letter file. Makes a
        // give-up event countable instead of only a console.error.
        this.abandonedCount     = 0;
        // Lifetime count of finalized rounds dropped pre-enqueue because their encoded
        // PRICE v0 wire exceeded PRICE_WIRE_MAX_BYTES. Kept separate from abandonedCount
        // so operators can tell an oversized drop apart from an attempts-exhausted abandon.
        this.oversizedDrops     = 0;
        // Transition-only guard so a persistent capability-snapshot resolution failure
        // (which darks the publisher) is logged once per dark spell, not every round.
        this._snapshotDark      = false;
        // Lifetime published count + last-published markers + last-observed balance,
        // surfaced via getStats() so an operator RPC can see the publish rail's
        // health (a stalled rail is otherwise invisible: every price_snapshots row
        // still reads finalized while nothing lands on-chain).
        this.publishedCount     = 0;
        this.lastPublishedRound = null;
        this.lastPublishedTxid  = null;
        // In-process at-most-once guard. Round ids broadcast this process lifetime
        // are recorded here the instant broadcaster(payload) succeeds. If the
        // post-broadcast queue rewrite fails (disk full, permissions, transient I/O),
        // the just-published round stays on the durable queue file; without this set
        // the next _processQueue tick would re-read and RE-BROADCAST it, spending real
        // DOGE twice for the same round. Consulted before every broadcast so a failed
        // rewrite can never turn into a duplicate on-chain PRICE. Cleared once the
        // durable queue is confirmed rewritten (no published round can still be on it).
        this._publishedRounds   = new AtMostOnce();
        // Durable at-most-once. The in-process tracker above vanishes on restart, but
        // the finalized round can still be on the durable JSONL queue, so a restart
        // before the queue rewrite is repaired would re-broadcast an already-paid round
        // (duplicate DOGE spend). The `oracle_published_rounds` table (src/sql/) records
        // an intent row BEFORE broadcast and a sent marker AFTER, on the hub DB, a disk
        // decoupled from the queue file whose exhaustion triggers the rewrite failure.
        // start() hydrates _publishedRounds from sent markers and quarantines any
        // intent-only rows (a crash between intent and confirmation left the on-chain
        // state unknown): those are NEVER auto-rebroadcast, only surfaced for an operator
        // to verify on-chain and replay by hand. When no hub DB is wired (dev/test), the
        // durable guard is inert and the in-process tracker is the only at-most-once cover.
        this._quarantinedRounds = new Set();
        this.lastObservedBalance = null;
        this.dogeAddress        = process.env.DOGE_ADDRESS || cfg.DOGE_ADDRESS || '';
        this.dogePubkeyHex      = process.env.DOGE_PUBKEY_HEX || cfg.DOGE_PUBKEY_HEX || '';
        this.lowBalanceThreshold = parseFloat(process.env.DOGE_LOW_BALANCE_THRESHOLD || cfg.DOGE_LOW_BALANCE_THRESHOLD || '10'); // DOGE
        this.maxAttempts        = parseInt(process.env.PUBLISHER_MAX_ATTEMPTS || cfg.PUBLISHER_MAX_ATTEMPTS || '5');
        // Retention window (in rounds) for the durable oracle_published_rounds marker
        // table. One row lands per published round forever, so on a money-bearing
        // broadcast path the table grows without bound for the life of the deployment.
        // Only CONFIRMED rows (sent_at IS NOT NULL) are ever pruned: a sent_at NULL row
        // is the quarantine marker for a round whose on-chain state is unknown, which an
        // operator reconciles by hand, so those must survive forever (see
        // _hydratePublishedMarkers). Keep the most recent N rounds; 0 disables pruning.
        // Default ~90 days at the 10-minute round default, mirroring the
        // ORACLE_SUBMISSIONS_RETENTION_ROUNDS window on the sibling audit table.
        this.publishedRoundsRetentionRounds = parseInt(
            process.env.ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS ||
            cfg.ORACLE_PUBLISHED_ROUNDS_RETENTION_ROUNDS);
        if (!Number.isFinite(this.publishedRoundsRetentionRounds) || this.publishedRoundsRetentionRounds < 0) {
            this.publishedRoundsRetentionRounds = 12960;
        }
        // Lifetime count of confirmed marker rows pruned by the retention sweep, and
        // the promise of the in-flight sweep. The sweep is fire-and-forget on the
        // publish path (a retention failure must never stall a broadcast), so the
        // handle is what makes it awaitable in tests and diagnosable in getStats.
        this.publishedRoundsPruned = 0;
        this._retentionSweep       = null;

        // item 2677 - operator kill switch. Mirrors StateAnchorPublisher's
        // ANCHOR_ENABLED gate: a first-class lever to halt outbound DOGE spend
        // during an incident (bad price feed, runaway fees, compromised signer)
        // without tearing down the broadcast pipeline config. Default: enabled.
        this.enabled = String(process.env.ORACLE_PUBLISH_ENABLED || cfg.ORACLE_PUBLISH_ENABLED || 'true') !== 'false';

        // Shared SpendGuard (supersedes the old per-publisher SpendCeiling).
        // Composes the per-window spend ceiling (count + a $2000-clamped USD-cents
        // budget, default-ON), the wallet balance floor, and a per-capability runtime
        // pause. Folding the pause into allow() is what lets an operator halt this
        // publisher's PRIMARY (leader) DOGE spend at runtime, not just its sweep.
        this.spendGuard = new SpendGuard('ORACLE_PUBLISH', cfg, 'OraclePublisher');
        // Keep the guard's balance floor in step with the publisher's existing
        // DOGE_LOW_BALANCE_THRESHOLD so guard stats read the same floor the
        // pre-loop balance gate enforces.
        this.spendGuard.minBalance = this.lowBalanceThreshold;

        // Per-round state
        this.failoverWindowBlocks = 1; // 1 BTC block before failover triggers
        // Leader-rotation observability (item 3218). A dark peer publisher is
        // otherwise invisible: this hub's own status stays perfect while 1/N of
        // rounds never land on-chain. Track the rank state of the most recent
        // finalized round plus lifetime leader/follower-window counts so getStats
        // (getoraclepublisherstatus) exposes the rotation the dashboard can watch.
        this._lastRankState  = null; // { round, myRank, leaderRank, isLeader, publisherCount }
        this._leaderRounds   = 0;    // rounds this hub was the elected leader
        this._followerRounds = 0;    // finalized rounds this hub deferred (not leader)

        // Auto-create EncoderClient if DOGE_ENCODER_URL env var is set
        // This is the JSON-RPC endpoint of an xchain-encoder instance configured for DOGE.
        let encoderUrl = process.env.DOGE_ENCODER_URL || cfg.DOGE_ENCODER_URL || '';
        let encoderKey = process.env.DOGE_ENCODER_API_KEY || cfg.DOGE_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;

        // Pluggable hooks (wired by the operator at startup)
        // broadcastFn(payload) → Promise<{txid}>: full custom broadcast pipeline (overrides default)
        // walletSignFn(psbtHex) → Promise<txHex>: sign a PSBT with the DOGE_ADDRESS private key
        // getBalanceFn() → Promise<number>: return DOGE balance for the configured address
        this.broadcastFn  = null;
        this.walletSignFn = null;
        this.getBalanceFn = null;
    }

    // Set a custom broadcast hook (overrides the default encoder-based pipeline)
    // The function receives the PRICE v0 wire payload string and should return { txid }
    setBroadcastHook(fn) {
        this.broadcastFn = fn;
    }

    // Set the wallet signing hook (required for the default broadcast pipeline)
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
            // field, so it must be the base58check address (not the raw hex pubkey).
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

        // 4. Broadcast the signed transaction.
        // Everything above is pre-send (build/sign; no money has moved). Only
        // broadcast_tx has a side effect, so only ITS failures are classified for
        // ambiguity (item 2675): a timeout / mid-flight reset / 5xx AFTER the
        // request left the wire may mean the DOGE node actually accepted the tx,
        // so a blind retry would spend a second fee and double-anchor the round.
        try {
            let broadcastResult = await this.encoder.broadcastTx(txHex);
            return broadcastResult || { txid: null };
        } catch (e) {
            if (this._isAmbiguousSendError(e)) e.oracleAmbiguousSend = true;
            throw e;
        }
    }

    // Classify a broadcast failure (delegates to the shared classifier so
    // all four hub effectors answer "could this send have landed?" identically).
    _isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    }

    // Initialize the publisher: ensure queue directory exists, load any pending rounds
    async start() {
        // The per-window spend ceilings were memory-only, so every restart
        // restored a full allowance. Reload the saved window before anything publishes.
        this.spendGuard.persistTo();
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

        // Hydrate the durable at-most-once guard before subscribing to new rounds:
        // load confirmed rounds into the in-process guard and quarantine any
        // intent-only rounds so a restart can never re-broadcast an already-published
        // (or ambiguously-published) round. Best-effort; a DB error is logged inside.
        if (this.db) {
            try {
                await this._hydratePublishedMarkers();
            } catch (e) {
                console.error('OraclePublisher: failed to hydrate durable publish markers on startup ' +
                    '(the in-process guard still covers this lifetime): ', e);
            }
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

    // Called when a round is finalized. Enqueue if this node is the leader.
    async onRoundFinalized(event) {
        // item 2677 kill switch: when disabled, do not enqueue or broadcast.
        // Skip rather than queue-for-later so a disabled publisher does not silently
        // build a backlog that floods on-chain the moment it is re-enabled.
        if (!this.enabled) {
            console.log('OraclePublisher: disabled (ORACLE_PUBLISH_ENABLED=false); skipping round ' + event.round);
            return;
        }
        let round = event.round;
        let myRank = await this._getMyRank(event.btcBlockHeight);
        if (myRank === null) return; // not an active oracle_publish validator (capability not active)

        let publisherCount = await this._getActiveOraclePublishCount(event.btcBlockHeight);
        if (publisherCount === 0) return;

        let leaderRank = round % publisherCount;
        this._lastRankState = {
            round:          round,
            myRank:         myRank,
            leaderRank:     leaderRank,
            isLeader:       leaderRank === myRank,
            publisherCount: publisherCount
        };
        if (leaderRank !== myRank) {
            // Not our turn yet, but we may need to take over later if leader fails
            this._followerRounds++;
            return;
        }
        this._leaderRounds++;

        // We are the leader for this round. Enqueue and try to publish.
        // Signatures are collected by OracleConsensus during PBFT prepare/commit and passed in event.signatures
        let sigs = (event.signatures && Array.isArray(event.signatures) && event.signatures.length > 0)
            ? event.signatures
            : this._buildLocalSigOnly(event);

        // Guard: the assembled PRICE v0 wire must fit the encoder's data-payload
        // ceiling, or createTx rejects it with a RangeError downstream. Catching that
        // after enqueue is too late, the entry would already be on the durable queue
        // and the failover sweep would retry the same oversized payload forever. Drop
        // it loudly here (symmetric to AttestationPublisher's pre-WAL guard).
        let wire      = this.buildPriceV0Wire(round, event.btcBlockTime, event.prices, sigs, event.btcBlockHeight);
        let wireBytes = Buffer.byteLength(wire, 'utf8');
        if (wireBytes > PRICE_WIRE_MAX_BYTES) {
            console.error('OraclePublisher: PRICE v0 wire for round ' + round +
                ' is ' + wireBytes + ' bytes, exceeds encoder limit of ' + PRICE_WIRE_MAX_BYTES +
                '; dropping broadcast. Too many pairs or signatures for a single round.');
            this.oversizedDrops++;
            // Route the dropped round through the append-only dead-letter sink so it
            // stays countable (getStats) and replayable like every other abandoned
            // round, instead of vanishing with only a console.error. NOT enqueued: the
            // drop must stay pre-enqueue so the failover sweep never retries an
            // unencodable payload forever.
            this._deadLetter({
                round:          round,
                btcBlockHeight: event.btcBlockHeight,
                btcBlockTime:   event.btcBlockTime,
                prices:         event.prices,
                sigs:           sigs
            }, 'PRICE v0 wire ' + wireBytes + ' bytes exceeds encoder limit of ' + PRICE_WIRE_MAX_BYTES);
            return;
        }

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

    // Transition-only warn for the capability-snapshot fail-closed paths. Called
    // once per finalized round, so a persistent fault would otherwise log every
    // round; emit only on the transition INTO dark and reset on the next successful
    // resolution. The fail-closed [] return itself is never changed by this.
    _logSnapshotDark(detail, err) {
        if (this._snapshotDark) return;
        this._snapshotDark = true;
        let suffix = err ? (': ' + (err && err.message ? err.message : err)) : '';
        console.warn('OraclePublisher: oracle_publish capability snapshot ' + detail +
            '; failing closed, this hub will not publish until it resolves' + suffix);
    }

    // Get the count of active oracle_publish validators
    async _getActiveOraclePublishCount(blockIndex) {
        let pubkeys = await this._getActiveOraclePublishPubkeys(blockIndex);
        return pubkeys.length;
    }

    // Get the sorted list of active oracle_publish validator signing pubkeys at
    // the given block boundary. Uses the on-chain snapshot (via CapabilitySnapshot)
    // so every hub that has processed identical on-chain data through blockIndex
    // returns the same array regardless of when gossip messages arrived.
    // Fails closed (returns []) when the block-pinned snapshot is unresolved.
    // Returns: array of 64-hex pubkey strings, sorted ascending.
    async _getActiveOraclePublishPubkeys(blockIndex) {
        if (!this.hub) return [];

        // Primary: deterministic on-chain snapshot at blockIndex
        if (this.hub.capabilitySnapshot && blockIndex !== undefined && blockIndex !== null) {
            try {
                let snapshot = await this.hub.capabilitySnapshot.getSnapshot('oracle_publish', blockIndex);
                if (snapshot && Array.isArray(snapshot.validators)) {
                    this._snapshotDark = false;
                    return snapshot.validators
                        .map(v => String(v.pubkey).toLowerCase())
                        .sort();
                }
                // Snapshot resolved to null. This is the dominant dark path:
                // CapabilitySnapshot.getSnapshot returns null (does NOT throw) when the
                // indexer is unreachable, the result is an error, or the echoed block
                // mismatches, so it never reaches the catch below. Left silent, the
                // publisher stops publishing with no trace. Log the transition so a dark
                // publisher is distinguishable in the hub log from a hub that legitimately
                // is not an oracle_publish validator. The [] return is unchanged.
                this._logSnapshotDark('resolved to null at block ' + blockIndex, null);
            } catch (err) {
                // Fail closed: fall through to []. Log the transition (once per dark
                // spell) so a persistent throw leaves a trace instead of failing silent.
                this._logSnapshotDark('threw at block ' + blockIndex, err);
            }
        }

        // Fail closed on a pinned-block miss. The old live-registry fallback
        // (capabilityRegistry.getActiveValidators) is block-unpinned and filtered on
        // qualified/self_test_ok/enabled over gossip-driven rows, so it is a per-hub
        // view of "now": two hubs would rank/size the round-robin over different sets
        // (duplicate PRICE v0 broadcast + duplicate DOGE fee, or a dropped round). The
        // caller already treats myRank === null as "not a publisher". Matches the
        // accepted fix for #686/#925/#930.
        return [];
    }

    // Fallback: build a single-validator signature locally if the round event didn't carry any.
    // Only used in degenerate cases; normal operation collects sigs from consensus prepare/commit.
    _buildLocalSigOnly(event) {
        if (!this.identity) return [];
        try {
            let payload = this._buildSignablePayload(event.round, event.btcBlockTime, event.prices, event.btcBlockHeight);
            let sigHex  = this.identity.sign(payload);
            return [{ pubkey: this.identity.getPubkeyHex(), sig: sigHex }];
        } catch (e) {
            console.warn('OraclePublisher: failed to build local sig:', e);
            return [];
        }
    }

    // Build the canonical signable payload. Must match indexer's ed25519.buildPriceV0Payload
    // (including the EQUIV header gate on the round's BTC block height, #4232). The height
    // is part of the signed content; only the bare-JSON branch is built here because this
    // local-sig fallback is degenerate (no EQUIV-era round reaches it on a real federation),
    // and the canonical-byte equality with the indexer is enforced by the consensus path.
    _buildSignablePayload(round, timestamp, prices, btcBlockHeight) {
        let pairs = prices.map(p => ({ pair: p.coinPair, price: String(p.price) }));
        let sortedPairs = pairs.sort((a, b) => {
            if (a.pair < b.pair) return -1;
            if (a.pair > b.pair) return 1;
            return 0;
        });
        return JSON.stringify({
            round:            parseInt(round),
            timestamp:        parseInt(timestamp),
            btc_block_height: parseInt(btcBlockHeight),
            pairs:            sortedPairs
        });
    }

    // Build the on-wire PRICE v0 payload as a pipe-delimited string
    // Format: PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
    // BTC_BLOCK_HEIGHT is the round's BTC anchor (the EQUIV gate input, in the signed payload).
    buildPriceV0Wire(round, timestamp, prices, sigs, btcBlockHeight) {
        let parts = ['PRICE', '0', String(round), String(timestamp), String(parseInt(btcBlockHeight)), String(prices.length)];
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
            // Fail loud: refuse to ack if queue is unwritable
            throw e;
        }
    }

    // Append a give-up entry to the durable dead-letter file (never truncated).
    // Best-effort: a write failure is logged but does not keep the entry looping
    // forever on the main queue. Records the original entry plus when and why it
    // was abandoned so an operator can replay the round manually.
    _deadLetter(entry, reason) {
        this.abandonedCount++;
        let record = Object.assign({}, entry, { deadLetteredAt: Date.now(), reason: reason });
        let line   = JSON.stringify(record) + '\n';
        try {
            let fd = fs.openSync(this.deadLetterPath, 'a');
            fs.writeSync(fd, line);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('OraclePublisher: failed to write dead-letter record for round ' + entry.round + ':', e);
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

    // Rewrite the queue with the given entries (used after successful publishes).
    // Returns true on a durable rewrite, false if the truncating write failed. The
    // dequeue side must NOT swallow a failure: on false the just-published rounds are
    // still on the durable queue, so the caller keeps its in-process dedup guard armed
    // (preventing re-broadcast) and surfaces the failure loudly for operator repair.
    _rewriteQueue(entries) {
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.queuePath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            console.error('OraclePublisher: failed to rewrite queue:', e);
            return false;
        }
    }

    // ----- Durable at-most-once marker (oracle_published_rounds) -----

    // Read the durable marker for a round, or null when none exists / no DB is wired.
    // Shape: { round, txid, sent_at }. A row with a non-null sent_at is the
    // authoritative "already broadcast" signal (txid may legitimately be null if the
    // broadcaster returned none, so sent_at, not txid, gates re-broadcast).
    // Throws on a DB error so the caller can FAIL CLOSED (never broadcast when we
    // cannot prove the round is unpublished).
    async _getPublishedMarker(round) {
        if (!this.db) return null;
        let rows = await this.db.doQuery(
            'SELECT round, txid, sent_at FROM oracle_published_rounds WHERE round = ?',
            [round]
        );
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Durably record broadcast INTENT for a round before the send. Idempotent: an
    // existing row (intent or sent) is left untouched. Throws on a DB error so the
    // caller fails closed. No-op when no DB is wired.
    async _recordPublishIntent(round) {
        if (!this.db) return;
        await this.db.doQuery(
            'INSERT INTO oracle_published_rounds (round) VALUES (?) ' +
            'ON DUPLICATE KEY UPDATE round = round',
            [round]
        );
    }

    // Durably record that a round's broadcast COMPLETED (sets sent_at + txid). Called
    // after a successful send. A failure here is logged, not thrown: the DOGE is
    // already spent, and the intent row means a restart quarantines the round rather
    // than re-broadcasting it. No-op when no DB is wired.
    async _markPublished(round, txid) {
        if (!this.db) return;
        try {
            await this.db.doQuery(
                'UPDATE oracle_published_rounds SET txid = ?, sent_at = NOW() WHERE round = ?',
                [txid, round]
            );
        } catch (e) {
            console.error('OraclePublisher: broadcast for round ' + round + ' succeeded but its durable ' +
                'sent marker could not be persisted; a restart will QUARANTINE (not re-broadcast) this round. ' +
                'Operator: confirm the txid on-chain. Error: ', e);
        }
    }

    // Startup reconciliation of the durable marker table. Loads every confirmed
    // (sent_at set) round into the in-process guard so a queued-but-already-published
    // round is never re-broadcast after a restart, and QUARANTINES every intent-only
    // (sent_at NULL) round: a crash between intent and confirmation leaves the on-chain
    // state unknown, so those are never auto-rebroadcast: only surfaced for an operator
    // to verify and replay by hand (no price-by-round indexer query exists to reconcile
    // them automatically). Best-effort: a DB error is logged and startup continues; the
    // in-process guard still covers this process lifetime.
    async _hydratePublishedMarkers() {
        if (!this.db) return;
        let rows = await this.db.doQuery('SELECT round, sent_at FROM oracle_published_rounds', []);
        let quarantined = [];
        for (let r of (rows || [])) {
            let round = Number(r.round);
            if (r.sent_at !== null && r.sent_at !== undefined) {
                this._publishedRounds.mark(round);
            } else {
                this._quarantinedRounds.add(round);
                quarantined.push(round);
            }
        }
        if (quarantined.length > 0) {
            console.error('OraclePublisher: ' + quarantined.length + ' round(s) have a publish-intent marker ' +
                'with no confirmation (rounds ' + quarantined.join(', ') + '); their on-chain state is unknown ' +
                'after a crash. They will NOT be re-broadcast automatically (fail closed). Operator: verify each ' +
                'round on-chain and replay manually if absent.');
        }
    }

    // Bound the durable oracle_published_rounds marker table to the retention window.
    // Without this the table appends one row per published round forever.
    //
    // Two invariants dominate this DELETE, both load-bearing on a money-bearing path:
    //
    //   1. `sent_at IS NOT NULL` is mandatory. A sent_at NULL row is an intent-only
    //      QUARANTINE marker: broadcast intent was recorded but the confirmation never
    //      landed, so the round's on-chain state is unknown and only an operator can
    //      reconcile it (_hydratePublishedMarkers surfaces them at startup and refuses
    //      to auto-rebroadcast). Pruning one would erase the sole record that a round
    //      needs hand-verification, and the round would then look never-attempted.
    //   2. No round still on the durable queue may be pruned. The marker is what stops
    //      a restart from re-broadcasting a queued-but-already-published round (a
    //      duplicate DOGE spend). A queue entry older than the retention window means
    //      the queue is not draining, so the cutoff is clamped below the oldest queued
    //      round rather than trusting the window.
    //
    // Returns the number of rows deleted. Throws on a DB error; the caller decides
    // (the publish path treats a retention failure as non-fatal).
    async _prunePublishedRounds(anchorRound) {
        if (!this.db) return 0;
        if (!this.publishedRoundsRetentionRounds || this.publishedRoundsRetentionRounds <= 0) return 0;
        let anchor = Number(anchorRound);
        if (!Number.isFinite(anchor)) return 0;

        let cutoff = anchor - this.publishedRoundsRetentionRounds;
        if (cutoff <= 0) return 0;

        // Invariant 2: never prune a marker whose round can still be read off the
        // durable queue file. Best-effort read; an unreadable queue returns [] and the
        // window applies unchanged (the file being unreadable is already loud elsewhere).
        for (let entry of this._readQueue()) {
            let r = Number(entry && entry.round);
            if (Number.isFinite(r) && r < cutoff) cutoff = r;
        }
        if (cutoff <= 0) return 0;

        let result = await this.db.doQuery(
            'DELETE FROM oracle_published_rounds WHERE round < ? AND sent_at IS NOT NULL',
            [cutoff]);
        let deleted = result && result.affectedRows ? Number(result.affectedRows) : 0;
        if (deleted > 0) {
            this.publishedRoundsPruned += deleted;
            console.log('OraclePublisher: published-rounds retention pruned ' + deleted +
                ' confirmed marker row(s) older than round ' + cutoff + ' (keep ' +
                this.publishedRoundsRetentionRounds + ' rounds; quarantined intent-only ' +
                'rows are never pruned)');
        }
        return deleted;
    }

    // Process pending rounds in the queue: build payload, check balance, broadcast
    async _processQueue() {
        // item 2677 kill switch: suppress the replay/sweep too, not just the live
        // path, so a disabled publisher spends nothing. Entries stay on the durable
        // queue untouched and resume only when re-enabled and re-swept.
        if (!this.enabled) {
            console.log('OraclePublisher: disabled (ORACLE_PUBLISH_ENABLED=false); skipping queue processing');
            return;
        }

        let entries = this._readQueue();
        if (entries.length === 0) return;

        // item 2676 - hard balance floor gate (was: balance read then only WARNed,
        // publishing continued regardless). A null/unreadable balance is fail-closed:
        // skip the whole publish pass rather than spend blind. Below the floor, skip
        // too; entries stay queued and retry once the wallet is topped up. This bounds
        // total drain to the floor no matter which failure mode is driving the spend.
        let balance = await this._checkBalance();
        // Only enforce when a balance source is actually wired (a getBalanceFn hook,
        // or an encoder + address to sum UTXOs). With no source, balance is always
        // null and there is nothing to enforce, so preserve prior behavior rather
        // than disable publishing outright.
        let hasBalanceSource = !!(this.getBalanceFn || (this.encoder && this.dogeAddress));
        if (hasBalanceSource) {
            if (balance === null) {
                console.warn('OraclePublisher: DOGE balance unreadable; skipping publish this pass (fail-closed), ' +
                    entries.length + ' round(s) remain queued');
                return;
            }
            if (balance < this.lowBalanceThreshold) {
                console.warn('OraclePublisher: DOGE balance ' + balance.toFixed(4) + ' below floor ' +
                    this.lowBalanceThreshold + '; skipping publish (fail-closed), ' + entries.length + ' round(s) remain queued');
                return;
            }
        }

        let remaining = [];
        let publishedThisPass = false;
        for (let entry of entries) {
            // Entries that have exhausted their broadcast attempts are moved to the
            // append-only dead-letter file rather than silently erased on the next
            // queue rewrite. The finalized round stays recoverable for manual replay,
            // and the give-up is counted (abandonedCount) instead of only logged.
            if (entry.attempts >= this.maxAttempts) {
                console.error('OraclePublisher: round ' + entry.round + ' exceeded max attempts (' +
                    this.maxAttempts + '), moving to dead-letter file ' + this.deadLetterPath);
                this._deadLetter(entry, 'exceeded max attempts (' + this.maxAttempts + ')');
                continue;
            }

            // At-most-once guard. If this round was already broadcast this process
            // lifetime, it is only still on the queue because a prior tick's rewrite
            // failed to truncate it. Re-broadcasting would spend DOGE twice, so drop
            // the stale entry (do not push to remaining) instead of sending again.
            if (this._publishedRounds.has(entry.round)) {
                console.warn('OraclePublisher: round ' + entry.round + ' already broadcast this process lifetime; dropping stale queue entry without re-broadcast (a prior queue rewrite must have failed)');
                continue;
            }

            // Quarantined round (an intent-only durable marker from a pre-crash broadcast
            // whose on-chain state is unknown). NEVER re-broadcast: drop the stale queue
            // entry and leave it for operator replay. Surfaced at startup in _hydratePublishedMarkers.
            if (this._quarantinedRounds.has(entry.round)) {
                console.warn('OraclePublisher: round ' + entry.round + ' is quarantined (publish intent recorded before a crash, on-chain state unknown); dropping queue entry without re-broadcast, awaiting operator replay');
                continue;
            }

            // Durable at-most-once. Consult the persistent marker before spending DOGE so
            // a restart (empty in-process Set, round still on the durable queue) can never
            // re-broadcast an already-published round. FAIL CLOSED on any DB error: if we
            // cannot prove the round is unpublished we defer rather than risk a duplicate
            // spend (kept on the queue, retried next tick; attempts NOT incremented, this
            // is not a broadcast failure).
            if (this.db) {
                let marker;
                try {
                    marker = await this._getPublishedMarker(entry.round);
                } catch (e) {
                    console.error('OraclePublisher: cannot read durable publish marker for round ' + entry.round +
                        '; deferring broadcast (fail closed to avoid a duplicate DOGE spend): ', e);
                    remaining.push(entry);
                    continue;
                }
                if (marker && marker.sent_at !== null && marker.sent_at !== undefined) {
                    // Already broadcast in a prior process; only still on the queue because
                    // a rewrite failed before restart. Drop without re-sending.
                    console.warn('OraclePublisher: round ' + entry.round + ' has a durable sent marker (txid ' +
                        (marker.txid || '<none>') + '); dropping stale queue entry without re-broadcast');
                    this._publishedRounds.mark(entry.round);
                    continue;
                }
                // Record broadcast intent BEFORE the send. A crash between here and the
                // sent marker leaves an intent-only row that startup quarantines (never
                // auto-rebroadcast). Fail closed if the intent cannot be durably recorded.
                try {
                    await this._recordPublishIntent(entry.round);
                } catch (e) {
                    console.error('OraclePublisher: cannot record durable publish intent for round ' + entry.round +
                        '; deferring broadcast (fail closed): ', e);
                    remaining.push(entry);
                    continue;
                }
            }

            let payload = this.buildPriceV0Wire(entry.round, entry.btcBlockTime, entry.prices, entry.sigs, entry.btcBlockHeight);

            // Choose broadcast strategy: custom hook overrides, otherwise use the default encoder pipeline
            let broadcaster = this.broadcastFn || ((p) => this._defaultBroadcast(p));
            let canBroadcast = this.broadcastFn || (this.encoder && this.walletSignFn);

            // item 2676 - per-window spend ceiling. A tripped ceiling is not a
            // failure: keep the round queued (no attempts++) and skip the broadcast
            // so it publishes in a later window. Checked before the send so no fee
            // is spent once the budget is exhausted.
            if (!this.spendGuard.allow()) {
                console.warn(this.spendGuard.noteBlocked() + ' (round ' + entry.round + ')');
                remaining.push(entry);
                continue;
            }

            try {
                if (!canBroadcast) {
                    console.warn('OraclePublisher: no broadcast pipeline configured (set DOGE_ENCODER_URL + setWalletSignHook, or setBroadcastHook), round ' + entry.round + ' will remain queued');
                    entry.attempts++;
                    remaining.push(entry);
                    continue;
                }
                let result = await broadcaster(payload);
                // Record the round as published BEFORE the queue rewrite. This is the
                // at-most-once anchor: even if the rewrite below fails and leaves this
                // round on the durable queue, the next tick's guard will skip it.
                this._publishedRounds.mark(entry.round);
                this.spendGuard.record();   // count the fee against the window budget
                // Persist the durable sent marker so the guard survives a restart (the
                // in-process tracker above does not). Best-effort: on failure the intent
                // row remains and a restart quarantines the round rather than re-broadcasting.
                await this._markPublished(entry.round, (result && result.txid) || null);
                console.log('OraclePublisher: published round ' + entry.round + ' (txid: ' + (result && result.txid) + ')');
                this.publishedCount++;
                publishedThisPass       = true;
                this.lastPublishedRound = entry.round;
                this.lastPublishedTxid  = (result && result.txid) || null;
                // Successfully published. Drop from queue (do not add to remaining).
            } catch (err) {
                // item 2675 - NEVER blind-retry an ambiguous send. A timeout / reset /
                // 5xx after the request left the wire may mean the DOGE node accepted
                // the tx; re-broadcasting would spend DOGE twice and double-anchor the
                // round. OraclePublisher has no on-chain existence check to adopt the
                // possibly-landed tx, so the fail-safe action is to stop auto-retrying:
                // move the round to the durable, recoverable dead-letter file (counted,
                // never silently dropped) for manual inspection/replay. Only definitive
                // pre-send errors keep the existing attempts-and-requeue retry.
                if (this._isAmbiguousSendError(err) || (err && err.oracleAmbiguousSend)) {
                    console.error('OraclePublisher: AMBIGUOUS send failure for round ' + entry.round +
                        ' (tx may have reached the DOGE node); NOT re-broadcasting to avoid a double spend. ' +
                        'Moving to dead-letter file ' + this.deadLetterPath + ' for manual verify/replay: ', err);
                    this._deadLetter(entry, 'ambiguous send failure (possible double-spend risk); verify on-chain before replay');
                    continue;   // do not push to remaining; no auto re-broadcast
                }
                entry.attempts++;
                console.error('OraclePublisher: publish failed for round ' + entry.round + ' (attempt ' + entry.attempts + '/' + this.maxAttempts + '): ', err);
                if (balance !== null && balance < 0.01) {
                    console.error('OraclePublisher: insufficient DOGE balance for round ' + entry.round);
                }
                remaining.push(entry);
            }
        }

        // Dequeue-side rewrite must fail loud, mirroring the enqueue path's "refuse
        // to ack if queue is unwritable" stance. On success the durable queue now
        // equals `remaining` (which never holds a published round), so no published
        // round can still be on disk and the dedup guard can be reset to bound its
        // growth. On failure the published rounds remain on the queue file: keep the
        // guard armed (it prevents the re-broadcast) and surface the failure so an
        // operator repairs the queue before a restart drops the in-memory guard.
        let rewritten = this._rewriteQueue(remaining);
        if (rewritten) {
            this._publishedRounds.clear();
        } else {
            console.error('OraclePublisher: CRITICAL - queue rewrite failed after publishing; ' +
                'published rounds remain on the durable queue at ' + this.queuePath + '. The in-process ' +
                'dedup guard prevents re-broadcast for this process lifetime, but a restart before the ' +
                'queue file is repaired would re-broadcast already-published rounds (duplicate DOGE spend). ' +
                'Fix the queue file writability now.');
        }

        // Bound the durable marker table. Runs after the rewrite so the queue-floor
        // clamp reads the post-pass queue, and only when a round actually published
        // this pass (nothing new to age out otherwise). Fire-and-forget with the
        // rejection swallowed: retention is housekeeping and must never fail, stall,
        // or retry a broadcast pass that has already spent DOGE.
        if (this.db && publishedThisPass && this.lastPublishedRound !== null) {
            this._retentionSweep = this._prunePublishedRounds(this.lastPublishedRound)
                .catch((e) => {
                    console.warn('OraclePublisher: published-rounds retention sweep failed ' +
                        '(marker table keeps growing until it succeeds): ', e);
                    return 0;
                });
        }
    }

    // Snapshot of the publish rail's health for operator diagnostics. Intended to
    // be surfaced through a JSON-RPC status method (e.g. getoraclepublisherstatus)
    // alongside the sibling publishers' getStats accessors. All fields are cheap,
    // in-memory reads; queueDepth touches the durable queue file.
    getStats() {
        let queueDepth = 0;
        try { queueDepth = this._readQueue().length; } catch (e) { queueDepth = null; }
        return {
            queueDepth:          queueDepth,
            published:           this.publishedCount,
            abandoned:           this.abandonedCount,
            oversizedDrops:      this.oversizedDrops,
            quarantined:         this._quarantinedRounds.size,
            // Marker-table retention: the configured window plus the lifetime prune
            // count, so an operator can tell a bounded table from one whose sweep has
            // been failing (pruned stuck at 0 while rounds keep publishing).
            publishedRoundsRetentionRounds: this.publishedRoundsRetentionRounds,
            publishedRoundsPruned:          this.publishedRoundsPruned,
            lastPublishedRound:  this.lastPublishedRound,
            lastPublishedTxid:   this.lastPublishedTxid,
            lastObservedBalance: this.lastObservedBalance,
            deadLetterPath:      this.deadLetterPath,
            enabled:             this.enabled,
            // Leader-rotation view (item 3218): last finalized round's rank state
            // plus lifetime leader/follower-window counts, so a monitor can tell a
            // healthy-but-never-leader hub from a genuinely idle one and spot a dark
            // peer publisher (this hub's follower count climbs while its leader
            // rounds never land on-chain elsewhere).
            myRank:              this._lastRankState ? this._lastRankState.myRank : null,
            leaderRank:          this._lastRankState ? this._lastRankState.leaderRank : null,
            isLeader:            this._lastRankState ? this._lastRankState.isLeader : null,
            publisherCount:      this._lastRankState ? this._lastRankState.publisherCount : null,
            lastRankRound:       this._lastRankState ? this._lastRankState.round : null,
            leaderRounds:        this._leaderRounds,
            followerRounds:      this._followerRounds,
            spendGuard:          this.spendGuard.stats()
        };
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

        this.lastObservedBalance = balance;
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
