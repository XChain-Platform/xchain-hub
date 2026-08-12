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
 * XChain Hub - Reorg Handler
 *
 * Handles cross-chain reorg propagation. When a blockchain reorg is
 * detected, the hub rolls back its own cross-chain state (attestations,
 * price snapshots) and coordinates rollback across affected chains.
 *
 * Flow: REORG_ALERT → PBFT consensus → hub rollback → reorg attestation stored
 *
 * Quorum requires 2f+1 INDEPENDENT observations of the same reorg: the
 * ALERT/PREPARE wire format carries the reporter's observed `oldHash` /
 * `newHash` at `reorgHeight`, both bound into the PBFT digest, and every
 * hub verifies against its OWN indexer that the node now serves `newHash`
 * (getblockhashes) AND that `oldHash` was the canonical-then-orphaned hash
 * at that height (getreorghistory, backed by the decoder's REORG events)
 * before co-signing. A hub that cannot confirm (lagging
 * node, no indexer endpoint, network mismatch, height out of bounds)
 * ABSTAINS: it neither co-signs nor blocks others, so a fabricated reorg
 * no honest indexer serves can never reach quorum, while a real reorg
 * only needs the honest majority's nodes to have re-synced.
 *
 ********************************************************************/

const crypto       = require('crypto');
const axios        = require('axios');
const EventEmitter = require('events');
const coins        = require('./coins');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');

const REORG_ALERT          = 'REORG_ALERT';
const XCHAIN_REORG_PREPARE = 'XCHAIN_REORG_PREPARE';
const XCHAIN_REORG_COMMIT  = 'XCHAIN_REORG_COMMIT';

const DEFAULT_REORG_TIMEOUT = 60000; // 60 seconds

// 64-hex block hash (as served by the indexer's getblockhashes).
const BLOCK_HASH_RE = /^[0-9a-f]{64}$/;

class ReorgHandler extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        this.validatorSet = [];

        // Pending reorg consensus: Map<reorgId, pending>
        this.pendingReorgs = new Map();

        // Processed reorg IDs (prevent duplicate processing)
        this.processed = new Set();

        this._messageHandler = null;

        // Rate limit: max 1 reorg report per chain per 60 seconds
        this.reorgRateTracker = new Map();

        this.timeout = parseInt(process.env.REORG_TIMEOUT) || DEFAULT_REORG_TIMEOUT;

        // Blast-radius bound. _executeRollback DELETEs attestations and disputes price
        // snapshots relative to the reorg `timestamp`, which is caller-supplied and only
        // sanity-checked for >= 0. A timestamp near 0 makes the rollback wipe essentially
        // ALL attestations for the chain and dispute every finalized price snapshot. A
        // real reorg can only invalidate RECENT state, so refuse a reorg whose timestamp
        // is older than this window (or too far in the future) before it can drive a
        // rollback. Self-node verification (below) covers validity; this bounds the
        // timestamp dimension independently.
        this.maxLookbackMs = parseInt(process.env.REORG_MAX_LOOKBACK_MS) || 86400000; // 24h

        // Height-dimension blast-radius bound: refuse a reorgHeight deeper than this
        // many blocks below our own indexer's tip (DOGE's 1-minute blocks are ~1440
        // per 24h, so the default clears every chain's 24h window with margin).
        this.maxReorgDepth = parseInt(process.env.REORG_MAX_DEPTH) || 2000;

        // How far a reported reorg `timestamp` may PREDATE our own node's block_time
        // for reorgHeight before we refuse to act on it (see
        // _timestampConsistentWithBlockTime). Default 3h: covers the ~2h future
        // miner-timestamp skew consensus rules allow, plus clock-skew margin.
        this.timestampSkewToleranceMs = parseInt(process.env.REORG_TIMESTAMP_SKEW_MS) || 10800000;

        // Federation network (mainnet|testnet|regtest). When set, a getblockhashes
        // response naming a different network is refused (mirrors
        // StateCheckpointEngine's refusal to sign a network-agnostic checkpoint).
        this.network = (hub.network && String(hub.network)) ||
            ((hub.p2pConfig && hub.p2pConfig.HUB_NETWORK) ? String(hub.p2pConfig.HUB_NETWORK) : '');

        // Per-coin indexer JSON-RPC endpoints (same env surface as
        // StateCheckpointEngine / CrossChainDexEngine).
        let cfg = hub.p2pConfig || {};
        this.indexers = {};
        for (let coin of coins.ALLOWED_COINS) {
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }

        // In-flight self-verifications keyed by (chain,height,oldHash,newHash), so a
        // burst of ALERT+PREPARE for the same reorg shares one pair of indexer calls
        // instead of re-querying per message (async handlers are reentrant).
        this._verifying = new Map();

        // Cap on concurrent consensus rounds. The inbound ALERT/PREPARE paths are not
        // rate-limited (only the local reportReorg path is), so a burst of distinct
        // reorgIds could otherwise grow pendingReorgs without bound and fan a PREPARE to
        // every peer per entry (REORG-INBOUND-UNBOUNDED-ROUNDS-1). Rounds self-expire on
        // the timeout, so this only bounds a burst; a real reorg needs one round per chain.
        this.maxPendingReorgs = parseInt(process.env.REORG_MAX_PENDING) || 64;
    }

    // The canonical reorgId for an observation. Honest reporters build it from these exact
    // fields (see reportReorg), so an inbound ALERT/PREPARE whose wire reorgId differs is
    // either malformed or an attempt to mint many distinct rounds from one observation.
    _canonicalReorgId(chain, reorgHeight, timestamp) {
        return chain + ':' + reorgHeight + ':' + timestamp;
    }

    // Whether a reorg timestamp is within the acceptable recent window. Shared by the
    // local report path and the inbound ALERT/PREPARE paths so a hub never joins (or
    // drives) a rollback round for an out-of-window timestamp. Wall-clock `now` differs
    // slightly across hubs, but the window is far wider than any clock skew and real
    // reorg timestamps are minutes old, so honest hubs never disagree at the boundary;
    // a Byzantine timestamp near the edge only fails to reach quorum (fail-safe).
    _timestampInBounds(timestamp) {
        let t = parseInt(timestamp);
        if (!Number.isFinite(t) || t < 0) return false;
        let now = Date.now();
        if (t > now + 300000) return false;                  // too far future
        if (t < now - this.maxLookbackMs) return false;      // too far past (blast-radius bound)
        return true;
    }

    // A reorg cannot be OBSERVED before the reorged-to block existed, so a reported
    // timestamp that predates our own node's block_time for reorgHeight (beyond the
    // skew tolerance) is adversarial or incoherent: acting on it would let a
    // registered-but-Byzantine reporter reach the rollback further back than the
    // blocks the reorg actually invalidated. The rollback bound itself is
    // re-anchored to block_time in _executeRollback; this check additionally denies
    // quorum to rounds minted with far-past timestamps. A null blockTimeMs (older
    // indexer without block_time) passes: legacy timestamp-bound behavior applies.
    // The opposite direction (timestamp AFTER block_time) is always legitimate:
    // detection lags the reorg by up to the lookback window.
    _timestampConsistentWithBlockTime(timestamp, blockTimeMs) {
        if (!Number.isFinite(blockTimeMs)) return true;
        return parseInt(timestamp) >= blockTimeMs - this.timestampSkewToleranceMs;
    }

    // Both hashes must be 64-hex and DIFFERENT: a "reorg" whose old and new hashes
    // match is by definition not a reorg. Callers pass lowercased values.
    _hashesWellFormed(oldHash, newHash) {
        return typeof oldHash === 'string' && typeof newHash === 'string'
            && BLOCK_HASH_RE.test(oldHash) && BLOCK_HASH_RE.test(newHash)
            && oldHash !== newHash;
    }

    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    async start() {
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, then warn loudly for any chain still missing,
        // so a reorg on that chain cannot silently abstain from self-verification.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of Object.keys(this.indexers || {})){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                console.warn('Reorg: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); self-verification abstains for this chain until configured');
        }
        // The handlers are async (self-node verification awaits indexer RPC);
        // EventEmitter doesn't await listeners, so surface rejections here
        // instead of letting them become unhandled.
        this._messageHandler = (envelope) => {
            this._handleMessage(envelope).catch(err =>
                console.error('Reorg: message handling error:', err && err.message));
        };
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

    // Report a reorg (called via JSON-RPC or internally). The reporter supplies the
    // block hash it observed BEFORE the reorg at reorgHeight (oldHash) and the hash
    // its node serves NOW (newHash); this hub re-verifies both against its own
    // indexer before broadcasting, so a compromised reporter credential alone can
    // not start a rollback round for a reorg that never happened.
    async reportReorg(chain, reorgHeight, timestamp, oldHash, newHash) {
        // Validate chain
        let allowedChains = coins.ALLOWED_COINS;
        if (!allowedChains.includes(chain))
            throw new Error('Invalid chain: ' + chain + ' (allowed: ' + allowedChains.join(', ') + ')');

        // Validate reorgHeight
        let h = parseInt(reorgHeight);
        if (!Number.isInteger(h) || h < 0)
            throw new Error('reorgHeight must be a non-negative integer');

        // Validate timestamp
        let t = parseInt(timestamp);
        if (!Number.isFinite(t) || t < 0)
            throw new Error('timestamp must be a non-negative number');
        let now = Date.now();
        if (t > now + 300000)
            throw new Error('timestamp is too far in the future');
        if (t < now - this.maxLookbackMs)
            throw new Error('timestamp is too far in the past (reorg blast-radius bound: ' +
                this.maxLookbackMs + 'ms); a reorg can only invalidate recent state');

        // Validate the observed hash pair
        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this._hashesWellFormed(oldHash, newHash))
            throw new Error('oldHash and newHash must be distinct 64-hex block hashes ' +
                '(the hash observed at reorgHeight before the reorg, and the one served now)');

        let reorgId = this._canonicalReorgId(chain, reorgHeight, timestamp);

        // Already handled: this call is a no-op, so answer it BEFORE the rate limiter.
        // Re-reporting a reorg we have already rolled back is idempotent by design and
        // costs nothing here (no DB, no broadcast, no verification), but sitting behind
        // the limiter it threw 'Rate limit ...' instead - so the ordinary retry a
        // monitor or a peer makes after a confirmed reorg surfaced as an error rather
        // than the intended silent ignore.
        if (this.processed.has(reorgId)) return;

        // Rate limit: 1 report per chain per 60 seconds. CHECK the budget here, but do
        // NOT consume it until the report actually passes self-verification and will be
        // acted on (below). Consuming it up-front let a report that fails verification
        // (typically a momentarily-lagging local node during a real reorg, or a duplicate
        // early-return) burn the 60s window, so the operator's retry after the node
        // re-syncs was rejected exactly when the genuine ALERT needed to go out
        // (REORG-RATELIMIT-BEFORE-VERIFY-1).
        let lastReport = this.reorgRateTracker.get(chain) || 0;
        if (now - lastReport < 60000)
            throw new Error('Rate limit: only one reorg report per chain per 60 seconds');

        // Never report (or locally execute) a rollback our own node does not confirm.
        let verified = await this._verifyReorgAgainstOwnNode(chain, h, oldHash, newHash);
        if (!verified)
            throw new Error('own indexer does not confirm this reorg ' +
                '(node must serve newHash at reorgHeight, within depth bounds, on the federation network)');
        let observedBlockTimeMs = (verified && Number.isFinite(verified.blockTimeMs)) ? verified.blockTimeMs : null;
        if (!this._timestampConsistentWithBlockTime(t, observedBlockTimeMs))
            throw new Error('timestamp predates the reorged block\'s own block_time at reorgHeight ' +
                '(a reorg cannot be observed before the block existed)');

        // Verified and about to act: now consume the per-chain rate budget (covers both
        // the single-node local-execute path and the broadcast+consensus path below).
        this.reorgRateTracker.set(chain, now);

        // Single-node fallback
        let quorum = this._getQuorum();
        if (quorum === 0) {
            await this._executeRollback(chain, reorgHeight, timestamp, reorgId, 1, '[]', observedBlockTimeMs);
            return;
        }

        // Broadcast REORG_ALERT
        this.peerManager.broadcast(REORG_ALERT, {
            chain, reorgHeight, timestamp, reorgId, oldHash, newHash
        });

        // Determine affected chains (any chain that had cross-chain interactions with the source)
        let affectedChains = this._getAffectedChains(chain);

        // Start consensus
        this._initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash, observedBlockTimeMs);
    }

    async getReorgHistory(limit) {
        let query = "SELECT * FROM reorg_attestations ORDER BY created_at DESC LIMIT ?";
        return await this.db.doQuery(query, [limit || 50]);
    }

    // Defense-in-depth: only tally votes from senders that are registered
    // validators. PeerManager already drops any message whose signature doesn't
    // match a registered pubkey, but counting raw envelope.sender values means a
    // forged sender that slipped past that layer (e.g. during a null-registry
    // window) could otherwise inflate quorum from a single connection. That risk
    // is most acute here: reorg quorum triggers destructive cross-chain rollback
    // (attestation deletes, price-snapshot disputes). The registry is keyed by
    // addr (the same value used as the sender). A null registry fails closed (the
    // vulnerability scenario); an empty registry stays lenient ONLY until a chain-effective signer set exists (genuine
    // pre-bootstrap, where the sig layer already rejects unknown senders and no
    // peer votes should be arriving).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) {
            // Empty-registry leniency is for the genuine pre-bootstrap window ONLY
            // (G-1): once the on-chain snapshot has produced a non-empty
            // effective signer set, an empty registry is a misconfiguration or
            // wipe window, not bootstrap, and counting unattributable senders
            // would reopen count-mode quorum forgery. Fail closed instead.
            let signerSet = this.peerManager.effectiveSignerSet;
            return !(signerSet && signerSet.size > 0);
        }
        return registry.has(sender);
    }

    async _handleMessage(envelope) {
        switch (envelope.type) {
            case REORG_ALERT:          await this._handleAlert(envelope);   break;
            case XCHAIN_REORG_PREPARE: await this._handlePrepare(envelope); break;
            case XCHAIN_REORG_COMMIT:  this._handleCommit(envelope);        break;
        }
    }

    async _handleAlert(envelope) {
        if (!this._isKnownSender(envelope.sender)) return;
        let { chain, reorgHeight, timestamp, reorgId, oldHash, newHash } = envelope.data;
        if (!chain || !reorgHeight || !timestamp || !reorgId) return;
        // Bind reorgId to its canonical (chain:reorgHeight:timestamp) form so one valid
        // observation cannot spawn unlimited distinct rounds (REORG-INBOUND-UNBOUNDED-ROUNDS-1):
        // the self-verify in-flight key excludes reorgId/timestamp, so without this a Byzantine
        // validator could re-broadcast the same real (height,newHash) under endless reorgId
        // strings, each creating a fresh round + PREPARE fan-out. Honest reporters always send
        // this exact form (reportReorg), so legitimate ALERTs are unaffected.
        if (reorgId !== this._canonicalReorgId(chain, reorgHeight, timestamp)) return;
        if (this.processed.has(reorgId)) return;
        if (this.pendingReorgs.has(reorgId)) return;
        // Abstain when already at the concurrent-round cap (a later ALERT retries).
        if (this.pendingReorgs.size >= this.maxPendingReorgs) return;

        // Refuse to even start consensus on an out-of-window reorg. An honest majority
        // applying this bound denies a Byzantine reporter the quorum to drive a rollback
        // that reaches back arbitrarily far (blast-radius bound).
        if (!this._timestampInBounds(timestamp)) return;

        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this._hashesWellFormed(oldHash, newHash)) return;

        // Independent observation: co-sign only what our own indexer confirms.
        let verified = await this._verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash);
        if (!verified) return;
        let observedBlockTimeMs = Number.isFinite(verified.blockTimeMs) ? verified.blockTimeMs : null;
        // Abstain from a round whose timestamp predates the reorged block itself
        // (over-rollback attempt); an honest majority abstaining denies it quorum.
        if (!this._timestampConsistentWithBlockTime(timestamp, observedBlockTimeMs)) return;

        // Reentrancy (the await above yields): another ALERT/PREPARE for the same
        // reorg may have created the round meanwhile.
        if (this.processed.has(reorgId) || this.pendingReorgs.has(reorgId)) return;

        let affectedChains = this._getAffectedChains(chain);
        this._initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash, observedBlockTimeMs);
    }

    _initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash, observedBlockTimeMs) {
        if (this.pendingReorgs.has(reorgId)) return;

        let digest = this._digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash);

        let pending = {
            reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
            oldHash, newHash,
            // OUR OWN node's block_time (ms) for reorgHeight, captured during
            // self-verification: the rollback bound (_executeRollback) anchors to
            // it instead of the reporter-supplied timestamp. Null when the indexer
            // reported no block_time (legacy timestamp bound applies).
            observedBlockTimeMs: Number.isFinite(observedBlockTimeMs) ? observedBlockTimeMs : null,
            // Every creation path verified this reorg against our own node first;
            // the commit gates re-check this flag (belt-and-braces).
            selfVerified: true,
            // Lock quorum at round start so the threshold can't shift between
            // PREPARE and COMMIT (validator set / peer count may change during
            // the 60s window), keeping every hub in lockstep across the round.
            quorum:   this._getQuorum(),
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
                // Surface the discarded rollback before dropping it, so operators
                // (and downstream consumers) can alert or retry. Without this, a
                // stalled round silently leaves attestations un-deleted and price
                // snapshots un-disputed after a reorg, leaving dirty cross-chain state
                // with no signal beyond a log line.
                this.emit('reorg:timeout', {
                    reorgId,
                    sourceChain:    pending.chain,
                    reorgHeight:    pending.reorgHeight,
                    timestamp:      pending.timestamp,
                    affectedChains: pending.affectedChains,
                    prepares:       pending.prepares.size,
                    commits:        pending.commits.size,
                    quorum:         pending.quorum
                });
                this.pendingReorgs.delete(reorgId);
            }
        }, this.timeout);

        this.peerManager.broadcast(XCHAIN_REORG_PREPARE, {
            reorgId, chain, reorgHeight, timestamp,
            affectedChains, digest, oldHash, newHash
        });

        this._checkPrepareQuorum(reorgId);
    }

    async _handlePrepare(envelope) {
        if (!this._isKnownSender(envelope.sender)) return;
        let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest, oldHash, newHash } = envelope.data;
        if (!reorgId || !digest) return;
        // Same canonical-reorgId binding as _handleAlert: reject a PREPARE whose reorgId is
        // not the canonical form of its own (chain,reorgHeight,timestamp), so the round-
        // creation path here cannot be driven with attacker-minted reorgId strings
        // (REORG-INBOUND-UNBOUNDED-ROUNDS-1).
        if (!chain || !reorgHeight || !timestamp) return;
        if (reorgId !== this._canonicalReorgId(chain, reorgHeight, timestamp)) return;

        // A follower must not co-sign a reorg it would not itself accept: apply the same
        // blast-radius bound as _handleAlert so a Byzantine leader can't gather quorum
        // from followers that skipped the ALERT. PREPARE carries the timestamp.
        if (!this._timestampInBounds(timestamp)) return;

        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this._hashesWellFormed(oldHash, newHash)) return;

        // The digest is fully derivable from the PREPARE's own fields, so never
        // trust the wire value: a mismatch is either corruption or an attempt to
        // fragment the round with per-follower digests.
        if (digest !== this._digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash)) return;

        if (!this.pendingReorgs.has(reorgId)) {
            if (this.processed.has(reorgId)) return;
            // Abstain when already at the concurrent-round cap, BEFORE the indexer probe,
            // so a burst of distinct rounds can neither grow pendingReorgs without bound
            // nor amplify self-verification RPCs (REORG-INBOUND-UNBOUNDED-ROUNDS-1).
            if (this.pendingReorgs.size >= this.maxPendingReorgs) return;

            // Leader-bypass path (we never saw the ALERT): verify against our own
            // node BEFORE creating the round. On failure we abstain entirely; a
            // later PREPARE retries, so a hub whose node re-syncs mid-round can
            // still join.
            let verified = await this._verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash);
            if (!verified) return;
            let observedBlockTimeMs = Number.isFinite(verified.blockTimeMs) ? verified.blockTimeMs : null;
            // Same over-rollback abstain as _handleAlert: never co-sign a round
            // whose timestamp predates the reorged block's own block_time.
            if (!this._timestampConsistentWithBlockTime(timestamp, observedBlockTimeMs)) return;
            if (this.pendingReorgs.has(reorgId)) {
                // Round appeared while we were verifying; fall through to record.
            } else {
                // Create pending from the received (now verified) data
                let pending = {
                    reorgId, chain, reorgHeight, timestamp,
                    affectedChains: affectedChains || [],
                    digest,
                    oldHash, newHash,
                    observedBlockTimeMs,
                    selfVerified: true,
                    // Lock quorum at round start (see _initiateReorgConsensus).
                    quorum:   this._getQuorum(),
                    prepares: new Set(),
                    commits:  new Set(),
                    finalized: false,
                    timer: null
                };
                pending.timer = setTimeout(() => {
                    if (!pending.finalized) {
                        // Same silent-discard fix as _initiateReorgConsensus: emit the
                        // dropped rollback so it isn't lost without a signal.
                        console.warn('Reorg: Consensus timeout for ' + reorgId);
                        this.emit('reorg:timeout', {
                            reorgId,
                            sourceChain:    pending.chain,
                            reorgHeight:    pending.reorgHeight,
                            timestamp:      pending.timestamp,
                            affectedChains: pending.affectedChains,
                            prepares:       pending.prepares.size,
                            commits:        pending.commits.size,
                            quorum:         pending.quorum
                        });
                    }
                    this.pendingReorgs.delete(reorgId);
                }, this.timeout * 2);
                this.pendingReorgs.set(reorgId, pending);
            }
        }

        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        this._checkPrepareQuorum(reorgId);
    }

    _handleCommit(envelope) {
        if (!this._isKnownSender(envelope.sender)) return;
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
        // Never move to COMMIT for a reorg our own node did not confirm. Every
        // creation path sets this after verification; this guard is the invariant.
        if (pending.selfVerified !== true) return;

        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
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
        // Same invariant as _checkPrepareQuorum: an unverified round never
        // executes a rollback on this hub, no matter how many commits arrive.
        if (pending.selfVerified !== true) return;

        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        if (pending.commits.size >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let proof = JSON.stringify([...pending.commits]);

            this._executeRollback(
                pending.chain, pending.reorgHeight, pending.timestamp,
                reorgId, pending.prepares.size, proof, pending.observedBlockTimeMs
            ).then(() => {
                this.pendingReorgs.delete(reorgId);
            }).catch(err => {
                console.error('Reorg: Error executing rollback for ' + reorgId + ':', err.message);
                this.pendingReorgs.delete(reorgId);
            });
        }
    }

    async _executeRollback(chain, reorgHeight, timestamp, reorgId, validatorCount, proof, observedBlockTimeMs) {
        console.log('Reorg: Rolling back cross-chain state for ' + chain + ' at height ' + reorgHeight);

        // Rollback bound: anchor to OUR OWN node's block_time for reorgHeight
        // (captured during self-verification) rather than the reporter-supplied
        // timestamp. A reorg invalidates state derived from blocks AT AND ABOVE
        // reorgHeight, so the reorged block's own time is the correct scope; the
        // reporter's timestamp is gameable within the 24h window (far-past =
        // over-rollback griefing, near-now = under-rollback leaving invalidated
        // attestations live). Every hub reads its own copy of the SAME
        // quorum-verified block, so the bound stays consensus-uniform. Clamped to
        // the lookback window so a fabricated deep "reorg" (garbage oldHash at a
        // depth-bound height) cannot reach further back than the documented
        // blast-radius bound. Falls back to the reported timestamp when the
        // indexer served no block_time (legacy behavior). Residual: miner
        // timestamps may skew ahead of wall-clock, leaving a small under-rollback
        // edge closable only by per-row block provenance.
        let bound = Number.isFinite(observedBlockTimeMs) ? observedBlockTimeMs : parseInt(timestamp);
        let floor = Date.now() - this.maxLookbackMs;
        if (bound < floor) bound = floor;

        await this.db.doQuery(
            "DELETE FROM attestations WHERE source_chain = ? AND created_at > FROM_UNIXTIME(? / 1000)",
            [chain, bound]
        );

        // price_snapshots.block_timestamp is Unix SECONDS (OracleConsensus / PriceAggregator
        // write Math.floor(Date.now()/1000)), but the reorg bound is MILLISECONDS
        // (block_time * 1000, or the ms timestamp validated against Date.now()). Divide to
        // compare in the same unit, matching the attestations DELETE above; without this
        // the seconds column never exceeds the ms literal and the dispute silently matches
        // zero rows.
        await this.db.doQuery(
            "UPDATE price_snapshots SET status = 'disputed' WHERE block_timestamp > ? / 1000 AND status = 'finalized'",
            [bound]
        );

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
            ': attestations and snapshots after ' + bound +
            (Number.isFinite(observedBlockTimeMs) ? ' (block_time-anchored)' : ' (reported timestamp)') +
            ' invalidated');

        this.emit('reorg:confirmed', {
            reorgId, sourceChain: chain, reorgHeight, timestamp, affectedChains
        });
    }

    // Verify a claimed reorg against our OWN indexer. Returns a truthy
    // `{ blockTimeMs }` object only on positive confirmation: the node serves
    // `newHash` at `reorgHeight`, the height is within [tip - maxReorgDepth, tip],
    // the response names the federation network, and the node's reorg history
    // shows `oldHash` was actually orphaned at that height. blockTimeMs is the served
    // block's block_time in ms (the rollback anchor; null when the indexer carries
    // no block_time). Anything else (no endpoint, RPC error, lagging node still on
    // oldHash, network mismatch) returns false, which callers treat as ABSTAIN,
    // never as proof of absence. Concurrent calls for the same observation share
    // one in-flight probe.
    _verifyReorgAgainstOwnNode(chain, reorgHeight, oldHash, newHash) {
        let key = chain + ':' + reorgHeight + ':' + oldHash + ':' + newHash;
        let inFlight = this._verifying.get(key);
        if (inFlight) return inFlight;

        let probe = this._probeOwnNode(chain, reorgHeight, oldHash, newHash)
            .catch(err => {
                console.warn('Reorg: self-verification failed for ' + key + ':', err && err.message);
                return false;
            });
        this._verifying.set(key, probe);
        probe.finally(() => this._verifying.delete(key));
        return probe;
    }

    async _probeOwnNode(chain, reorgHeight, oldHash, newHash) {
        let ix = this.indexers[chain];
        if (!ix || !ix.url) return false;                    // cannot verify → abstain

        let tip = await this._indexerCall(chain, 'getblockhashes', {});
        if (!tip || tip.block_index == null) return false;
        let tipIndex = Number(tip.block_index);
        if (!Number.isFinite(tipIndex)) return false;
        if (reorgHeight > tipIndex) return false;            // above our tip
        if (reorgHeight < tipIndex - this.maxReorgDepth) return false;  // deeper than the bound

        let bh = (reorgHeight === tipIndex)
            ? tip
            : await this._indexerCall(chain, 'getblockhashes', { block_index: reorgHeight });
        if (!bh || !bh.block_hash) return false;
        // Refuse a network-agnostic or cross-network answer (mirrors
        // StateCheckpointEngine's checkpoint refusal).
        if (!bh.network || (this.network && String(bh.network) !== this.network)) return false;

        let served = String(bh.block_hash).toLowerCase();
        if (served !== newHash || newHash === oldHash) return false;

        // The "before" half (REORG-OLDHASH-UNVERIFIED-1): serving newHash at
        // reorgHeight is trivially true on the honest chain, so on its own it
        // lets a single Byzantine reporter pair the real canonical hash with a
        // fabricated oldHash and reach full honest quorum over a reorg that
        // never happened. Require our OWN node's reorg evidence (the decoder's
        // REORG events, surfaced by the indexer's getreorghistory) to confirm
        // oldHash was the canonical-then-orphaned hash at reorgHeight; abstain
        // otherwise. Liveness holds: an indexer that serves newHash at that
        // height necessarily processed the reorg, so its decoder recorded the
        // orphaned hashes in the same pass.
        if (!(await this._confirmOldHashOrphaned(chain, reorgHeight, oldHash))) return false;

        // block_time (unix seconds) of OUR OWN node's block at reorgHeight: the
        // consensus-uniform rollback anchor (every hub reads its own copy of the
        // same quorum-verified block). Nullable: an indexer predating block_time
        // yields the legacy reporter-timestamp bound.
        let blockTimeMs = (Number(bh.block_time) > 0) ? Number(bh.block_time) * 1000 : null;
        return { blockTimeMs };
    }

    // Whether our own indexer's reorg history shows `oldHash` was orphaned at
    // `reorgHeight`. Queries by height only and matches the hash locally, so a
    // legacy REORG event (recorded before the decoder stored hashes; block_hash
    // null) at that exact height is accepted as evidence a real reorg orphaned
    // a block there, while a recorded-but-different hash is refused. Any error
    // shape (RPC error, indexer predating getreorghistory, malformed response)
    // is an abstain, never a throw.
    async _confirmOldHashOrphaned(chain, reorgHeight, oldHash) {
        let hist;
        try {
            hist = await this._indexerCall(chain, 'getreorghistory', { block_index: reorgHeight });
        } catch (err) {
            console.warn('Reorg: getreorghistory probe failed for ' + chain + ':' + reorgHeight + ':',
                err && err.message);
            return false;
        }
        if (!hist || hist.error || !Array.isArray(hist.events)) return false;
        let sawUnrecorded = false;
        for (let ev of hist.events) {
            if (!ev || !Array.isArray(ev.blocks)) continue;
            for (let b of ev.blocks) {
                if (!b || Number(b.block_index) !== Number(reorgHeight)) continue;
                // An unrecorded hash is NOT a confirmation. The indexer sets
                // block_hash null deliberately so a caller can tell "no hash recorded"
                // apart from "hash did not match" (reorg-history-query.js parseReorgEvent);
                // treating them alike fails OPEN and accepts ANY claimed oldHash at this
                // height, which reduces the orphaned-hash check to "some reorg happened here" and
                // re-opens the divergent-digest mode. Keep scanning: another event
                // may carry the real hash for the same height.
                if (b.block_hash === null || b.block_hash === undefined) { sawUnrecorded = true; continue; }
                if (String(b.block_hash).toLowerCase() === oldHash) return true;
            }
        }
        // Escape hatch, off by default. Restores the earlier fail-open behavior for an
        // operator who knowingly runs against history with unrecorded hashes and
        // would rather co-sign than abstain. Measured 2026-07-29: 3 of 171 recorded
        // orphaned blocks on mainnet carry a null hash (DOGE 6280198 + 6279100,
        // LTC 3137602), so the abstention cost of leaving this off is those heights.
        if (sawUnrecorded && String(process.env.REORG_ALLOW_UNRECORDED_OLDHASH || '') === '1') {
            console.warn('Reorg: accepting UNVERIFIED oldHash at ' + chain + ':' + reorgHeight +
                ' because REORG_ALLOW_UNRECORDED_OLDHASH=1 (the orphaned hash is unrecorded, so this ' +
                'co-signs a claim this node cannot check)');
            return true;
        }
        if (sawUnrecorded)
            console.warn('Reorg: abstaining at ' + chain + ':' + reorgHeight +
                ': a reorg IS recorded at this height but its orphaned hash was never recorded, so the ' +
                'claimed oldHash cannot be verified)');
        return false;
    }

    async _indexerCall(coin, method, params) {
        let ix = this.indexers[coin];
        if (!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if (ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { headers, timeout: 15000 });
        if (resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    // Determine which chains are affected by a reorg on the source chain
    // For now, returns all other supported chains (Phase 4C will be smarter about this)
    _getAffectedChains(sourceChain) {
        let allChains = coins.ALLOWED_COINS;
        return allChains.filter(c => c !== sourceChain);
    }

    _getQuorum() {
        let N = this.validatorSet.length;
        if (N <= 0) {
            // No authoritative validator set yet (startup, before the hub propagates
            // it to this engine). Reorg co-signs are admitted only from registered
            // validators (_isKnownSender, keyed on validatorPubkeys), so derive N
            // from that SAME authenticated registry rather than the raw open-socket
            // count (REORG-QUORUM-PEER-FALLBACK-1): open-peer connections can include
            // unregistered or duplicate sockets and differ per hub, so counting them
            // let the DESTRUCTIVE-rollback threshold be nudged by connection churn and
            // could fork N across hubs for the same round. Fall back to the socket
            // count only when the registry is empty too (genuine single-node /
            // pre-bootstrap), which preserves the N<=1 self-execute path unchanged.
            let registry = this.peerManager && this.peerManager.validatorPubkeys;
            if (registry && registry.size > 0) {
                N = registry.has(this.peerManager.validatorAddr) ? registry.size : registry.size + 1;
            } else {
                let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
                N = peers.length + 1;
            }
        }
        // N<=1: single node, no peer to reach (0 = caller bypasses). Above that,
        // the majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    }

    // The digest binds the OBSERVED HASHES as well as the round identity, so a
    // Byzantine leader cannot swap hashes per-follower: every co-sign commits to
    // one specific (oldHash → newHash) observation at one height.
    _digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash) {
        let payload = JSON.stringify({ reorgId, chain, reorgHeight, timestamp, oldHash, newHash });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = ReorgHandler;
