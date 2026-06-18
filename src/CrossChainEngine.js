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
 * XChain Hub - Cross-Chain Attestation Engine
 *
 * PBFT-based consensus for cross-chain action attestation. When an
 * action on Chain A needs to trigger an action on Chain B, validators
 * attest that the source action exists with sufficient confirmations.
 *
 * Flow: PROPOSE → PREPARE (2f+1) → COMMIT (2f+1) → store attestation
 *
 ********************************************************************/

const axios        = require('axios');
const crypto       = require('crypto');
const EventEmitter = require('events');

const XCHAIN_ATTEST_PROPOSE = 'XCHAIN_ATTEST_PROPOSE';
const XCHAIN_ATTEST_PREPARE = 'XCHAIN_ATTEST_PREPARE';
const XCHAIN_ATTEST_COMMIT  = 'XCHAIN_ATTEST_COMMIT';

// Default per-chain confirmation thresholds (Tier B, 2026-06-02): the depth a
// cross-chain source action must reach before its swap settles. Higher on the
// lower-hashpower chains to approach BTC-comparable settlement assurance.
// Enforced in _handlePropose(): a follower verifies the proposed source action
// against its OWN indexer for that chain and refuses to co-sign below the
// threshold (see _verifySourceAction).
const DEFAULT_CONFIRMATIONS = { BTC: 6, LTC: 12, DOGE: 60 };

// Allowed chain names
const ALLOWED_CHAINS = ['BTC', 'LTC', 'DOGE'];

// Resolve per-chain confirmation thresholds with the hub's standard three-tier
// idiom: env XCHAIN_CONFIRMATIONS_<COIN> → hub p2pConfig → Tier-B default
// (mirrors AttestationPublisher / AttestationRound config resolution).
function resolveConfirmations(cfg) {
    cfg = cfg || {};
    const out = {};
    for (const coin of ALLOWED_CHAINS) {
        const key = 'XCHAIN_CONFIRMATIONS_' + coin;
        out[coin] = parseInt(process.env[key], 10) || parseInt(cfg[key], 10) || DEFAULT_CONFIRMATIONS[coin];
    }
    return out;
}

const DEFAULT_ATTESTATION_TIMEOUT = 60000; // 60 seconds

