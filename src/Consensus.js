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
 * XChain Hub - PBFT Consensus Engine
 *
 * Implements a simplified PBFT (Practical Byzantine Fault Tolerance)
 * consensus protocol for config writes. Ensures all hub instances
 * agree on config state before applying changes.
 *
 * Flow: PRE_PREPARE -> PREPARE (2f+1) -> COMMIT (2f+1) -> Apply
 *
 * Single-node fallback: when no peers are connected, writes are
 * applied directly without consensus.
 *
 ********************************************************************/

const crypto = require('crypto');
const swq    = require('./stake_weighted_quorum.js');
const eq     = require('./equivocation_header.js');

const PBFT_PRE_PREPARE = 'PBFT_PRE_PREPARE';
const PBFT_PREPARE     = 'PBFT_PREPARE';
const PBFT_COMMIT      = 'PBFT_COMMIT';
const PBFT_VIEW_CHANGE = 'PBFT_VIEW_CHANGE';
const PBFT_NEW_VIEW    = 'PBFT_NEW_VIEW';

const DEFAULT_TIMEOUT = 30000; // 30 seconds

class Consensus {

    constructor(hub) {
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Sequence counter (loaded from DB on start)
        this.seq = 0;

        // View number (incremented on leader failover, reset on successful consensus)
        this.view = 0;

        // Validator set: sorted array of { pubkey, addr }
        // Loaded from DB on start; used for leader rotation and quorum
        this.validatorSet = [];

        // Pending proposals: Map<seq, proposal>
        this.pendingProposals = new Map();

        // Pending view changes: Map<view, Set<sender>>
        this.pendingViewChanges = new Map();

        // STAKE_WEIGHTED_QUORUM: parallel pubkey vote tally for view changes,
        // Map<view, Set<pubkey>>. Populated only on weighted rounds (the address
        // set above stays authoritative for the legacy count path). The weighted
        // view-change quorum is checked against this set's summed source stake.
        this.pendingViewChangePubkeys = new Map();

        // Round-locked quorum captured when THIS node initiates a view change,
        // keyed by seq (the proposal round). The proposal is removed from
        // pendingProposals by the same timeout that triggers the view change,
        // so the initiator can no longer read proposal.quorum; we stash it
        // here so view-change acceptance tallies against the proposal-creation
        // snapshot, matching PREPARE/COMMIT. Map<seq, quorum>.
        this.viewChangeQuorums = new Map();

        // Digests already applied (prevents double-apply from late COMMIT messages)
        this.applied = new Set();

        // Pending client request (when this node is not the leader)
        this.pendingClientConfig = null;

        // Message handler reference (for cleanup)
        this._messageHandler = null;

        // Sequence tracking for replay prevention
        this.lastAppliedSeq = 0;

        // Config
        this.timeout       = parseInt(process.env.PBFT_TIMEOUT) || DEFAULT_TIMEOUT;
        this.minValidators = parseInt(process.env.MIN_VALIDATORS) || 1;
    }

    // Set the validator set (sorted array of { pubkey, addr })
    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    // Start the consensus engine
    async start() {
        // Load last sequence number from DB
        await this._loadSeq();

        // Subscribe to P2P messages
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        console.log('Consensus engine started (seq: ' + this.seq + ')');
    }

