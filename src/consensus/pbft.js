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
const swq    = require('../stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../lib/bft_quorum.js');
const { isAdmissibleSigner } = require('../lib/chain_signer_admission.js');
const { canonicalValidatorOrder } = require('../rollcall/validator_order.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

const { PBFT_PRE_PREPARE, PBFT_PREPARE, PBFT_COMMIT, PBFT_VIEW_CHANGE, PBFT_NEW_VIEW }
    = require('./pbft/message_types.js');

// One part per phase of a round, each an object of methods installed on
// Consensus.prototype below. The class file keeps the constructor, the lifecycle,
// the snapshot lock and the dispatch; a phase's handlers live in its own part.
const proposePart    = require('./pbft/propose.js');
const prePreparePart = require('./pbft/pre_prepare.js');
const votesPart      = require('./pbft/votes.js');
const leaderPart     = require('./pbft/leader.js');
const viewChangePart = require('./pbft/view_change.js');

const DEFAULT_TIMEOUT = 30000; // 30 seconds

// Follower freshness bound on the leader-stamped btcBlockHeight in a PRE_PREPARE.
// Same family and default as StateCheckpointEngine.cosignToleranceBlocks and
// CrossChainCallEngine's snapshot_block bound: about a day of BTC blocks.
const DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS = 144;

// The engine's three operator knobs, read once at construction. A function rather
// than constructor lines so the constructor stays inside the readability limit;
// every value and guard is the one the constructor applied before.
function resolveConsensusKnobs(self) {
    self.timeout       = parseInt(hubConfig.PBFT_TIMEOUT) || DEFAULT_TIMEOUT;
    self.minValidators = parseInt(hubConfig.MIN_VALIDATORS) || 1;
    // See DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS. 0 is meaningful (pin to our own
    // tip exactly), so this takes a non-negative guard rather than `|| default`.
    self.snapshotToleranceBlocks = parseInt(hubConfig.PBFT_SNAPSHOT_TOLERANCE_BLOCKS
        || String(DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS));
    if(!(self.snapshotToleranceBlocks >= 0))
        self.snapshotToleranceBlocks = DEFAULT_SNAPSHOT_TOLERANCE_BLOCKS;
}

class Consensus {

    constructor(hub) {
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.db          = hub.db;

        // Sequence counter (loaded from DB on start)
        this.seq = 0;

        // View number (incremented on leader failover, reset on successful consensus)
        this.view = 0;

        this.validatorSet = [];

        this.pendingProposals = new Map();

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

        // PREPARE/COMMIT votes that arrived for a seq this hub has not opened a
        // proposal for yet, replayed the moment it does. Insertion-ordered so
        // eviction is FIFO on the oldest seq key. The TTL is the round's own
        // timeout: a vote older than that can no longer influence the round it
        // votes on.
        this.earlyVotes    = new Map();   // seq -> [envelope]
        this.earlyVoteTtl  = new Map();   // seq -> expiresAt (ms)
        // Set to the seq being replayed so a vote that still finds no proposal
        // (an applied or expired round) cannot be buffered straight back.
        this._replayingSeq = null;

        // Double-apply of a committed round is prevented by three live guards, not
        // by a digest set: the monotonic `lastAppliedSeq` gate rejects a replayed
        // PRE_PREPARE for an already-applied seq, `proposal.applied` skips a late
        // COMMIT for a round this node already applied, and `proposal._applying`
        // closes the synchronous re-entrancy window while the async apply is in
        // flight. A prior `this.applied` digest Set was written but never read
        // (dead defense-in-depth); deleting it is behaviour-preserving. Note it
        // could NOT have been safely wired as a skip-guard anyway: a legitimate
        // A -> B -> A config revert reproduces an earlier round's digest at a new
        // seq, so a digest-keyed skip would drop the honest revert.
        this.pendingClientConfig = null;
        this._messageHandler = null;
        this.lastAppliedSeq = 0;

        resolveConsensusKnobs(this);
    }

    // Canonicalize the set's ORDER on the way in. Leader election is
    // `validatorSet[(seq + view) % N]`, so before this the cross-hub leader
    // agreement rested entirely on every hub's loader emitting identical
    // ordering for identical membership; two hubs ordering the same members
    // differently elect different leaders for the same (seq, view) and reject
    // each other's legitimate PRE_PREPARE. Quorum N is untouched (it depends
    // only on |set|). See validator_order.js for the ordering and for why this
    // ships ungated inside this pre-launch batch.
    //
    // A later change narrowed what this ordering still governs: a round that locks a
    // capability snapshot now elects from that snapshot's members instead, and
    // this order is the fallback rotation for rounds that have no snapshot. The
    // sort key is the same either way (lowercased pubkey ascending), so the two
    // rotations agree whenever the two populations do.
    setValidatorSet(validators) {
        this.validatorSet = canonicalValidatorOrder(validators);
    }

    // True when this hub is part of a real federation, which is what every
    // fail-closed guard below actually needs to know. MIN_VALIDATORS alone is
    // the wrong question: CONFIGURATION.md marks it optional and
    // .env.example ships it commented out, so it defaults to 1 and a normally
    // configured multi-hub deployment silently takes the single-node path, the
    // exact path those guards exist to keep it off. The live active set is
    // authoritative instead: XChainHub.propagateValidatorSet pushes in the
    // rows of `validators` WHERE status='active', so length > 1 means real
    // peers to diverge from regardless of what the operator declared. Strictly
    // widening: every case minValidators > 1 caught is still caught.
    isFederated() {
        return this.minValidators > 1 || this.validatorSet.length > 1;
    }

    // Fail-closed gate for multi-hub federations. A deterministic snapshot is a
    // real validator set locked from the indexer at the round's block boundary;
    // it is the only thing that guarantees every hub computes quorum over the
    // SAME set. A null snapshot (indexer down / timeout / 401-403 / malformed)
    // means each hub would otherwise fall back to its own LOCAL validatorSet,
    // and two hubs with different local sets could finalize the same round over
    // different N: a federation split. Used by both the leader (propose) and
    // follower (handlePrePrepare) paths so they refuse in lockstep.
    hasDeterministicSnapshot(snapshot) {
        return !!(snapshot && Array.isArray(snapshot.validators));
    }

    // True when a block-anchored snapshot was fetched but qualified ZERO
    // validators in a federation (isFederated). getQuorum(empty) = 0
    // collides with the genuine single-node bypass below; applying a config
    // change over an empty federation snapshot means every hub applies it with
    // NO quorum (a transient empty staker set is not a mandate). An empty
    // snapshot passes hasDeterministicSnapshot (it is a real, agreed-upon
    // empty set), so that gate alone does not catch this. Mirrors the
    // empty-snapshot guard already in CrossChainEngine / the DEX, and the
    // OracleConsensus fix. A null snapshot is a DIFFERENT case handled by
    // hasDeterministicSnapshot (fail closed for federations); this is only the
    // present-but-empty case.
    isEmptyFederationSnapshot(snapshot) {
        return this.isFederated() && !!snapshot &&
            Array.isArray(snapshot.validators) && snapshot.validators.length === 0;
    }

    async start() {
        await this.loadSeq();

        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        logger.info('Consensus engine started (seq: ' + this.seq + ')');
    }

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
        this.earlyVotes.clear();
        this.earlyVoteTtl.clear();
        this._replayingSeq = null;
    }

    // Acquire the federation validator-set snapshot at the current BTC tip.
    // Used by both the leader (in propose) and followers (in handlePrePrepare).
    // The leader stamps its tip into the PRE_PREPARE envelope so followers
    // call this with the matching blockIndex.
    // Returns { snapshot, weighted, requestedBlockIndex }. STAKE_WEIGHTED_QUORUM:
    // at/above the
    // activation block on this hub's network, lock the SOURCE-KEYED weight
    // snapshot (getActiveWeightSnapshot -> [{pubkey,source,weight}]) so quorum is
    // tallied by stake; below activation, the count snapshot (byte-identical to
    // the legacy path). `weighted` is gated on the BTC block boundary + network so
    // the hub and every other hub flip on the same anchor. Returns
    // { snapshot: null, weighted } when no snapshot can be acquired (the caller
    // then falls back to live getQuorum(), as before).
    //
    // `requestedBlockIndex` is the height this call ASKED for, before
    // CapabilitySnapshot buried it by HUB_SNAPSHOT_REORG_BUFFER; the returned
    // snapshot's own `blockIndex` is the buried height it resolved at. The two
    // are not interchangeable and the leader must stamp the requested one (see
    // the PRE_PREPARE stamp in propose()).
    async lockSnapshot(blockHeightOverride) {
        if (!this.hub || !this.hub.capabilitySnapshot) {
            return { snapshot: null, weighted: false, requestedBlockIndex: null };
        }
        let blockHeight = blockHeightOverride;
        if (blockHeight === undefined || blockHeight === null) {
            // resolveBtcLatestBlock checks hub.db.getChainTip first, then
            // falls back to a direct getlatestblock call against the BTC
            // indexer. So this works whether or not chain-tip-push is wired.
            blockHeight = await this.hub.resolveBtcLatestBlock();
        }
        if (!blockHeight) return { snapshot: null, weighted: false, requestedBlockIndex: null };
        let weighted = swq.isStakeWeightedQuorumActive(blockHeight, this.hub.network);
        let snapshot = weighted
            ? await this.hub.capabilitySnapshot.getActiveWeightSnapshot(blockHeight)
            : await this.hub.capabilitySnapshot.getActiveValidatorSnapshot(blockHeight);
        return { snapshot: snapshot, weighted: weighted, requestedBlockIndex: blockHeight };
    }

    // Whether an authenticated envelope may be counted toward config-PBFT quorum.
    // Admits on the PROVEN signing key (chain-effective set OR registry), never on
    // envelope.sender. Quorum N here comes from the on-chain federation snapshot,
    // so admitting by address stranded every staked joiner in the denominator.
    // Shared definition and the full security argument in
    // lib/chain_signer_admission.js.
    _isKnownSender(envelope) {
        return isAdmissibleSigner(this.peerManager, envelope);
    }

    _handleMessage(envelope) {
        switch (envelope.type) {
            case PBFT_PRE_PREPARE:
                // handlePrePrepare is async because it locks the validator-set
                // snapshot at the leader-stamped block boundary via an indexer
                // call. Errors are caught and logged; they never bubble up to
                // the gossip layer.
                this.handlePrePrepare(envelope).catch(err =>
                    logger.error(nodeUtil.format('Consensus: PRE_PREPARE handler error for seq %s:',
                        (envelope && envelope.data && envelope.data.seq),
                        err && err.message ? err.message : err)));
                break;
            case PBFT_PREPARE:     this.handlePrepare(envelope);    break;
            case PBFT_COMMIT:      this._handleCommit(envelope);     break;
            case PBFT_VIEW_CHANGE: this.handleViewChange(envelope); break;
            case PBFT_NEW_VIEW:    this.handleNewView(envelope);    break;
        }
    }

    async applyConfig(config) {
        await this.hub.applyConfig(config);
    }

    // Calculate quorum size: legacy live-set computation, used as a
    // fallback when a federation snapshot can't be acquired (no BTC tip
    // available, indexer unreachable, etc.). The normal path is:
    //   1. Leader calls lockSnapshot() at PROPOSE -> snapshot at the BTC tip,
    //      buried by HUB_SNAPSHOT_REORG_BUFFER inside CapabilitySnapshot.
    //   2. Leader stamps the REQUESTED tip (not the buried snapshot.blockIndex)
    //      into the PRE_PREPARE envelope.
    //   3. Followers call lockSnapshot(btcBlockHeight), which buries that tip
    //      once exactly as the leader did -> same block, same validator set,
    //      same quorum.
    //   4. PREPARE/COMMIT checks use proposal.quorum (cached), not this.
    // Whole-federation snapshot (not capability-scoped) because config
    // changes affect every staker equally. See capability-staking-model.md §6.
    getQuorum() {
        // Use validator set if available, otherwise fall back to live peer count
        let N;
        if (this.validatorSet.length > 0) {
            N = this.validatorSet.length;
        } else {
            if (!this.peerManager) return 0;
            let peers = this.peerManager.getPeerStatus().filter(p => p.state === 'open');
            N = peers.length + 1; // +1 for self
        }
        // N<=1: single node, no consensus needed (0 = caller bypasses). Above
        // that, the majority-floored BFT threshold (bft_quorum.js).
        return bftQuorumOrSingle(N, 0);
    }

    _digest(config) {
        let json = JSON.stringify(config);
        return crypto.createHash('sha256').update(json).digest('hex');
    }

    async loadSeq() {
        try {
            let rows = await this.db.findConsensusState('last_seq');
            if (rows.length > 0) {
                this.seq = parseInt(rows[0].value) || 0;
                this.lastAppliedSeq = this.seq;
            }
        } catch (e) {
            // Fail CLOSED, mirroring saveSeq: a swallowed read fault left
            // this.seq/lastAppliedSeq at their constructor 0, so the stale-seq
            // replay guard in handlePrePrepare (`seq <= this.lastAppliedSeq`)
            // no longer rejected an already-applied seq and the node could not
            // tell a genuine fresh install from an unreadable persisted seq.
            // Rethrow so start() aborts rather than participate with the guard
            // reset to 0. A true fresh install reads zero rows, not an error.
            logger.error(nodeUtil.format('Error loading consensus sequence:', e));
            throw e;
        }
    }

    async saveSeq(seq) {
        try {
            await this.db.setConsensusState('last_seq', String(seq), String(seq));
        } catch (e) {
            logger.error(nodeUtil.format('Error saving consensus sequence:', e));
            throw e;   // surface so checkCommitQuorum rejects rather than diverging
        }
    }
}

// The parts go on with enumerable false, NOT Object.assign, for the reason
// src/db/index.js gives at its own install: class methods are non-enumerable, so
// assigned members would be the only ones for...in and Object.keys(prototype) can
// see, which changes what the prototype enumerates. writable and configurable stay
// true so a test can still stub and restore a moved method. A name claimed twice
// throws here rather than silently letting one part shadow another.
function installParts(target, parts) {
    for(const part of parts) {
        const descriptors = {};
        for(const name of Object.keys(part)) {
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate consensus method: ' + name + ' is already defined on ' +
                    'Consensus.prototype. Two pbft parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(Consensus.prototype, [proposePart, prePreparePart, votesPart, leaderPart, viewChangePart]);

module.exports = Consensus;
