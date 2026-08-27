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
const coins        = require('./coins');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { positiveIntConfig } = require('./lib/config_int.js');
const { isAdmissibleSigner, provenPubkey } = require('./lib/chain_signer_admission.js');

const XCHAIN_ATTEST_PROPOSE = 'XCHAIN_ATTEST_PROPOSE';
const XCHAIN_ATTEST_PREPARE = 'XCHAIN_ATTEST_PREPARE';
const XCHAIN_ATTEST_COMMIT  = 'XCHAIN_ATTEST_COMMIT';

// Default per-chain confirmation thresholds (Tier B, 2026-06-02): the depth a
// cross-chain source action must reach before its swap settles. Higher on the
// lower-hashpower chains to approach BTC-comparable settlement assurance.
// Enforced in _handlePropose(): a follower verifies the proposed source action
// against its OWN indexer for that chain and refuses to co-sign below the
// threshold (see _verifySourceAction).
const DEFAULT_CONFIRMATIONS = { ...coins.DEFAULT_CONFIRMATIONS };

// Allowed chain names
const ALLOWED_CHAINS = [...coins.ALLOWED_COINS];

const DEFAULT_ATTESTATION_TIMEOUT = 60000; // 60 seconds

// Bounded retry for persisting a quorum-finalized attestation.
// Sized to ride out a DB blip well inside DEFAULT_ATTESTATION_TIMEOUT, which
// remains the terminal backstop for a store that never lands.
const DEFAULT_STORE_RETRY_ATTEMPTS = 4;
const DEFAULT_STORE_RETRY_BASE_MS  = 100;
const STORE_RETRY_MAX_DELAY_MS     = 2000;

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

        // Finalized attestation IDs, bounded FIFO (R2-CCF4): this set is a
        // steady-state dedup guard that only ever grew, so a long-lived hub
        // leaked one entry per finalized attestation forever. Cap it with an
        // insertion-order ring, mirroring CrossChainDexConsensus._markFinalized.
        // The window only needs to outlast in-flight rounds for the same id, so
        // a large bound is ample; re-finalization after eviction is harmless
        // (the DB row keyed on attestationId is idempotent via ON DUPLICATE KEY).
        this.finalized = new Set();
        this._finalizedOrder = [];
        this.finalizedMax = positiveIntConfig(process.env.XCHAIN_ATTEST_FINALIZED_MAX, 10000, 'XCHAIN_ATTEST_FINALIZED_MAX');

        // Message handler
        this._messageHandler = null;

        // Sequence counter for attestation ordering
        this.seq = 0;

        // Config
        this.timeout = parseInt(process.env.ATTESTATION_TIMEOUT) || DEFAULT_ATTESTATION_TIMEOUT;

        // Persistence retry for a quorum-finalized attestation. The
        // INSERT is idempotent (ON DUPLICATE KEY UPDATE), so re-running it after
        // a partial failure is safe.
        this.storeRetryAttempts = positiveIntConfig(process.env.XCHAIN_ATTEST_STORE_RETRIES,
            DEFAULT_STORE_RETRY_ATTEMPTS, 'XCHAIN_ATTEST_STORE_RETRIES');
        this.storeRetryBaseMs   = positiveIntConfig(process.env.XCHAIN_ATTEST_STORE_RETRY_MS,
            DEFAULT_STORE_RETRY_BASE_MS, 'XCHAIN_ATTEST_STORE_RETRY_MS');

        // Per-chain cross-chain confirmation thresholds (env/p2pConfig overridable;
        // mainnet floor-clamped, see coins.resolveConfirmations).
        this.confirmations = coins.resolveConfirmations(
            this.hub && this.hub.p2pConfig, this.hub && this.hub.network);

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
        // Fill any indexer URL left empty at construction (configs-table-
        // provisioned hubs carry no *_INDEXER_URL env var) via the hub's
        // configs-aware resolver, so a standard configs-provisioned hub reaches
        // the indexer instead of falling through to the empty-URL guard.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
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

        // The id is derived from the VALIDATED index, never the raw argument. parseInt
        // accepts a prefix, so '1junk' and '01' cleared the guard as index 1 and then
        // built 'BTC:1junk:DOGE': followers drop that on their canonical-id regex and the
        // round times out, while a single-node hub mints a distinct row per spelling of
        // one action. The stored row and the PROPOSE payload below already parse.
        let attestationId = sourceChain + ':' + idx + ':' + destChain;
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
            // quorum 0 has two causes: a genuine single-operator deployment (no
            // federation) OR an EMPTY cross_chain capability snapshot in a real
            // federation (bootstrap / misconfig). Unilaterally minting an 'attested'
            // row is only safe in the first case. If a capability snapshot resolved at
            // this block but carried NO qualifying validators, refuse: finalizing over
            // an empty federation snapshot mints an attestation no peer ratified and no
            // depth-verification gated (the same empty-snapshot hazard fixed for the
            // DEX). When no snapshot resolved (genuine single node) keep the fast path.
            let snap = (this.hub.capabilitySnapshot && btcBlockHeight)
                ? await this.hub.capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight)
                : null;
            if (snap && Array.isArray(snap.validators) && snap.validators.length === 0) {
                throw new Error('CrossChain: refusing to finalize attestation ' + attestationId +
                    ' unilaterally over an EMPTY cross_chain snapshot (block ' + btcBlockHeight +
                    '); will retry when the snapshot populates');
            }
            let attestation = {
                attestationId, sourceChain, sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, status: 'attested',
                validatorCount: 1, consensusProof: '[]'
            };
            await this._storeAttestation(attestation);
            // Same post-store bookkeeping the consensus path does in
            // _checkCommitQuorum. Without it a single-operator hub wrote an
            // 'attested' row that nothing downstream ever heard about: SwapTracker
            // subscribes to 'attestation:finalized', so its swap_records rows sat at
            // 'initiated' forever, and a repeat request re-ran the whole path instead
            // of short-circuiting on the finalized ring.
            this._markFinalized(attestationId);
            this.emit('attestation:finalized', attestation);
            return attestation;
        }

        // Check if this node is the leader for this chain pair
        this.seq++;
        let leader = this._getLeader(this.seq, sourceChain, destChain);
        if (leader && leader.addr !== this.peerManager.validatorAddr) {
            throw new Error('Not the leader for attestation (leader: ' + leader.addr + ')');
        }

        let digest = this._digest(attestationId, confirmations);

        // Lock the VOTE POPULATION alongside the quorum, from the same snapshot that
        // sized it, so N's divisor and its numerator read one set (see _countedVotes).
        let memberPubkeys = await this._resolveMemberPubkeys(btcBlockHeight);

        return new Promise((resolve, reject) => {
            let pending = {
                attestationId, sourceChain, sourceActionIndex: parseInt(sourceActionIndex),
                destChain, confirmations, digest,
                // Lock the quorum at round-start so every PREPARE/COMMIT check
                // for this attestation uses a consistent threshold, even if the
                // validator set changes mid-round. Mirrors Consensus/OracleConsensus.
                quorum,
                memberPubkeys,
                btcBlockHeight: btcBlockHeight || null,
                prepares: new Set(),
                commits:  new Set(),
                finalized: false,
                timer:    null,
                resolve, reject
            };

            // Add own PREPARE
            // Vote sets hold PROVEN SIGNING KEYS, not sender addrs (see _addVote).
            let selfPkOnPropose = this._selfPubkey();
            if (selfPkOnPropose) pending.prepares.add(selfPkOnPropose);
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

    // Whether an authenticated envelope may be counted toward attestation quorum.
    // Admits on the PROVEN signing key (chain-effective set OR registry), never on
    // envelope.sender, so a validator that staked on chain is counted without any
    // operator hand-registering it first. Shared definition and the full security
    // argument in lib/chain_signer_admission.js.
    _isKnownSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    }

    // Verified signing pubkey (lowercase hex) for a sender addr, or null. PeerManager
    // enforces the registry binding on every verified envelope (a registered sender's
    // envelope MUST carry its registered key's signature), so this resolves the identity
    // that actually signed rather than a claim. Own addr falls back to the local identity
    // for a hub absent from its own registry. Mirrors OracleConsensus._resolveSenderPubkey.
    _resolveSenderPubkey(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        let pk = (registry && typeof registry.get === 'function') ? registry.get(sender) : null;
        if (!pk && this.peerManager && sender === this.peerManager.validatorAddr) {
            let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
            if (identity) pk = identity.getPubkeyHex();
        }
        return pk ? String(pk).toLowerCase() : null;
    }

    // This hub's own signing key, for seeding its own vote into a key-keyed
    // prepare/commit set. Null only on a hub that cannot sign a vote anyway.
    _selfPubkey() {
        return this._resolveSenderPubkey(this.peerManager && this.peerManager.validatorAddr);
    }

    // Record one peer's vote in a key-keyed set. The envelope has already cleared
    // _isKnownSender, so it carries a proven key. N envelopes from ONE key collapse
    // to a single entry however many distinct senders they name, which is what
    // bounds count-mode forgery here.
    _addVote(voteSet, envelope) {
        let pk = provenPubkey(envelope);
        if (pk) voteSet.add(pk);
    }

    // Pubkey set of the round's locked cross_chain snapshot, or null when no usable
    // snapshot resolved. Null DISABLES the membership filter, which preserves the
    // bootstrap / single-node path _resolveQuorum already keeps (there the quorum came
    // from the live validator set, not from a snapshot, so there is no snapshot
    // population to gate against). Mirrors OracleConsensus._memberPubkeySet.
    _memberPubkeySet(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
        let set = new Set();
        for (let v of snapshot.validators) {
            if (v && v.pubkey) set.add(String(v.pubkey).toLowerCase());
        }
        return set.size > 0 ? set : null;
    }

    // Resolve the member-pubkey set for a round at the same block boundary _resolveQuorum
    // sized N from. Read separately (rather than by widening _resolveQuorum's return) so
    // the quorum contract callers and tests depend on is untouched; CapabilitySnapshot
    // caches per (capability, block), so this is a cache hit behind the quorum resolve.
    // Never throws: a failure here degrades to the legacy unfiltered tally, exactly as an
    // unresolved snapshot already does, and _resolveQuorum has already refused the round
    // outright in the federated case.
    async _resolveMemberPubkeys(btcBlockHeight) {
        if (!this.hub.capabilitySnapshot || btcBlockHeight == null) return null;
        try {
            return this._memberPubkeySet(
                await this.hub.capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight));
        } catch (err) {
            console.warn('CrossChain: could not resolve the cross_chain member set at block ' +
                btcBlockHeight + ' (' + (err && err.message) + '); tallying unfiltered');
            return null;
        }
    }

    // Count a PREPARE/COMMIT vote set against the round's SNAPSHOT population.
    //
    // The quorum N is sized from the stake-qualified block-locked snapshot, so the votes
    // measured against it must come from that same population. _isKnownSender only proves
    // the sender is in this hub's REGISTERED-validator registry, which admits keys with no
    // qualifying cross_chain stake at the round's block; and the tally is addr-keyed while
    // the registry can bind one signing key to several addrs, so one key could be counted
    // twice. Either way the snapshot became the divisor without being the population, and
    // an attestation SwapTracker settles from escrow could finalize on votes the qualified
    // members never cast. Resolve each sender to its verified pubkey, keep only snapshot
    // members, and count DISTINCT pubkeys. This is the invariant Consensus (leader
    // election) and OracleConsensus (Oracle M1 submissions) already enforce.
    //
    // The vote sets now hold proven signing keys directly, so this only intersects
    // them with the round's snapshot membership. One degradation remains: a null
    // memberPubkeys means no snapshot population resolved (single-node / bootstrap),
    // the same state _resolveQuorum falls back to the live set in. The old
    // empty-registry degradation is gone with the registry lookup it protected: a
    // key that no longer needs resolving through the registry cannot be un-resolvable
    // because the registry is empty.
    _countedVotes(pending, voteSet) {
        if (!pending || !pending.memberPubkeys) return voteSet ? voteSet.size : 0;
        let counted = 0;
        for (let pk of voteSet) {
            if (pending.memberPubkeys.has(pk)) counted++;
        }
        return counted;
    }

    _handleMessage(envelope) {
        switch (envelope.type) {
            case XCHAIN_ATTEST_PROPOSE:
                // _handlePropose is async because it locks the cross_chain
                // validator-set snapshot at the round's block boundary via an
                // indexer call. Errors are caught and logged; they never bubble up
                // to the gossip layer (mirrors OracleConsensus).
                this._handlePropose(envelope).catch(err =>
                    console.error('CrossChain: PROPOSE handler error for %s:',
                        (envelope && envelope.data && envelope.data.attestationId),
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
        if (!this._isKnownSender(envelope)) return;

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
            let quorum;
            try {
                quorum = await this._resolveQuorum(sourceChain, destChain, btcBlockHeight);
            } catch (err) {
                // Fail closed: _resolveQuorum throws when federated but no
                // deterministic snapshot resolved. Drop the PROPOSE (don't co-sign)
                // rather than PREPARE over a locally-derived quorum peers aren't using.
                console.warn('CrossChain: refusing to PREPARE ' + attestationId + ': ' + err.message);
                return;
            }
            // A follower must NEVER finalize over a quorum of 0. Unlike the leader's
            // single-operator fast path (requestAttestation, which self-signs only after
            // confirming no federation snapshot resolved), reaching _handlePropose means a
            // PEER proposed, so a federation exists. A 0 quorum here means the cross_chain
            // capability snapshot at btcBlockHeight resolved EMPTY (bootstrap / a misconfigured
            // indexer / an unpopulated qualifying set); co-signing would let a single PROPOSE
            // mint an 'attested' row no quorum ratified, which downstream indexers then settle
            // from escrow. This is the same empty-snapshot hazard the leader path already guards
            // and the DEX engine was hardened against. Refuse; the round retries once the
            // snapshot populates. (A genuine single-node hub has no peers, so never reaches here.)
            if (quorum === 0) {
                console.warn('CrossChain: refusing to PREPARE ' + attestationId +
                    ': cross_chain snapshot resolved a 0 quorum (empty / bootstrap) at block ' + btcBlockHeight);
                return;
            }
            // Same block boundary the leader resolved, carried in the PROPOSE envelope, so
            // follower and leader gate their tallies on the identical member set.
            let memberPubkeys = await this._resolveMemberPubkeys(btcBlockHeight);
            this.pendingAttestations.set(attestationId, {
                attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest,
                memberPubkeys,
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
        this._addVote(pending.prepares, envelope);
        let selfPkOnAccept = this._selfPubkey();
        if (selfPkOnAccept) pending.prepares.add(selfPkOnAccept);

        // Send PREPARE
        this.peerManager.broadcast(XCHAIN_ATTEST_PREPARE, {
            attestationId, digest
        });

        this._checkPrepareQuorum(attestationId);
    }

    _handlePrepare(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count PREPARE votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) return;

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        this._addVote(pending.prepares, envelope);
        this._checkPrepareQuorum(attestationId);
    }

    _handleCommit(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count COMMIT votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) return;

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        this._addVote(pending.commits, envelope);
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
            { headers, timeout: parseInt(process.env.CROSS_CHAIN_INDEXER_TIMEOUT) || 15000 });
        if (resp.data && resp.data.error) throw new Error('indexer RPC error: ' + JSON.stringify(resp.data.error));
        return resp.data ? resp.data.result : null;
    }

    _checkPrepareQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        // Use the round's locked quorum (captured at attestation creation),
        // not a live recompute; this keeps every hub in lockstep across the round.
        // Votes are counted against the round's locked snapshot population (_countedVotes),
        // so the threshold and the electorate come from one set.
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        if (this._countedVotes(pending, pending.prepares) >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            let selfPkOnCommit = this._selfPubkey();
            if (selfPkOnCommit) pending.commits.add(selfPkOnCommit);

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

        // Same locked quorum and same snapshot-gated tally as _checkPrepareQuorum.
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this._getQuorum();
        if (this._countedVotes(pending, pending.commits) >= quorum) {
            pending.finalized = true;
            // Do NOT clear the round timer here: it is the backstop for a store
            // that never succeeds. It is cleared on the success path instead.

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

            this._storeWithRetry(attestation)
                .then(() => {
                    if (pending.timer) clearTimeout(pending.timer);
                    this._markFinalized(attestationId);
                    this.pendingAttestations.delete(attestationId);

                    console.log('CrossChain: Attestation finalized: ' + attestationId +
                        ' (' + pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits)');

                    // Emit for downstream processing
                    this.emit('attestation:finalized', attestation);

                    if (pending.resolve) pending.resolve(attestation);
                })
                .catch(err => {
                    // Retain the round instead of deleting it. Both
                    // _handleCommit and this method return early once the id is
                    // gone from pendingAttestations, so dropping it here destroys
                    // a quorum-signed attestation that peer hubs have already
                    // persisted, with no later COMMIT able to re-drive the store.
                    // Reset the finalize flag so a retransmitted COMMIT does, and
                    // leave the round timer (never cleared above) as the terminal
                    // backstop that rejects and evicts the round.
                    console.error('CrossChain: Error storing attestation after ' +
                        this.storeRetryAttempts + ' attempt(s), retaining round for retry: ' + err.message);
                    pending.finalized = false;
                });
        }
    }

    // --- Storage ---

    // Persist a quorum-finalized attestation, retrying a transient DB failure
    // with exponential backoff before giving up. Safe to re-run:
    // _storeAttestation upserts on attestation_id.
    async _storeWithRetry(attestation) {
        let delay = this.storeRetryBaseMs;
        for (let attempt = 1; ; attempt++) {
            try {
                await this._storeAttestation(attestation);
                return;
            } catch (err) {
                if (attempt >= this.storeRetryAttempts) throw err;
                console.warn('CrossChain: attestation store attempt ' + attempt + '/' +
                    this.storeRetryAttempts + ' failed for ' + attestation.attestationId +
                    ' (' + err.message + '); retrying in ' + delay + 'ms');
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, STORE_RETRY_MAX_DELAY_MS);
            }
        }
    }

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
    // Federation-split guard (fail closed), mirroring Consensus.js:170-173 and
    // OraclePublisher's retired live-registry fallback. The prior
    // form fell back to this hub's LOCAL live validator set (or, worse, open-peer
    // count + 1 in _getQuorum) whenever the snapshot was unresolved -- so a hub with
    // an unreachable BTC indexer locked a DIFFERENT N/quorum than a healthy peer for
    // the same (cross_chain, block) round. When federated, refuse rather than
    // split. Single-node / regtest hubs (no snapshot AND a live quorum of 0, i.e. no
    // peers) have no peer to diverge from, so they keep the live fallback for
    // bootstrap. btcBlockHeight is compared `!= null` (not truthiness) so a genuine
    // block height of 0 still resolves a snapshot instead of being treated as absent.
    async _resolveQuorum(sourceChain, destChain, btcBlockHeight) {
        let snapshot = (this.hub.capabilitySnapshot && btcBlockHeight != null)
            ? await this.hub.capabilitySnapshot.getSnapshot('cross_chain', btcBlockHeight)
            : null;
        if (snapshot) return this.hub.capabilitySnapshot.getQuorum(snapshot);
        let live = this._getQuorum(sourceChain, destChain);
        if (live > 0) {
            throw new Error('CrossChain: refusing to resolve quorum without a deterministic ' +
                'cross_chain snapshot while federated (block ' + btcBlockHeight + '); the indexer ' +
                'capability snapshot is unavailable and falling back to the local validator set ' +
                'would fork N/quorum against peers for this round');
        }
        return live;
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
        // N<=1: single node, no peer to reach (0 = caller bypasses). Above that,
        // the majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    }

    // Record a finalized attestation id under the bounded FIFO ring (R2-CCF4).
    // Evicts the oldest id once the window is full so the set cannot grow without
    // limit over the process lifetime.
    _markFinalized(attestationId) {
        if (this.finalized.has(attestationId)) return;
        this.finalized.add(attestationId);
        this._finalizedOrder.push(attestationId);
        if (this._finalizedOrder.length > this.finalizedMax) {
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
        }
    }

    _digest(attestationId, confirmations) {
        let payload = JSON.stringify({ attestationId, confirmations });
        return crypto.createHash('sha256').update(payload).digest('hex');
    }
}

module.exports = CrossChainEngine;