class CrossChainEngine extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Validator set (shared with consensus/oracle)
        this.validatorSet = [];

        // Per-chain-pair validator sets: Map<'BTC-DOGE', [{pubkey, addr}]>
        this.chainPairValidators = new Map();

        // Pending attestations: Map<attestationId, pending>
        this.pendingAttestations = new Map();

        // Finalized attestation IDs
        this.finalized = new Set();

        // Message handler
        this._messageHandler = null;

        // Sequence counter for attestation ordering
        this.seq = 0;

        // Config
        this.timeout = parseInt(process.env.ATTESTATION_TIMEOUT) || DEFAULT_ATTESTATION_TIMEOUT;

        // Per-chain cross-chain confirmation thresholds (env/p2pConfig overridable;
        // see resolveConfirmations + the DEFAULT_CONFIRMATIONS note above).
        this.confirmations = resolveConfirmations(this.hub && this.hub.p2pConfig);

        // Per-coin indexer JSON-RPC endpoints used to verify a proposed source
        // action against this hub's own view of the source chain (federation
        // read methods need the api key): <COIN>_INDEXER_URL,
        // <COIN>_INDEXER_API_KEY. Same idiom as CrossChainDexEngine /
        // StateCheckpointEngine.
        let cfg = (this.hub && this.hub.p2pConfig) || {};
        this.indexers = {};
        for (let coin of ALLOWED_CHAINS) {
            this.indexers[coin] = {
                url: process.env[coin + '_INDEXER_URL'] || cfg[coin + '_INDEXER_URL'] || '',
                key: process.env[coin + '_INDEXER_API_KEY'] || cfg[coin + '_INDEXER_API_KEY'] || ''
            };
        }
    }

    // Set the validator set for quorum and leader calculation
    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    // Set per-chain-pair validator subsets for cross-chain quorum
    // chainPairMap: Map<'BTC-DOGE', [{pubkey, addr}]>
    setChainPairValidators(chainPairMap) {
        this.chainPairValidators = chainPairMap;
    }

    // Start listening for cross-chain attestation messages
    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        console.log('Cross-chain attestation engine started');
    }

    // Stop the engine
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        // Reject all pending attestations
        for (let [id, pending] of this.pendingAttestations) {
            if (pending.timer) clearTimeout(pending.timer);
            if (pending.reject) pending.reject(new Error('Cross-chain engine stopped'));
        }
        this.pendingAttestations.clear();
    }

    // Request an attestation; returns a Promise that resolves when consensus is reached
    async requestAttestation(sourceChain, sourceActionIndex, destChain) {
        if (!ALLOWED_CHAINS.includes(sourceChain))
            throw new Error('Invalid sourceChain: ' + sourceChain + ' (allowed: ' + ALLOWED_CHAINS.join(', ') + ')');
        if (!ALLOWED_CHAINS.includes(destChain))
            throw new Error('Invalid destChain: ' + destChain + ' (allowed: ' + ALLOWED_CHAINS.join(', ') + ')');
        let idx = parseInt(sourceActionIndex);
        if (!Number.isInteger(idx) || idx <= 0)
            throw new Error('sourceActionIndex must be a positive integer');

        let attestationId = sourceChain + ':' + sourceActionIndex + ':' + destChain;
        let confirmations = this.confirmations[sourceChain] || DEFAULT_CONFIRMATIONS[sourceChain] || 6;

        // Check if already attested
        if (this.finalized.has(attestationId)) {
            return await this._getStoredAttestation(attestationId);
        }

        // Resolve the cross_chain validator set at the current BTC block
        // boundary so every hub locks the same quorum for this attestation,
        // regardless of when it processes the round (mirrors Consensus /
        // OracleConsensus). The block height is stamped into the PROPOSE
        // envelope below so followers resolve the identical snapshot. Falls
        // back to the live validator set when the indexer is unreachable.
        let btcBlockHeight = this.hub._resolveBtcLatestBlock
            ? await this.hub._resolveBtcLatestBlock()
            : null;

        // Single-node fallback
        let quorum = await this._resolveQuorum(sourceChain, destChain, btcBlockHeight);
        if (quorum === 0) {
            let attestation = {
                attestationId, sourceChain, sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, status: 'attested',
                validatorCount: 1, consensusProof: '[]'
            };
            await this._storeAttestation(attestation);
            return attestation;
        }

        // Check if this node is the leader for this chain pair
        this.seq++;
        let leader = this._getLeader(this.seq, sourceChain, destChain);
        if (leader && leader.addr !== this.peerManager.validatorAddr) {
            throw new Error('Not the leader for attestation (leader: ' + leader.addr + ')');
        }

        let digest = this._digest(attestationId, confirmations);

        return new Promise((resolve, reject) => {
            let pending = {
                attestationId, sourceChain, sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, digest,
                // Lock the quorum at round-start so every PREPARE/COMMIT check
                // for this attestation uses a consistent threshold, even if the
                // validator set changes mid-round. Mirrors Consensus/OracleConsensus.
                quorum,
                btcBlockHeight: btcBlockHeight || null,
                prepares: new Set(),
                commits:  new Set(),
                finalized: false,
                timer:    null,
                resolve, reject
            };

            // Add own PREPARE
            pending.prepares.add(this.peerManager.validatorAddr);
            this.pendingAttestations.set(attestationId, pending);

            // Timeout
            pending.timer = setTimeout(() => {
                if (!pending.finalized) {
                    pending.finalized = true;
                    this.pendingAttestations.delete(attestationId);
                    reject(new Error('Attestation timeout for ' + attestationId));
                }
            }, this.timeout);

            // Broadcast PROPOSE
            this.peerManager.broadcast(XCHAIN_ATTEST_PROPOSE, {
                attestationId, sourceChain,
                sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, digest, btcBlockHeight
            });

            this._checkPrepareQuorum(attestationId);
        });
    }

    // Get stored attestations
    async getAttestations(status, limit) {
        let query = "SELECT * FROM attestations";
        let args = [];
        if (status) {
            query += " WHERE status = ?";
            args.push(status);
        }
        query += " ORDER BY created_at DESC LIMIT ?";
        args.push(limit || 50);
        return await this.db.doQuery(query, args);
    }

    // Get a specific attestation
    async getAttestation(sourceChain, sourceActionIndex) {
        let query = "SELECT * FROM attestations WHERE source_chain = ? AND source_action_index = ? ORDER BY created_at DESC LIMIT 1";
        let rows = await this.db.doQuery(query, [sourceChain, sourceActionIndex]);
        return rows.length > 0 ? rows[0] : null;
    }

    // --- Message handlers ---

    // Defense-in-depth: only tally votes from senders that are registered
    // validators. PeerManager already drops messages whose signature doesn't
    // match a registered pubkey, but counting raw envelope.sender values means a
    // forged sender that slipped past that layer (e.g. during a null-registry
    // window) could otherwise inflate quorum from a single connection. The
    // registry is keyed by addr (the same value used as the sender). A null
    // registry fails closed (the vulnerability scenario); an empty registry
    // stays lenient (genuine pre-bootstrap, where the sig layer already rejects
    // unknown senders and no peer votes should be arriving).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) return true;
        return registry.has(sender);
    }

    _handleMessage(envelope) {
        switch (envelope.type) {
            case XCHAIN_ATTEST_PROPOSE:
                // _handlePropose is async because it locks the cross_chain
                // validator-set snapshot at the round's block boundary via an
                // indexer call. Errors are caught and logged; they never bubble up
                // to the gossip layer (mirrors OracleConsensus).
                this._handlePropose(envelope).catch(err =>
                    console.error('CrossChain: PROPOSE handler error for ' +
                        (envelope && envelope.data && envelope.data.attestationId) + ':',
                        err && err.message));
                break;
            case XCHAIN_ATTEST_PREPARE: this._handlePrepare(envelope); break;
            case XCHAIN_ATTEST_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    async _handlePropose(envelope) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest, btcBlockHeight } = envelope.data;
        if (!attestationId || !digest) return;
        if (!/^[A-Z]{2,6}:\d+:[A-Z]{2,6}$/.test(attestationId)) return;
        if (this.finalized.has(attestationId)) return;

        // Discard proposals from senders that are not registered validators
        // before doing any snapshot/indexer work for them.
        if (!this._isKnownSender(envelope.sender)) return;

        // Verify digest
        let computedDigest = this._digest(attestationId, confirmations);
        if (computedDigest !== digest) return;

        // The discrete fields are what get stored when the round finalizes, so
        // bind them to the attestationId the digest covers; a proposer must
        // not be able to verify one action while attesting another.
        let [idSource, idIndex, idDest] = attestationId.split(':');
        if (idSource !== sourceChain || idDest !== destChain ||
            parseInt(idIndex, 10) !== parseInt(sourceActionIndex, 10)) return;

        // Never trust the proposer's claim: confirm the source action exists on
        // the source chain, at sufficient depth, against this hub's OWN
        // indexer before co-signing. Fails closed (drop, don't sign) when the
        // action is missing, under-confirmed, or unverifiable.
        if (!(await this._verifySourceAction(sourceChain, sourceActionIndex))) {
            console.warn('CrossChain: refusing to PREPARE ' + attestationId +
                ': source action not verified against local indexer');
            return;
        }

        // Create pending if not exists
        if (!this.pendingAttestations.has(attestationId)) {
            // Lock quorum from the same block-boundary cross_chain snapshot the
            // leader used (btcBlockHeight carried in the envelope) so every hub
            // freezes the same N for this round. Falls back to the live set when
            // the indexer is unreachable or the envelope predates this field.
            let quorum = await this._resolveQuorum(sourceChain, destChain, btcBlockHeight);
            this.pendingAttestations.set(attestationId, {
                attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest,
                btcBlockHeight: btcBlockHeight || null,
                quorum,
                prepares: new Set(),
                commits:  new Set(),
                finalized: false,
                timer: setTimeout(() => {
                    this.pendingAttestations.delete(attestationId);
                }, this.timeout * 2),
                resolve: null, reject: null
            });
        }

        let pending = this.pendingAttestations.get(attestationId);
        pending.prepares.add(envelope.sender);
        pending.prepares.add(this.peerManager.validatorAddr);

        // Send PREPARE
        this.peerManager.broadcast(XCHAIN_ATTEST_PREPARE, {
            attestationId, digest
        });

        this._checkPrepareQuorum(attestationId);
    }

    _handlePrepare(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count PREPARE votes from registered validators.
        if (!this._isKnownSender(envelope.sender)) return;

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        this._checkPrepareQuorum(attestationId);
    }

    _handleCommit(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count COMMIT votes from registered validators.
        if (!this._isKnownSender(envelope.sender)) return;

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        pending.commits.add(envelope.sender);
        this._checkCommitQuorum(attestationId);
    }

    // --- Source-action verification ---

    // Confirm the proposed source action exists in this hub's own indexer for
    // the source chain and has reached that chain's confirmation threshold.
    // Fails closed: no endpoint configured, indexer unreachable, action not
    // found, or depth below threshold all return false; the caller must then
    // refuse to co-sign. Availability is deliberately traded away here: a hub
    // that cannot see the source chain has no business attesting actions on it.
    async _verifySourceAction(sourceChain, sourceActionIndex) {
        let idx = parseInt(sourceActionIndex, 10);
        if (!Number.isInteger(idx) || idx <= 0) return false;

        let ix = this.indexers[sourceChain];
        if (!ix || !ix.url) {
            console.warn('CrossChain: no indexer endpoint for ' + sourceChain +
                ' (set ' + sourceChain + '_INDEXER_URL): cannot verify source action');
            return false;
        }

        let required = this.confirmations[sourceChain] || DEFAULT_CONFIRMATIONS[sourceChain];
        if (!Number.isFinite(required) || required <= 0) return false;

        let res;
        try {
            res = await this._indexerCall(sourceChain, 'getactionconfirmations', { action_index: idx });
        } catch (err) {
            console.warn('CrossChain: source action lookup failed for ' + sourceChain + ':' + idx +
                ': ' + (err && err.message));
            return false;
        }
        if (!res || res.error || res.exists !== true) return false;

        let depth = Number(res.confirmations);
        return Number.isFinite(depth) && depth >= required;
    }

    async _indexerCall(coin, method, params) {
        let ix = this.indexers[coin];
        if (!ix || !ix.url) throw new Error('no indexer url for ' + coin);
        let headers = { 'Content-Type': 'application/json' };
        if (ix.key) headers['x-api-key'] = ix.key;
        let resp = await axios.post(ix.url,
            { jsonrpc: '2.0', method, params: params || {}, id: 1 },
            { headers, timeout: 15000 });
        if (resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    _checkPrepareQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        // Use the round's locked quorum (captured at attestation creation),
        // not a live recompute; this keeps every hub in lockstep across the round.
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        if (pending.prepares.size >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            this.peerManager.broadcast(XCHAIN_ATTEST_COMMIT, {
                attestationId:  attestationId,
                digest:         pending.digest
            });

            this._checkCommitQuorum(attestationId);
        }
    }

    _checkCommitQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        // Same locked quorum as _checkPrepareQuorum (see comment there).
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        if (pending.commits.size >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let attestation = {
                attestationId:     pending.attestationId,
                sourceChain:       pending.sourceChain,
                sourceActionIndex: pending.sourceActionIndex,
                destChain:         pending.destChain,
                confirmations:     pending.confirmations,
                status:            'attested',
                validatorCount:    pending.prepares.size,
                consensusProof:    JSON.stringify([...pending.commits])
            };

            this._storeAttestation(attestation)
                .then(() => {
                    this.finalized.add(attestationId);
                    this.pendingAttestations.delete(attestationId);

                    console.log('CrossChain: Attestation finalized: ' + attestationId +
                        ' (' + pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits)');

                    // Emit for downstream processing
                    this.emit('attestation:finalized', attestation);

                    if (pending.resolve) pending.resolve(attestation);
                })
                .catch(err => {
                    console.error('CrossChain: Error storing attestation:', err.message);
                    this.pendingAttestations.delete(attestationId);
                    if (pending.reject) pending.reject(err);
                });
        }
    }

    // --- Storage ---

    async _storeAttestation(attestation) {
        let query = `INSERT INTO attestations
            (attestation_id, source_chain, source_action_index, dest_chain,
             confirmations, status, validator_count, consensus_proof)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, validator_count = ?, consensus_proof = ?, updated_at = NOW()`;
        await this.db.doQuery(query, [
            attestation.attestationId, attestation.sourceChain, attestation.sourceActionIndex,
            attestation.destChain, attestation.confirmations, attestation.status,
            attestation.validatorCount, attestation.consensusProof,
            attestation.status, attestation.validatorCount, attestation.consensusProof
        ]);
    }

    async _getStoredAttestation(attestationId) {
        let rows = await this.db.doQuery(
            "SELECT * FROM attestations WHERE attestation_id = ? LIMIT 1",
            [attestationId]
        );
        return rows.length > 0 ? rows[0] : null;
    }

    // --- Utilities ---

    // Get the validator set for a specific chain pair, or fall back to the full set
    _getChainPairSet(sourceChain, destChain) {
        if (this.chainPairValidators.size > 0) {
            // Try both orderings of the chain pair
            let key1 = sourceChain + '-' + destChain;
            let key2 = destChain + '-' + sourceChain;
            let set = this.chainPairValidators.get(key1) || this.chainPairValidators.get(key2);
            if (set && set.length > 0) return set;
        }
        // Fall back to full validator set
        return this.validatorSet;
    }

    _getLeader(seq, sourceChain, destChain) {
        let set = (sourceChain && destChain)
            ? this._getChainPairSet(sourceChain, destChain)
            : this.validatorSet;
        if (set.length === 0) return null;
        return set[seq % set.length];
    }

    // Resolve the round's quorum from a deterministic block-boundary snapshot
    // of the cross_chain capability set (every hub queries the same blockIndex
    // on the BTC indexer and arrives at the same N, so two hubs processing the
    // same attestation at different wall-clock times lock the same quorum).
    // Falls back to the live validator set when the indexer can't be reached or
    // the envelope carries no block height (e.g. an old peer mid rolling deploy).
    // Graceful degradation to the pre-snapshot behavior. Mirrors the
    // getSnapshot/getQuorum pattern in OracleConsensus and Consensus.
    async _resolveQuorum(sourceChain, destChain, btcBlockHeight) {
        let snapshot = (this.hub.capabilitySnapshot && btcBlockHeight)
            ? await this.hub.capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight)
            : null;
        if (snapshot) return this.hub.capabilitySnapshot.getQuorum(snapshot);
        return this._getQuorum(sourceChain, destChain);
    }

    _getQuorum(sourceChain, destChain) {
        let N;
        if (sourceChain && destChain) {
            let set = this._getChainPairSet(sourceChain, destChain);
            N = set.length;
        } else {
            N = this.validatorSet.length;
        }
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

    _digest(attestationId, confirmations) {
        let payload = JSON.stringify({ attestationId, confirmations });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = CrossChainEngine;
