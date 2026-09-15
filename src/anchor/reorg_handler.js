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
const EventEmitter = require('events');
const coins        = require('../coins');
const { bftQuorumOrSingle } = require('../lib/bft_quorum.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
const { installParts } = require('./install_parts.js');
const { REORG_ALERT, XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT } = require('./reorg_handler/message_types.js');
// One method group per behaviour, installed on the prototype below. The message
// subscription stays in this file: PeerManager.MESSAGE_SUBSCRIBERS names this
// subscriber ReorgHandler, and the listener-ceiling check reads that name off the
// class exported by the file that registers it.
const reportMethods    = require('./reorg_handler/report.js');
const consensusMethods = require('./reorg_handler/consensus.js');
const probeMethods     = require('./reorg_handler/probe.js');

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

        this.timeout = parseInt(hubConfig.REORG_TIMEOUT) || DEFAULT_REORG_TIMEOUT;

        this.initBlastRadiusBounds();

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
        this.maxPendingReorgs = parseInt(hubConfig.REORG_MAX_PENDING) || 64;
    }

    // The two blast-radius bounds and the timestamp skew tolerance, read in the order
    // the constructor has always set them.
    initBlastRadiusBounds() {
        // Blast-radius bound. executeRollback DELETEs attestations and disputes price
        // snapshots relative to the reorg `timestamp`, which is caller-supplied and only
        // sanity-checked for >= 0. A timestamp near 0 makes the rollback wipe essentially
        // ALL attestations for the chain and dispute every finalized price snapshot. A
        // real reorg can only invalidate RECENT state, so refuse a reorg whose timestamp
        // is older than this window (or too far in the future) before it can drive a
        // rollback. Self-node verification (below) covers validity; this bounds the
        // timestamp dimension independently.
        this.maxLookbackMs = parseInt(hubConfig.REORG_MAX_LOOKBACK_MS) || 86400000; // 24h

        // Height-dimension blast-radius bound: refuse a reorgHeight deeper than this
        // many blocks below our own indexer's tip (DOGE's 1-minute blocks are ~1440
        // per 24h, so the default clears every chain's 24h window with margin).
        this.maxReorgDepth = parseInt(hubConfig.REORG_MAX_DEPTH) || 2000;

        // How far a reported reorg `timestamp` may PREDATE our own node's block_time
        // for reorgHeight before we refuse to act on it (see
        // timestampConsistentWithBlockTime). Default 3h: covers the ~2h future
        // miner-timestamp skew consensus rules allow, plus clock-skew margin.
        this.timestampSkewToleranceMs = parseInt(hubConfig.REORG_TIMESTAMP_SKEW_MS) || 10800000;
    }

    // The canonical reorgId for an observation. Honest reporters build it from these exact
    // fields (see reportReorg), so an inbound ALERT/PREPARE whose wire reorgId differs is
    // either malformed or an attempt to mint many distinct rounds from one observation.
    canonicalReorgId(chain, reorgHeight, timestamp) {
        return chain + ':' + reorgHeight + ':' + timestamp;
    }

    // Whether a reorg timestamp is within the acceptable recent window. Shared by the
    // local report path and the inbound ALERT/PREPARE paths so a hub never joins (or
    // drives) a rollback round for an out-of-window timestamp. Wall-clock `now` differs
    // slightly across hubs, but the window is far wider than any clock skew and real
    // reorg timestamps are minutes old, so honest hubs never disagree at the boundary;
    // a Byzantine timestamp near the edge only fails to reach quorum (fail-safe).
    timestampInBounds(timestamp) {
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
    // re-anchored to block_time in executeRollback; this check additionally denies
    // quorum to rounds minted with far-past timestamps. A null blockTimeMs (older
    // indexer without block_time) passes: legacy timestamp-bound behavior applies.
    // The opposite direction (timestamp AFTER block_time) is always legitimate:
    // detection lags the reorg by up to the lookback window.
    timestampConsistentWithBlockTime(timestamp, blockTimeMs) {
        if (!Number.isFinite(blockTimeMs)) return true;
        return parseInt(timestamp) >= blockTimeMs - this.timestampSkewToleranceMs;
    }

    // Both hashes must be 64-hex and DIFFERENT: a "reorg" whose old and new hashes
    // match is by definition not a reorg. Callers pass lowercased values.
    hashesWellFormed(oldHash, newHash) {
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
        if(this.hub && typeof this.hub.resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub.resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of Object.keys(this.indexers || {})){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                logger.warn('Reorg: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); self-verification abstains for this chain until configured');
        }
        // The handlers are async (self-node verification awaits indexer RPC);
        // EventEmitter doesn't await listeners, so surface rejections here
        // instead of letting them become unhandled.
        this._messageHandler = (envelope) => {
            this._handleMessage(envelope).catch(err =>
                logger.error(nodeUtil.format('Reorg: message handling error:', err && err.message)));
        };
        this.peerManager.on('message', this._messageHandler);
        logger.info('Reorg handler started');
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
            case REORG_ALERT:          await this.handleAlert(envelope);   break;
            case XCHAIN_REORG_PREPARE: await this.handlePrepare(envelope); break;
            case XCHAIN_REORG_COMMIT:  this._handleCommit(envelope);        break;
        }
    }

    // Determine which chains are affected by a reorg on the source chain
    // For now, returns all other supported chains (Phase 4C will be smarter about this)
    getAffectedChains(sourceChain) {
        let allChains = coins.ALLOWED_COINS;
        return allChains.filter(c => c !== sourceChain);
    }

    getQuorum() {
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

// Installed the way class syntax would put them: non-enumerable, and a name already on
// the prototype throws at load rather than overwriting (install_parts.js).
installParts(ReorgHandler.prototype, [reportMethods, consensusMethods, probeMethods]);

module.exports = ReorgHandler;