    // Stop the consensus engine
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }

        // Reject all pending proposals
        for (let [seq, proposal] of this.pendingProposals) {
            if (!proposal.resolved) {
                proposal.resolved = true;
                if (proposal.timer) clearTimeout(proposal.timer);
                if (proposal.reject) proposal.reject(new Error('Consensus engine stopped'));
            }
        }
        this.pendingProposals.clear();
        this.viewChangeQuorums.clear();
        // Drop any sub-quorum view-change tallies so a within-process restart
        // (e.g. a hub reconfiguration that tears down and re-inits the engine)
        // doesn't inherit stale entries from the previous run.
        this.pendingViewChanges.clear();
        this.pendingViewChangePubkeys.clear();
    }

    // Propose a config change. Returns a Promise that resolves when consensus is reached.
    async propose(config) {
        // Lock the validator-set snapshot at the current BTC chain tip so
        // every hub in the federation computes the same quorum for this
        // config-change round. Whole-federation snapshot (not capability-
        // scoped) because config changes affect every staker equally.
        // Falls back to live _getQuorum() when the indexer or BTC tip
        // can't be resolved (graceful degradation; same behavior as before
        // the snapshot wiring landed).
        let { snapshot, weighted } = await this._lockSnapshot();
        // Fall back to count mode when weighted is requested but no snapshot is
        // available (BTC indexer unreachable). An empty validator list makes
        // meetsStakeThreshold always false, stalling the round permanently.
        if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
            console.warn('Consensus: weighted mode requested but snapshot unavailable; falling back to count mode for this round');
            weighted = false;
        }
        let quorum = snapshot
            ? this.hub.capabilitySnapshot.getQuorum(snapshot)
            : this._getQuorum();

        // Single-node fallback: no peers connected -> apply directly
        if (quorum === 0) {
            if (this.minValidators > 1) {
                console.warn('Consensus: operating in single-node mode (MIN_VALIDATORS=' + this.minValidators + ' but quorum is 0)');
            }
            await this._applyConfig(config);
            return true;
        }

        // Leader check: only the leader for the next seq can propose
        let nextSeq = this.seq + 1;
        let leader = this._getLeader(nextSeq);
        if (leader && leader.addr !== this.peerManager.validatorAddr) {
            throw new Error('Not the leader for seq ' + nextSeq + ' (leader: ' + leader.addr + ')');
        }

        // Increment sequence
        this.seq++;
        let seq = this.seq;
        this.view = 0; // Reset view on new proposal
        let digest = this._digest(config);

        // Create proposal
        return new Promise((resolve, reject) => {
            let proposal = {
                config:   config,
                digest:   digest,
                view:     this.view,    // EQUIV (WI-2 bump 2): all 3 votes for this round sign (seq, view, digest)
                prepares: new Set(),
                commits:  new Set(),
                resolved: false,
                applied:  false,
                timer:    null,
                resolve:  resolve,
                reject:   reject,
                // Snapshot of the federation validator set at the BTC tip
                // at PROPOSE time. PREPARE/COMMIT checks read pending.quorum
                // so the entire round uses the same N even when on-chain
                // stake state drifts mid-round.
                snapshot:       snapshot || null,
                quorum:         quorum,
                btcBlockHeight: snapshot ? snapshot.blockIndex : null,
                // STAKE_WEIGHTED_QUORUM round? Carry the source-keyed validator
                // weights + parallel pubkey vote sets (the address Sets above stay
                // authoritative for the count path; these are consulted only when
                // weighted). One vote per staking source (DELEGATE v0 is additive).
                weighted:       !!weighted,
                validators:     this._normalizeValidators(snapshot, weighted),
                preparePubkeys: weighted ? new Set() : null,
                commitPubkeys:  weighted ? new Set() : null
            };

            // Add own PREPARE vote
            proposal.prepares.add(this.peerManager.validatorAddr);
            if (proposal.weighted) this._addSelfPubkey(proposal.preparePubkeys);

            this.pendingProposals.set(seq, proposal);

            // Set timeout; triggers view change on failure
            proposal.timer = setTimeout(() => {
                if (!proposal.resolved) {
                    proposal.resolved = true;
                    this.pendingProposals.delete(seq);
                    // Initiate view change so a new leader can take over.
                    // Pass the round-locked quorum + weighted context so the
                    // view-change vote tally uses the same rule (count or stake)
                    // this proposal round used, even though we've just removed the
                    // proposal from the map. Captured here, before deletion.
                    this._initiateViewChange(seq, proposal.quorum, proposal.weighted, proposal.validators);
                    reject(new Error('Consensus timeout for seq ' + seq + ' (received ' +
                        proposal.prepares.size + ' prepares, ' + proposal.commits.size + ' commits, need ' + quorum + ')'));
                }
            }, this.timeout);

            // Broadcast PRE_PREPARE with the full config + the BTC block
            // height the leader snapshotted at, so followers can resolve the
            // same validator set at the same block boundary. `weighted` is a
            // hint only; followers re-derive it from the block height + network.
            this.peerManager.broadcast(PBFT_PRE_PREPARE, Object.assign({
                seq:            seq,
                view:           this.view,
                configDigest:   digest,
                config:         config,
                btcBlockHeight: proposal.btcBlockHeight,
                weighted:       proposal.weighted
            }, this._equivVote(seq, this.view, digest, proposal.btcBlockHeight)));

            // Check if we already have quorum (unlikely but handles edge case)
            this._checkPrepareQuorum(seq);
        });
    }

    // Acquire the federation validator-set snapshot at the current BTC tip.
    // Used by both the leader (in propose) and followers (in _handlePrePrepare).
    // The leader stamps its tip into the PRE_PREPARE envelope so followers
    // call this with the matching blockIndex.
    // Returns { snapshot, weighted }. STAKE_WEIGHTED_QUORUM: at/above the
    // activation block on this hub's network, lock the SOURCE-KEYED weight
    // snapshot (getActiveWeightSnapshot -> [{pubkey,source,weight}]) so quorum is
    // tallied by stake; below activation, the count snapshot (byte-identical to
    // the legacy path). `weighted` is gated on the BTC block boundary + network so
    // the hub and every other hub flip on the same anchor. Returns
    // { snapshot: null, weighted } when no snapshot can be acquired (the caller
    // then falls back to live _getQuorum(), as before).
    async _lockSnapshot(blockHeightOverride) {
        if (!this.hub || !this.hub.capabilitySnapshot) return { snapshot: null, weighted: false };
        let blockHeight = blockHeightOverride;
        if (blockHeight === undefined || blockHeight === null) {
            // _resolveBtcLatestBlock checks hub.db.getChainTip first, then
            // falls back to a direct getlatestblock call against the BTC
            // indexer. So this works whether or not chain-tip-push is wired.
            blockHeight = await this.hub._resolveBtcLatestBlock();
        }
        if (!blockHeight) return { snapshot: null, weighted: false };
        let weighted = swq.isStakeWeightedQuorumActive(blockHeight, this.hub.network);
        let snapshot = weighted
            ? await this.hub.capabilitySnapshot.getActiveWeightSnapshot(blockHeight)
            : await this.hub.capabilitySnapshot.getActiveValidatorSnapshot(blockHeight);
        return { snapshot: snapshot, weighted: weighted };
    }

    // --- Private methods ---

    // Defense-in-depth: only tally votes from senders that are registered
    // validators. PeerManager already drops any message whose signature doesn't
    // match a registered pubkey, so in normal operation an unregistered sender
    // never reaches these handlers. But counting raw envelope.sender values
    // means a forged sender that slipped past that layer (e.g. during a
    // null-registry window) could otherwise inflate quorum from a single
    // connection. The registry is keyed by addr, the same value used as the
    // sender. A null registry fails closed (matches the vulnerability scenario);
    // an empty registry stays lenient (genuine pre-bootstrap, where no peer
    // votes should be arriving and the sig layer already rejects unknown
    // senders).
    _isKnownSender(sender) {
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (!registry) return false;
        if (registry.size === 0) return true;
        return registry.has(sender);
    }

    // Handle incoming P2P messages
    _handleMessage(envelope) {
        switch (envelope.type) {
            case PBFT_PRE_PREPARE:
                // _handlePrePrepare is async because it locks the validator-set
                // snapshot at the leader-stamped block boundary via an indexer
                // call. Errors are caught and logged; they never bubble up to
                // the gossip layer.
                this._handlePrePrepare(envelope).catch(err =>
                    console.error('Consensus: PRE_PREPARE handler error for seq ' +
                        (envelope && envelope.data && envelope.data.seq) + ':',
                        err && err.message ? err.message : err));
                break;
            case PBFT_PREPARE:     this._handlePrepare(envelope);    break;
            case PBFT_COMMIT:      this._handleCommit(envelope);     break;
            case PBFT_VIEW_CHANGE: this._handleViewChange(envelope); break;
            case PBFT_NEW_VIEW:    this._handleNewView(envelope);    break;
        }
    }

    // Handle PRE_PREPARE: validate and respond with PREPARE
    async _handlePrePrepare(envelope) {
        let { seq, view, configDigest, config, btcBlockHeight } = envelope.data;

        // Validate
        if (!seq || !configDigest || !config) return;
        if (typeof seq !== 'number' || seq <= 0) return;

        // Discard proposals from senders that are not registered validators
        // before doing any snapshot/indexer work for them.
        if (!this._isKnownSender(envelope.sender)) return;

        // Leader-identity guard: a PRE_PREPARE must come from the validator the
        // rotation designates as leader for the CLAIMED (seq, view), mirroring
        // the check _handleNewView applies to NEW_VIEW and OracleConsensus
        // applies to PROPOSE. Without it any registered validator could inject a
        // PRE_PREPARE for an uncontested seq and drive every follower to PREPARE/
        // COMMIT its config. The leader stamps its view into the envelope, so
        // (seq + view) % N matches _getLeader's rotation evaluated at the claimed
        // view. A Byzantine node can therefore only ever propose in a (seq, view)
        // for which it is already the legitimate leader.
        if (typeof view !== 'number') {
            console.warn('PBFT: Rejecting PRE_PREPARE with no view from ' + envelope.sender + ' (seq ' + seq + ')');
            return;
        }
        let N = this.validatorSet.length;
        if (N === 0) return;
        let expectedLeader = this.validatorSet[(seq + view) % N];
        if (!expectedLeader || envelope.sender !== expectedLeader.addr) {
            console.warn('PBFT: Rejecting PRE_PREPARE for seq ' + seq + ' view ' + view +
                ' from non-leader ' + envelope.sender);
            return;
        }

        // Reject stale/replayed sequence numbers
        if (seq <= this.lastAppliedSeq) {
            console.warn('Consensus: Rejecting PRE_PREPARE with stale seq ' + seq + ' (last applied: ' + this.lastAppliedSeq + ')');
            return;
        }

        // Verify digest matches the config
        let computedDigest = this._digest(config);
        if (computedDigest !== configDigest) {
            console.warn('PBFT: PRE_PREPARE digest mismatch from ' + envelope.sender + ' (seq ' + seq + ')');
            return;
        }

        // If we already have this proposal, don't create a duplicate
        if (!this.pendingProposals.has(seq)) {
            // Lock the federation validator-set snapshot at the SAME block
            // the leader snapshotted at (stamped into the PRE_PREPARE
            // envelope). Follower quorum-checks use proposal.quorum, so we
            // stay in lockstep with the leader for the whole round.
            let { snapshot, weighted } = await this._lockSnapshot(btcBlockHeight);
            // Fall back to count mode when weighted but snapshot is unavailable,
            // matching the same guard in propose(). Without this, a follower
            // that can't reach its BTC indexer enters PBFT with validators=[]
            // and weighted=true, making meetsStakeThreshold always false and
            // stalling view-change recovery as well.
            if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
                console.warn('Consensus: follower weighted mode requested but snapshot unavailable; falling back to count mode');
                weighted = false;
            }
            let quorum = snapshot
                ? this.hub.capabilitySnapshot.getQuorum(snapshot)
                : this._getQuorum();

            // Create a follower proposal (no resolve/reject; we didn't initiate it)
            let proposal = {
                config:   config,
                digest:   configDigest,
                view:     view,         // EQUIV (WI-2 bump 2): the leader's view, stamped in the PRE_PREPARE
                prepares: new Set(),
                commits:  new Set(),
                resolved: false,
                applied:  false,
                timer:    null,
                resolve:  null,
                reject:   null,
                snapshot:       snapshot || null,
                quorum:         quorum,
                btcBlockHeight: btcBlockHeight || null,
                weighted:       !!weighted,
                validators:     this._normalizeValidators(snapshot, weighted),
                preparePubkeys: weighted ? new Set() : null,
                commitPubkeys:  weighted ? new Set() : null
            };

            // Set cleanup timeout (follower proposals expire too)
            proposal.timer = setTimeout(() => {
                if (!proposal.resolved) {
                    proposal.resolved = true;
                    this.pendingProposals.delete(seq);
                }
            }, this.timeout * 2); // Followers wait longer; they don't report to a client

            this.pendingProposals.set(seq, proposal);
        }

        let proposal = this.pendingProposals.get(seq);

        // A pending proposal for this seq already exists with a different
        // digest (e.g. two leaders both emit PRE_PREPARE for the same seq
        // during a view transition). The incoming config is internally valid,
        // but our PREPARE/COMMIT vote-counting is keyed to proposal.digest, so
        // broadcasting PREPARE with the incoming digest would cast a vote we
        // can never commit and that peers will reject. Drop it.
        if (proposal.digest !== configDigest) {
            console.warn('PBFT: PRE_PREPARE seq ' + seq + ' digest conflicts with existing proposal; ignoring');
            return;
        }

        // Add proposer's implicit PREPARE
        proposal.prepares.add(envelope.sender);
        // Add our own PREPARE
        proposal.prepares.add(this.peerManager.validatorAddr);
        if (proposal.weighted) {
            let proposerPk = this._resolveSenderPubkey(envelope);
            if (proposerPk) proposal.preparePubkeys.add(proposerPk);
            this._addSelfPubkey(proposal.preparePubkeys);
        }

        // Broadcast PREPARE
        this.peerManager.broadcast(PBFT_PREPARE, Object.assign({
            seq:          seq,
            configDigest: configDigest
        }, this._equivVote(seq, proposal.view, proposal.digest, proposal.btcBlockHeight)));

        // Check quorum
        this._checkPrepareQuorum(seq);
    }

    // Handle PREPARE: collect votes and check quorum
    _handlePrepare(envelope) {
        let { seq, configDigest } = envelope.data;
        if (!seq || !configDigest) return;

        // Only count PREPARE votes from registered validators.
        if (!this._isKnownSender(envelope.sender)) return;

        let proposal = this.pendingProposals.get(seq);
        if (!proposal) return;

        // Verify digest matches
        if (configDigest !== proposal.digest) return;

        // Record the PREPARE vote
        proposal.prepares.add(envelope.sender);
        if (proposal.weighted && proposal.preparePubkeys) {
            let pk = this._resolveSenderPubkey(envelope);
            if (pk) proposal.preparePubkeys.add(pk);
        }

        // Check if we have enough PREPAREs to move to COMMIT
        this._checkPrepareQuorum(seq);
    }

    // Normalize a locked snapshot's validators into the source-keyed shape the
    // weighted predicate needs ([{pubkey:lower, source, weight}]); [] in count mode.
    _normalizeValidators(snapshot, weighted) {
        if (!weighted || !snapshot || !Array.isArray(snapshot.validators)) return [];
        return snapshot.validators.map(v => ({
            pubkey: String(v.pubkey).toLowerCase(),
            source: String(v.source != null ? v.source : ''),
            weight: String(v.weight != null ? v.weight : '0')
        }));
    }

    // Add this hub's own signing pubkey to a weighted vote set (no-op if the
    // identity isn't available yet, e.g. before the hub finishes initializing).
    _addSelfPubkey(pubkeySet) {
        if (!pubkeySet) return;
        let identity = this.hub.getIdentity && this.hub.getIdentity();
        if (identity) pubkeySet.add(identity.getPubkeyHex().toLowerCase());
    }

    // EQUIV durable canonical (WI-2 bump 2, the 6th engine, XCONFIG). Config-change
    // PBFT signs only the ephemeral transport envelope today; this adds a durable
    // per-validator signature over
    //   buildEquivCanonical('XCONFIG', seq, view, `${blockHeight}|${digest}`)
    // i.e. content = `<snapshot_block>|<config-digest>`. The snapshot_block (the round's
    // locked BTC tip, the whole-federation set that authorized this config slot) is carried
    // IN the signed content so a BTC indexer can recover the membership set from the proof
    // ALONE and slash a config equivocator (SLASH.md). It is constant for a (seq,view): every
    // PRE_PREPARE/PREPARE/COMMIT vote locks the same snapshot, and the digest-conflict guard
    // keeps an honest node from signing two configs for one slot, so the two header-identical,
    // SAME-snapshot_block, DIFFERENT-digest messages are the slashable artifact. blockHeight is
    // never null here (isEquivHeaderActive(null) is false => {} below). base-10 block + hex
    // digest are pipe-free, so the wire action splits cleanly. Carried as {equiv_sig,
    // equiv_pubkey} per vote, additive to the count + weighted tally, gated on tip + network.
    // Returns {} below the flag-day or when no identity is available (vote still counts).
    _equivVote(seq, view, digest, blockHeight) {
        if (!eq.isEquivHeaderActive(blockHeight, this.hub && this.hub.network)) return {};
        let identity = this.hub.getIdentity && this.hub.getIdentity();
        if (!identity) return {};
        let canonical = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, seq, view, String(blockHeight) + '|' + digest);
        return { equiv_sig: identity.sign(canonical), equiv_pubkey: identity.getPubkeyHex().toLowerCase() };
    }

    // Resolve a voting peer's signing pubkey from an authenticated envelope.
    // Prefer envelope.sig_pubkey (PeerManager already verified the envelope with
    // it), fall back to the addr->pubkey registry, else null. In the null case the
    // vote still counts in the address set and is only omitted from the weighted
    // stake tally (a known validator on a transient version mismatch; weighted
    // mode only activates post-flag-day when every hub stamps sig_pubkey).
    _resolveSenderPubkey(envelope) {
        if (envelope && envelope.sig_pubkey && typeof envelope.sig_pubkey === 'string')
            return envelope.sig_pubkey.toLowerCase();
        let registry = this.peerManager && this.peerManager.validatorPubkeys;
        if (registry && envelope) {
            let pk = registry.get(envelope.sender);
            if (pk) return String(pk).toLowerCase();
        }
        return null;
    }

    // Quorum predicate shared by PREPARE / COMMIT / VIEW_CHANGE. Under
    // STAKE_WEIGHTED_QUORUM: 3*sum(distinct-source signer weight) > 2*S over the
    // pubkeys that voted; below activation: the legacy 2f+1 count of the address
    // vote set against the round-locked quorum. `ctx` is a proposal (PREPARE/COMMIT)
    // or a {quorum, weighted, validators} view-change context.
    _quorumMet(ctx, addrSet, pubkeySet) {
        if (ctx.weighted)
            return swq.meetsStakeThreshold(ctx.validators, pubkeySet || new Set());
        let quorum = (typeof ctx.quorum === 'number') ? ctx.quorum : this._getQuorum();
        return addrSet.size >= quorum;
    }

    // Check if PREPARE quorum is reached -> broadcast COMMIT
    _checkPrepareQuorum(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (!proposal || proposal.resolved) return;

        // Use the round's locked quorum (federation snapshot at the BTC
        // block boundary), not a live recompute. This keeps every hub in
        // lockstep across the round. Weighted rounds tally signer stake.
        if (this._quorumMet(proposal, proposal.prepares, proposal.preparePubkeys)) {
            // Only broadcast COMMIT once
            if (!proposal._commitSent) {
                proposal._commitSent = true;

                // Add own COMMIT vote
                proposal.commits.add(this.peerManager.validatorAddr);
                if (proposal.weighted) this._addSelfPubkey(proposal.commitPubkeys);

                this.peerManager.broadcast(PBFT_COMMIT, Object.assign({
                    seq:          seq,
                    configDigest: proposal.digest
                }, this._equivVote(seq, proposal.view, proposal.digest, proposal.btcBlockHeight)));

                // Check if commit quorum is already met
                this._checkCommitQuorum(seq);
            }
        }
    }

    // Handle COMMIT: collect votes and check quorum
    _handleCommit(envelope) {
        let { seq, configDigest } = envelope.data;
        if (!seq || !configDigest) return;

        // Only count COMMIT votes from registered validators.
        if (!this._isKnownSender(envelope.sender)) return;

        let proposal = this.pendingProposals.get(seq);
        if (!proposal) return;

        // Verify digest matches
        if (configDigest !== proposal.digest) return;

        // Record the COMMIT vote
        proposal.commits.add(envelope.sender);
        if (proposal.weighted && proposal.commitPubkeys) {
            let pk = this._resolveSenderPubkey(envelope);
            if (pk) proposal.commitPubkeys.add(pk);
        }

        // Check if we have enough COMMITs to apply
        this._checkCommitQuorum(seq);
    }

    // Check if COMMIT quorum is reached -> apply the config
    _checkCommitQuorum(seq) {
        let proposal = this.pendingProposals.get(seq);
        if (!proposal || proposal.applied) return;

        // Same quorum rule as _checkPrepareQuorum; see _quorumMet.
        if (this._quorumMet(proposal, proposal.commits, proposal.commitPubkeys)) {
            proposal.applied = true;

            // Apply the config
            this._applyConfig(proposal.config).then(() => {
                // Update sequence in DB
                this._saveSeq(seq);
                if (seq > this.lastAppliedSeq) this.lastAppliedSeq = seq;

                // Resolve the proposer's promise (if we initiated)
                if (!proposal.resolved && proposal.resolve) {
                    proposal.resolved = true;
                    if (proposal.timer) clearTimeout(proposal.timer);
                    proposal.resolve(true);
                }

                // Track applied digest
                this.applied.add(proposal.digest);
                this.pendingProposals.delete(seq);

                console.log('PBFT: Config applied (seq ' + seq + ', ' +
                    proposal.prepares.size + ' prepares, ' +
                    proposal.commits.size + ' commits)');

            }).catch((err) => {
                console.error('PBFT: Error applying config (seq ' + seq + '):', err.message);
                if (!proposal.resolved && proposal.reject) {
                    proposal.resolved = true;
                    if (proposal.timer) clearTimeout(proposal.timer);
                    proposal.reject(err);
                }
                this.pendingProposals.delete(seq);
            });
        }
    }

    // Apply a config blob to the database
    async _applyConfig(config) {
        await this.hub.applyConfig(config);
    }

    // Handle VIEW_CHANGE: collect votes and promote new leader
    _handleViewChange(envelope) {
        let { view, seq } = envelope.data;
        if (typeof view !== 'number' || typeof seq !== 'number') return;

        // Only count VIEW_CHANGE votes from registered validators; view-change
        // quorum is the same Set.size tally as PREPARE/COMMIT.
        if (!this._isKnownSender(envelope.sender)) return;

        if (!this.pendingViewChanges.has(view)) {
            this.pendingViewChanges.set(view, new Set());
        }
        this.pendingViewChanges.get(view).add(envelope.sender);

        // Resolve the round-locked quorum CONTEXT (count vs stake), matching
        // _checkPrepareQuorum/_checkCommitQuorum so view-change acceptance can't
        // diverge from the rest of the round under validator churn. Followers
        // still hold the proposal; the node that initiated the view change
        // recovers the context from viewChangeQuorums (its proposal was removed by
        // the triggering timeout). A live count quorum is the last-resort fallback.
        let proposal = this.pendingProposals.get(seq);
        let vcCtx;
        if (proposal && typeof proposal.quorum === 'number') {
            vcCtx = { quorum: proposal.quorum, weighted: !!proposal.weighted, validators: proposal.validators || [] };
        } else if (this.viewChangeQuorums.has(seq)) {
            vcCtx = this.viewChangeQuorums.get(seq);
        } else {
            vcCtx = { quorum: this._getQuorum(), weighted: false, validators: [] };
        }
        if (vcCtx.quorum === 0) return;

        // Weighted rounds tally view-change votes by signer stake (parallel pubkey
        // set); the address set above stays authoritative for the count path.
        if (vcCtx.weighted) {
            if (!this.pendingViewChangePubkeys.has(view))
                this.pendingViewChangePubkeys.set(view, new Set());
            let pk = this._resolveSenderPubkey(envelope);
            if (pk) this.pendingViewChangePubkeys.get(view).add(pk);
        }

        if (this._quorumMet(vcCtx, this.pendingViewChanges.get(view), this.pendingViewChangePubkeys.get(view))) {
            // View change accepted; update view and check if we're the new leader
            this.view = view;
            let newLeader = this._getLeader(seq);
            if (newLeader && newLeader.addr === this.peerManager.validatorAddr) {
                console.log('PBFT: View change to view ' + view + '; this node is the new leader');
                this.peerManager.broadcast(PBFT_NEW_VIEW, { view: view, seq: seq });
            }
            this.pendingViewChanges.delete(view);
            this.pendingViewChangePubkeys.delete(view);
            this.viewChangeQuorums.delete(seq);

            // Prune sub-quorum entries for any view we've now advanced past.
            // A view-change round that never reached quorum (e.g. only one peer
            // timed out while the rest stayed healthy) otherwise leaves its Set
            // in pendingViewChanges forever; under a flapping network those
            // stale entries accumulate without bound. Views are monotonic, so
            // anything strictly below the new view can never gather more votes.
            // Mirrors the viewChangeQuorums prune in _initiateViewChange.
            for (let v of this.pendingViewChanges.keys()) {
                if (v < this.view) this.pendingViewChanges.delete(v);
            }
            for (let v of this.pendingViewChangePubkeys.keys()) {
                if (v < this.view) this.pendingViewChangePubkeys.delete(v);
            }
        }
    }

    // Handle NEW_VIEW: adopt a new leader's view, but only when the
    // announcement is authentic. Two guards close a liveness attack in which
    // any authenticated-but-not-leader validator could otherwise advance every
    // follower's view arbitrarily and thereby steer (seq + view) % N leader
    // election toward a node of its choosing (itself or a crashed peer):
    //
    //   1. Monotonicity: a NEW_VIEW may only move the view FORWARD, never
    //      rewind it to a lower view the announcer controls.
    //   2. Leader identity: the announcer must be the rotation-designated
    //      leader for the CLAIMED (seq, view), mirroring the isRealLeader
    //      check OracleConsensus applies to its PROPOSE handler. A Byzantine
    //      node can therefore only ever announce views in which it is already
    //      the legitimate leader; it can never point followers at another node.
    //
    // The 2f+1 VIEW_CHANGE quorum that authorizes the transition is enforced
    // on the broadcasting side (_handleViewChange emits NEW_VIEW only after
    // collecting quorum). NEW_VIEW envelopes carry no vote proofs, and a
    // lagging follower that missed the VIEW_CHANGE round legitimately relies on
    // the leader's announcement to catch up, so the quorum is not (and, given
    // the wire format, cannot be) re-verified here.
    _handleNewView(envelope) {
        let { view, seq } = envelope.data;
        if (typeof view !== 'number' || typeof seq !== 'number') return;

        // A NEW_VIEW must advance the view, never rewind it.
        if (view <= this.view) return;

        // Validate the announcer against the claimed view's designated leader.
        // (seq + view) % N matches _getLeader's rotation, evaluated at the
        // claimed view rather than the local one. With no validator set there
        // is no leader to validate against, so the announcement is rejected.
        let N = this.validatorSet.length;
        if (N === 0) return;
        let expectedLeader = this.validatorSet[(seq + view) % N];
        if (!expectedLeader || envelope.sender !== expectedLeader.addr) {
            console.warn('PBFT: Ignoring NEW_VIEW for view ' + view +
                ' from non-leader ' + envelope.sender);
            return;
        }

        this.view = view;
        console.log('PBFT: New view ' + view + ' announced by ' + envelope.sender);
    }

    // Initiate a view change (called when leader times out). The weighted context
    // (lockedWeighted + lockedValidators) is captured by the caller BEFORE the
    // proposal is deleted, so the stake-weighted view-change tally can run even
    // though the proposal is gone.
    _initiateViewChange(seq, lockedQuorum, lockedWeighted, lockedValidators) {
        this.view++;
        console.log('PBFT: Initiating view change to view ' + this.view + ' (seq ' + seq + ')');

        // Stash the round-locked quorum CONTEXT for this seq so _handleViewChange
        // tallies view-change votes against the proposal-creation snapshot. The
        // proposal is already gone from pendingProposals (the triggering timeout
        // removed it before calling us), so this is the only place the initiator
        // can recover it. Carries weighted + validators so the weighted tally can
        // resolve. Prune rounds already applied to keep the map bounded (seq is
        // monotonic, so applied seqs never recur).
        if (typeof lockedQuorum === 'number') {
            for (let s of this.viewChangeQuorums.keys()) {
                if (s <= this.lastAppliedSeq) this.viewChangeQuorums.delete(s);
            }
            this.viewChangeQuorums.set(seq, {
                quorum:     lockedQuorum,
                weighted:   !!lockedWeighted,
                validators: lockedValidators || []
            });
        }

        this.peerManager.broadcast(PBFT_VIEW_CHANGE, {
            view: this.view,
            seq:  seq
        });

        // Add own vote
        if (!this.pendingViewChanges.has(this.view)) {
            this.pendingViewChanges.set(this.view, new Set());
        }
        this.pendingViewChanges.get(this.view).add(this.peerManager.validatorAddr);
        if (lockedWeighted) {
            if (!this.pendingViewChangePubkeys.has(this.view))
                this.pendingViewChangePubkeys.set(this.view, new Set());
            this._addSelfPubkey(this.pendingViewChangePubkeys.get(this.view));
        }
    }

    // Get the leader for a given sequence number
    _getLeader(seq) {
        if (this.validatorSet.length === 0) return null;
        let idx = (seq + this.view) % this.validatorSet.length;
        return this.validatorSet[idx];
    }

    // Check if this node is the current leader for a given sequence
    _isLeader(seq) {
        let leader = this._getLeader(seq);
        return leader && leader.addr === this.peerManager.validatorAddr;
    }

    // Calculate quorum size: legacy live-set computation, used as a
    // fallback when a federation snapshot can't be acquired (no BTC tip
    // available, indexer unreachable, etc.). The normal path is:
    //   1. Leader calls _lockSnapshot() at PROPOSE -> snapshot at BTC tip.
    //   2. Leader stamps btcBlockHeight into the PRE_PREPARE envelope.
    //   3. Followers call _lockSnapshot(btcBlockHeight) -> same block, same
    //      validator set, same quorum.
    //   4. PREPARE/COMMIT checks use proposal.quorum (cached), not this.
    // Whole-federation snapshot (not capability-scoped) because config
    // changes affect every staker equally. See capability-staking-model.md §6.
    _getQuorum() {
        // Use validator set if available, otherwise fall back to live peer count
        let N;
        if (this.validatorSet.length > 0) {
            N = this.validatorSet.length;
        } else {
            if (!this.peerManager) return 0;
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1; // +1 for self
        }
        if (N <= 1) return 0;    // Single node; no consensus needed
        let f = Math.floor((N - 1) / 3);
        // Majority floor: bare 2f+1 degenerates to quorum=1 at N=3 (f=0),
        // letting a single validator finalize alone.
        return Math.max(2 * f + 1, Math.ceil((N + 1) / 2));
    }

    // Compute SHA-256 digest of a config object
    _digest(config) {
        let json = JSON.stringify(config);
        return crypto.createHash('sha256').update(json).digest('hex');
    }

    // Load sequence number from DB
    async _loadSeq() {
        try {
            let rows = await this.db.doQuery(
                "SELECT value FROM consensus_state WHERE key_name = ?",
                ['last_seq']
            );
            if (rows.length > 0) {
                this.seq = parseInt(rows[0].value) || 0;
                this.lastAppliedSeq = this.seq;
            }
        } catch (e) {
            console.error('Error loading consensus sequence:', e);
        }
    }

    // Save sequence number to DB
    async _saveSeq(seq) {
        try {
            await this.db.doQuery(
                "INSERT INTO consensus_state (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()",
                ['last_seq', String(seq), String(seq)]
            );
        } catch (e) {
            console.error('Error saving consensus sequence:', e);
        }
    }
}

module.exports = Consensus;
