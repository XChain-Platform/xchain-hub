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
 * XChain Hub - PBFT Consensus Engine: leader proposal
 *
 * The leader side of a config-change round: lock the snapshot, elect from it,
 * open the proposal and broadcast PRE_PREPARE.
 *
 * src/consensus/pbft.js installs every method below on Consensus.prototype,
 * non-enumerable like the class's own methods, so callers, stubs and the e2e
 * harness keep reaching them as consensus.<method>().
 *
 ********************************************************************/

'use strict';

const { PBFT_PRE_PREPARE } = require('./message_types.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The round's quorum mode and size from the locked snapshot, with the guards
// propose() applies between the snapshot lock and the leader election. It is
// synchronous on purpose: both of propose()'s awaits (the snapshot lock and the
// single-node apply) stay in propose() itself, so no extra microtask turn sits in
// front of PRE_PREPARE, where queued gossip could interleave with the round
// opening. Returns { applyDirect: true } for the single-node path, whose apply
// propose() awaits.
function proposeRoundQuorum(self, snapshot, weighted) {
    // Federation-split guard (fail closed). In a multi-hub federation, a null
    // snapshot means each hub would fall back to its own LOCAL validatorSet,
    // so two hubs could finalize the same config-change round over different
    // sets. Refuse to propose rather than split. Genuine single-host hubs
    // (not isFederated) have no peer to diverge from, so they keep the
    // existing fallback/single-node path below.
    if (self.isFederated() && !self.hasDeterministicSnapshot(snapshot)) {
        throw new Error('Consensus: refusing to PROPOSE config change without a deterministic ' +
            'validator snapshot (federated hub); indexer capability snapshot unavailable');
    }
    // Fall back to count mode when weighted is requested but no snapshot is
    // available (BTC indexer unreachable). An empty validator list makes
    // meetsStakeThreshold always false, stalling the round permanently.
    if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
        logger.warn('Consensus: weighted mode requested but snapshot unavailable; falling back to count mode for this round');
        weighted = false;
    }
    let quorum = snapshot
        ? self.hub.capabilitySnapshot.getQuorum(snapshot)
        : self.getQuorum();

    // Single-node fallback: no peers connected -> apply directly. But a
    // present-but-empty federation snapshot also yields quorum 0; applying
    // unilaterally there would let every hub commit a config change no quorum
    // ratified. Refuse and retry when the snapshot populates (leader twin of
    // the follower decline below).
    if (quorum === 0) {
        if (self.isEmptyFederationSnapshot(snapshot)) {
            throw new Error('Consensus: refusing to apply config change unilaterally over an EMPTY ' +
                'active-validator snapshot (block ' + snapshot.blockIndex + ', federated hub); ' +
                'will retry when the snapshot populates');
        }
        if (self.minValidators > 1) {
            logger.warn('Consensus: operating in single-node mode (MIN_VALIDATORS=' + self.minValidators + ' but quorum is 0)');
        }
        return { applyDirect: true };
    }
    return { weighted, quorum };
}

// The leader's round record. Built here rather than inline so the executor below
// stays inside the readability limit; every field is the one propose() set.
function buildLeaderProposal(self, ctx, resolve, reject) {
    let { config, snapshot, quorum, weighted, requestedBlockIndex, memberPubkeys } = ctx;
    return {
        config:   config,
        digest:   ctx.digest,
        view:     self.view,    // EQUIV: all 3 votes for this round sign (seq, view, digest)
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
        // The REQUESTED tip, never snapshot.blockIndex. The
        // snapshot is already buried by HUB_SNAPSHOT_REORG_BUFFER, and a
        // follower buries whatever this envelope carries a second time,
        // so stamping the buried value locks followers at tip - 2*buffer
        // while the leader sits at tip - buffer. Different validator
        // sets, one round: quorum splits or stalls whenever the set
        // changed across that window.
        btcBlockHeight: snapshot ? requestedBlockIndex : null,
        // STAKE_WEIGHTED_QUORUM round? Carry the source-keyed validator
        // weights + parallel pubkey vote sets (the address Sets above stay
        // authoritative for the count path; these are consulted only when
        // weighted). One vote per staking source (DELEGATE v0 is additive).
        weighted:       !!weighted,
        validators:     self.normalizeValidators(snapshot, weighted),
        // The round's pinned leader-election population, carried
        // so every later leader question for this seq (view change, a
        // repeat PRE_PREPARE, NEW_VIEW) is answered from the set the
        // round was opened over rather than from the live peer set.
        memberPubkeys:  memberPubkeys || null,
        // Always allocated, in BOTH quorum modes. The count path tallies these
        // keys (see quorumMet): a sender addr is a self-asserted wire field, so
        // counting addrs let ONE authorized key forge a full quorum by naming N
        // of them, and left a chain-attributed validator uncountable because it
        // has no registry addr at all.
        preparePubkeys: new Set(),
        commitPubkeys:  new Set()
    };
}

