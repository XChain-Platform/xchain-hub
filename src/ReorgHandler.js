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
 * hub verifies against its OWN indexer (getblockhashes) that the node now
 * serves `newHash` before co-signing. A hub that cannot confirm (lagging
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

        // Rate limit: 1 report per chain per 60 seconds
        let lastReport = this.reorgRateTracker.get(chain) || 0;
        if (now - lastReport < 60000)
            throw new Error('Rate limit: only one reorg report per chain per 60 seconds');
        this.reorgRateTracker.set(chain, now);

        let reorgId = chain + ':' + reorgHeight + ':' + timestamp;

        if (this.processed.has(reorgId)) return;

        // Never report (or locally execute) a rollback our own node does not confirm.
        if (!(await this._verifyReorgAgainstOwnNode(chain, h, oldHash, newHash)))
            throw new Error('own indexer does not confirm this reorg ' +
                '(node must serve newHash at reorgHeight, within depth bounds, on the federation network)');

        // Single-node fallback
        let quorum = this._getQuorum();
        if (quorum === 0) {
            await this._executeRollback(chain, reorgHeight, timestamp, reorgId, 1, '[]');
            return;
        }

        // Broadcast REORG_ALERT
        this.peerManager.broadcast(REORG_ALERT, {
            chain, reorgHeight, timestamp, reorgId, oldHash, newHash
        });

        // Determine affected chains (any chain that had cross-chain interactions with the source)
        let affectedChains = this._getAffectedChains(chain);

        // Start consensus
        this._initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash);
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
    // vulnerability scenario); an empty registry stays lenient (genuine
    // pre-bootstrap, where the sig layer already rejects unknown senders and no
    // peer votes should be arriving).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) return true;
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
        if (this.processed.has(reorgId)) return;
        if (this.pendingReorgs.has(reorgId)) return;

        // Refuse to even start consensus on an out-of-window reorg. An honest majority
        // applying this bound denies a Byzantine reporter the quorum to drive a rollback
        // that reaches back arbitrarily far (blast-radius bound).
        if (!this._timestampInBounds(timestamp)) return;

        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this._hashesWellFormed(oldHash, newHash)) return;

        // Independent observation: co-sign only what our own indexer confirms.
        if (!(await this._verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash))) return;

        // Reentrancy (the await above yields): another ALERT/PREPARE for the same
        // reorg may have created the round meanwhile.
        if (this.processed.has(reorgId) || this.pendingReorgs.has(reorgId)) return;

        let affectedChains = this._getAffectedChains(chain);
        this._initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash);
    }

    _initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash) {
        if (this.pendingReorgs.has(reorgId)) return;

        let digest = this._digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash);

        let pending = {
            reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
            oldHash, newHash,
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

            // Leader-bypass path (we never saw the ALERT): verify against our own
            // node BEFORE creating the round. On failure we abstain entirely; a
            // later PREPARE retries, so a hub whose node re-syncs mid-round can
            // still join.
            if (!(await this._verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash))) return;
            if (this.pendingReorgs.has(reorgId)) {
                // Round appeared while we were verifying; fall through to record.
            } else {
                // Create pending from the received (now verified) data
                let pending = {
                    reorgId, chain, reorgHeight, timestamp,
                    affectedChains: affectedChains || [],
                    digest,
                    oldHash, newHash,
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
                reorgId, pending.prepares.size, proof
            ).then(() => {
                this.pendingReorgs.delete(reorgId);
            }).catch(err => {
                console.error('Reorg: Error executing rollback for ' + reorgId + ':', err.message);
                this.pendingReorgs.delete(reorgId);
            });
        }
    }

    async _executeRollback(chain, reorgHeight, timestamp, reorgId, validatorCount, proof) {
        console.log('Reorg: Rolling back cross-chain state for ' + chain + ' at height ' + reorgHeight);

        await this.db.doQuery(
            "DELETE FROM attestations WHERE source_chain = ? AND created_at > FROM_UNIXTIME(? / 1000)",
            [chain, timestamp]
        );

        // price_snapshots.block_timestamp is Unix SECONDS (OracleConsensus / PriceAggregator
        // write Math.floor(Date.now()/1000)), but the reorg `timestamp` is MILLISECONDS
        // (validated against Date.now()). Divide to compare in the same unit, matching the
        // attestations DELETE above; without this the seconds column never exceeds the ms
        // literal and the dispute silently matches zero rows.
        await this.db.doQuery(
            "UPDATE price_snapshots SET status = 'disputed' WHERE block_timestamp > ? / 1000 AND status = 'finalized'",
            [timestamp]
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
            ': attestations and snapshots after timestamp ' + timestamp + ' invalidated');

        this.emit('reorg:confirmed', {
            reorgId, sourceChain: chain, reorgHeight, timestamp, affectedChains
        });
    }

    // Verify a claimed reorg against our OWN indexer. Returns true only on positive
    // confirmation: the node serves `newHash` at `reorgHeight`, the height is within
    // [tip - maxReorgDepth, tip], and the response names the federation network.
    // Anything else (no endpoint, RPC error, lagging node still on oldHash, network
    // mismatch) returns false, which callers treat as ABSTAIN, never as proof of
    // absence. Concurrent calls for the same observation share one in-flight probe.
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
        return served === newHash && newHash !== oldHash;
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
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1;
        }
        if (N <= 1) return 0;
        let f = Math.floor((N - 1) / 3);
        // Majority floor: bare 2f+1 degenerates to quorum=1 at N=3 (f=0),
        // letting a single validator finalize alone.
        return Math.max(2 * f + 1, Math.ceil((N + 1) / 2));
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