module.exports = {

    // Propose a config change. Returns a Promise that resolves when consensus is reached.
    async propose(config) {
        // Lock the validator-set snapshot at the current BTC chain tip so
        // every hub in the federation computes the same quorum for this
        // config-change round. Whole-federation snapshot (not capability-
        // scoped) because config changes affect every staker equally.
        // Falls back to live getQuorum() when the indexer or BTC tip
        // can't be resolved (graceful degradation; same behavior as before
        // the snapshot wiring landed).
        let { snapshot, weighted, requestedBlockIndex } = await this.lockSnapshot();
        let round = proposeRoundQuorum(this, snapshot, weighted);
        if (round.applyDirect) {
            await this.applyConfig(config);
            return true;
        }
        let quorum = round.quorum;
        weighted = round.weighted;

        // Elect the leader from the SAME population this round's quorum
        // was sized from. Everything below the quorum line is snapshot-pinned
        // (getQuorum(snapshot), proposal.validators, the weighted tally), and
        // leader election is too: indexing the LIVE validatorSet lets a hub whose
        // local peer set has drifted from the block-locked staker set elect a
        // different leader for the same seq and reject the legitimate
        // PRE_PREPARE. Same shape as the already-hardened
        // OracleConsensus._getLeader: sorted member pubkeys, index by
        // rotation, resolve the addr locally. Null memberPubkeys (no usable
        // snapshot, i.e. the single-node / graceful-degradation path) keeps the
        // legacy live-set rotation.
        let memberPubkeys = this.memberPubkeySet(snapshot);
        // The proposal slot. Two rules keep the rotation live:
        //  1. Start past lastAppliedSeq, not just this.seq. Rounds applied as
        //     a follower advance lastAppliedSeq only, so a hub that has mostly
        //     followed would otherwise propose a seq every peer rejects as
        //     stale, with a leader resolved from that dead slot.
        //  2. Consume the slot even when the leader check refuses (the
        //     `this.seq = nextSeq` in BOTH branches below). If a refusal left
        //     this.seq untouched, every retry would resolve the SAME
        //     (seq, view) and elect the SAME leader: a hub that is not the
        //     rotation leader for that one slot could never propose again, no
        //     matter how often it tried (a permanent livelock, armed the moment
        //     the federation set becomes non-trivial). Consuming the slot moves
        //     each attempt one rotation step forward, so within |members|
        //     attempts the rotation reaches this hub. Skipped seqs are safe:
        //     followers accept any seq above lastAppliedSeq, and the follower
        //     identity guard evaluates the rotation at the CLAIMED seq.
        let nextSeq = Math.max(this.seq, this.lastAppliedSeq) + 1;
        let leader = this._getLeader(nextSeq, memberPubkeys);
        if (leader && !this.isLeaderIdentity(leader, this.peerManager.validatorAddr, this.selfPubkey())) {
            this.seq = nextSeq;
            throw new Error('Not the leader for seq ' + nextSeq + ' (leader: ' +
                (leader.addr || leader.pubkey) + ')');
        }

        this.seq = nextSeq;
        let seq = this.seq;
        this.view = 0; // Reset view on new proposal
        let digest = this._digest(config);
        return openLeaderRound(this,
            { config, seq, digest, snapshot, quorum, weighted, requestedBlockIndex, memberPubkeys });
    }
};

// Open the round: record the proposal, arm the timeout that turns a silent round
// into a view change, and broadcast PRE_PREPARE. The promise it returns is the one
// propose() hands its caller, resolved by the apply that follows commit quorum.
function openLeaderRound(self, ctx) {
    let { config, seq, digest, quorum } = ctx;
    return new Promise((resolve, reject) => {
        let proposal = buildLeaderProposal(self, ctx, resolve, reject);

        proposal.prepares.add(self.peerManager.validatorAddr);
        self.addSelfPubkey(proposal.preparePubkeys);

        self.pendingProposals.set(seq, proposal);

        // Set timeout; triggers view change on failure
        proposal.timer = setTimeout(() => {
            if (!proposal.resolved) {
                proposal.resolved = true;
                self.pendingProposals.delete(seq);
                // Initiate view change so a new leader can take over.
                // Pass the round-locked quorum + weighted context so the
                // view-change vote tally uses the same rule (count or stake)
                // this proposal round used, even though we've just removed the
                // proposal from the map. Captured here, before deletion.
                self.initiateViewChange(seq, proposal.quorum, proposal.weighted, proposal.validators,
                    proposal.memberPubkeys);
                reject(new Error('Consensus timeout for seq ' + seq + ' (received ' +
                    proposal.prepares.size + ' prepares, ' + proposal.commits.size + ' commits, need ' + quorum + ')'));
            }
        }, self.timeout);

        // Broadcast PRE_PREPARE with the full config + the BTC block
        // height the leader snapshotted at, so followers can resolve the
        // same validator set at the same block boundary. `weighted` is a
        // hint only; followers re-derive it from the block height + network.
        self.peerManager.broadcast(PBFT_PRE_PREPARE, Object.assign({
            seq:            seq,
            view:           self.view,
            configDigest:   digest,
            config:         config,
            btcBlockHeight: proposal.btcBlockHeight,
            weighted:       proposal.weighted
        }, self.equivVote(seq, self.view, digest, proposal.btcBlockHeight)));

        // Check if we already have quorum (unlikely but handles edge case)
        self.checkPrepareQuorum(seq);
    });
}
