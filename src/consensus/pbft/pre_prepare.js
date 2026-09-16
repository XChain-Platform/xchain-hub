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
 * XChain Hub - PBFT Consensus Engine: follower PRE_PREPARE
 *
 * The follower side of a round opening: admit the PRE_PREPARE, bound and lock
 * the leader-stamped snapshot, check the leader's identity, then PREPARE.
 *
 * src/consensus/pbft.js installs every method below on Consensus.prototype,
 * non-enumerable like the class's own methods, so callers, stubs and the e2e
 * harness keep reaching them as consensus.<method>().
 *
 ********************************************************************/

'use strict';

const { PBFT_PREPARE } = require('./message_types.js');
const { noteDrop } = require('../diagnostics');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Everything a PRE_PREPARE must clear before this hub spends an indexer trip on
// it: shape, a registered sender, a stamped view, a live seq and a digest that
// matches the carried config. False means the envelope has been dropped.
function prePrepareAdmissible(self, envelope, seq, view, config, configDigest) {
    if (!seq || !configDigest || !config) return false;
    if (typeof seq !== 'number' || seq <= 0) return false;

    // Discard proposals from senders that are not registered validators
    // before doing any snapshot/indexer work for them.
    if (!self.isKnownSender(envelope)) {
        noteDrop({ reason: 'unknown_sender', phase: 'preprepare', sender: envelope.sender, envelope });
        return false;
    }

    // The leader stamps its view into the envelope so the identity guard
    // below can evaluate the rotation at the CLAIMED (seq, view). A viewless
    // envelope cannot be identity-checked at all, so it is dropped here,
    // still before any snapshot/indexer work.
    if (typeof view !== 'number') {
        logger.warn('PBFT: Rejecting PRE_PREPARE with no view from ' + envelope.sender + ' (seq ' + seq + ')');
        return false;
    }

    // Reject stale/replayed sequence numbers
    if (seq <= self.lastAppliedSeq) {
        logger.warn('Consensus: Rejecting PRE_PREPARE with stale seq ' + seq + ' (last applied: ' + self.lastAppliedSeq + ')');
        return false;
    }

    let computedDigest = self.digest(config);
    if (computedDigest !== configDigest) {
        logger.warn('PBFT: PRE_PREPARE digest mismatch from ' + envelope.sender + ' (seq ' + seq + ')');
        return false;
    }
    return true;
}

// Fail closed on a missing/invalid BTC block height, mirroring the
// OracleConsensus PROPOSE guard. The leader stamped the block
// it locked its snapshot at into the PRE_PREPARE; if that height is
// absent or not a positive integer (old peer mid rolling deploy, or a
// malformed/Byzantine envelope), lockSnapshot would silently resolve
// THIS follower's own BTC tip and lock a DIFFERENT validator/weight
// set (and possibly a different STAKE_WEIGHTED_QUORUM activation
// outcome) than the leader for the same seq. On a federated hub
// (isFederated) decline to PREPARE rather than pin to a
// local-tip snapshot. A truthy garbage height is caught downstream by
// CapabilitySnapshot.blockEchoOk; only the null/omitted case reaches
// the own-tip fallback, so this closes that specific hole. Genuine
// single-node / regtest hubs keep the local-tip fallback.
function stampedHeightUsable(self, seq, envelope, btcBlockHeight) {
    if (self.isFederated() && (!Number.isInteger(btcBlockHeight) || btcBlockHeight <= 0)) {
        logger.warn('Consensus: declining to PREPARE for seq ' + seq +
            ' from ' + envelope.sender + ': PRE_PREPARE carries no valid btcBlockHeight ' +
            '(federated hub); refusing to pin the validator snapshot at the local BTC tip, ' +
            'which would diverge from the leader\'s snapshot for this seq.');
        return false;
    }
    return true;
}

// Freshness bound (fail closed), the missing half of the guard above.
// The comment there says a truthy garbage height is caught downstream by
// CapabilitySnapshot.blockEchoOk, and that holds only for heights the
// indexer REFUSES: _blockEchoOk rejects a mismatched echo, and the indexer
// fail-closes only above its own tip, so an ancient but INDEXED height
// echoes back clean and yields a perfectly valid snapshot. That lets a
// Byzantine leader grind the height until it finds a block where the
// active set was small (quorum N), where it is itself the
// (seq + view) % N leader that leaderIdentityOk then validates against
// its OWN choice, or where STAKE_WEIGHTED_QUORUM had not yet activated
// (a silent downgrade to count quorum). Bound the raw wire height against
// our own resolved tip before any of those three consume it, and decline
// when we cannot resolve a tip of our own. Same shape and tolerance as
// StateCheckpointEngine's co-sign guard and CrossChainCallEngine's
// snapshot_block bound. The reorg buffer needs no adjustment: it is
// applied identically on both sides, so the bound belongs on the wire value.
// `myTip` is resolved by the caller, which owns the indexer round trip.
function tipBoundOk(self, seq, envelope, btcBlockHeight, myTip) {
    if (!Number.isFinite(Number(myTip))) {
        logger.warn('Consensus: declining to PREPARE for seq ' + seq +
            ' from ' + envelope.sender + ': cannot resolve our own BTC tip to bound the ' +
            'leader-stamped snapshot height (federated hub).');
        return false;
    }
    if (Math.abs(Number(myTip) - Number(btcBlockHeight)) > self.snapshotToleranceBlocks) {
        logger.warn('Consensus: declining to PREPARE for seq ' + seq +
            ' from ' + envelope.sender + ': PRE_PREPARE btcBlockHeight ' + btcBlockHeight +
            ' deviates from our own BTC tip ' + myTip + ' by more than ' +
            self.snapshotToleranceBlocks + ' blocks (federated hub); a stale height would ' +
            'let the proposer select the validator set, the leader and the quorum mode.');
        return false;
    }
    return true;
}

// The locked snapshot's quorum mode and size, with the three refusals the
// follower shares with propose(): no deterministic snapshot, an empty federation
// snapshot, and a PRE_PREPARE from a node the round's population does not elect.
// Null means this hub opens no round for the seq.
function followerRoundQuorum(self, ctx) {
    let { seq, view, envelope, snapshot, weighted, btcBlockHeight } = ctx;
    // Federation-split guard (fail closed), the follower twin of the
    // propose() gate. On a federated hub, declining to PREPARE when
    // no deterministic snapshot is available keeps this hub from voting
    // over its own LOCAL validatorSet while the leader (and peers) used a
    // different set. We create no proposal and emit no PREPARE; the round
    // either reaches quorum without us or times out into view change.
    if (self.isFederated() && !self.hasDeterministicSnapshot(snapshot)) {
        logger.warn('Consensus: declining to PREPARE for seq ' + seq +
            ' without a deterministic validator snapshot (federated hub); ' +
            'indexer capability snapshot unavailable');
        return null;
    }
    // Fall back to count mode when weighted but snapshot is unavailable,
    // matching the same guard in propose(). Without this, a follower
    // that can't reach its BTC indexer enters PBFT with validators=[]
    // and weighted=true, making meetsStakeThreshold always false and
    // stalling view-change recovery as well.
    if (weighted && (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)) {
        logger.warn('Consensus: follower weighted mode requested but snapshot unavailable; falling back to count mode');
        weighted = false;
    }
    let quorum = snapshot
        ? self.hub.capabilitySnapshot.getQuorum(snapshot)
        : self.getQuorum();

    // Decline to PREPARE over an empty federation snapshot: quorum would be
    // 0 and the count-mode quorum check (`size >= 0`) would let a single
    // PREPARE finalize, applying a config change no quorum ratified. A
    // legitimate leader refuses to propose such a round, so a PRE_PREPARE for
    // one is spurious; create no proposal and let it time out into view
    // change (follower twin of the propose() refusal above).
    if (self.isEmptyFederationSnapshot(snapshot)) {
        logger.warn('Consensus: declining to PREPARE for seq ' + seq +
            ' over an EMPTY active-validator snapshot (block ' + btcBlockHeight +
            ', federated hub); a legitimate leader skips such a round.');
        return null;
    }

    // Leader-identity guard: run it against the
    // population the round is actually being opened over, which only
    // exists once the snapshot is locked. It must still run BEFORE the
    // follower proposal is created, or an authenticated non-leader could
    // seed a proposal for an uncontested seq and drive every follower to
    // PREPARE/COMMIT its config.
    if (!self.leaderIdentityOk(seq, view, envelope, self.memberPubkeySet(snapshot))) return null;
    return { quorum, weighted };
}

// Create a follower proposal (no resolve/reject; we didn't initiate it), with the
// expiry that clears a round this hub never sees finalized.
function openFollowerRound(self, ctx) {
    let { seq, view, config, configDigest, snapshot, weighted, quorum, btcBlockHeight } = ctx;
    let proposal = {
        config:   config,
        digest:   configDigest,
        view:     view,         // EQUIV: the leader's view, stamped in the PRE_PREPARE
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
        validators:     self.normalizeValidators(snapshot, weighted),
        memberPubkeys:  self.memberPubkeySet(snapshot),
        preparePubkeys: new Set(),
        commitPubkeys:  new Set()
    };

    // Set cleanup timeout (follower proposals expire too)
    proposal.timer = setTimeout(() => {
        if (!proposal.resolved) {
            proposal.resolved = true;
            self.pendingProposals.delete(seq);
        }
    }, self.timeout * 2); // Followers wait longer; they don't report to a client

    self.pendingProposals.set(seq, proposal);
}

// Vote on the open round: refuse a digest that conflicts with the one this hub is
// counting, then PREPARE and drain anything that voted while the lock was in flight.
function castPrepare(self, envelope, seq, configDigest) {
    let proposal = self.pendingProposals.get(seq);

    // A pending proposal for this seq already exists with a different
    // digest (e.g. two leaders both emit PRE_PREPARE for the same seq
    // during a view transition). The incoming config is internally valid,
    // but our PREPARE/COMMIT vote-counting is keyed to proposal.digest, so
    // broadcasting PREPARE with the incoming digest would cast a vote we
    // can never commit and that peers will reject. Drop it.
    if (proposal.digest !== configDigest) {
        logger.warn('PBFT: PRE_PREPARE seq ' + seq + ' digest conflicts with existing proposal; ignoring');
        return;
    }

    proposal.prepares.add(envelope.sender);
    proposal.prepares.add(self.peerManager.validatorAddr);
    let proposerPk = self.resolveSenderPubkey(envelope);
    if (proposerPk) proposal.preparePubkeys.add(proposerPk);
    self.addSelfPubkey(proposal.preparePubkeys);

    self.peerManager.broadcast(PBFT_PREPARE, Object.assign({
        seq:          seq,
        configDigest: configDigest
    }, self.equivVote(seq, proposal.view, proposal.digest, proposal.btcBlockHeight)));

    self.checkPrepareQuorum(seq);

    // Now that the round is open locally, deliver anything that voted on it
    // while the snapshot lock was still in flight. Without this the leader's
    // own COMMIT can be lost for good and this hub never applies a config the
    // federation finalized.
    self.replayEarlyVotes(seq);
}

module.exports = {

    async handlePrePrepare(envelope) {
        let { seq, view, configDigest, config, btcBlockHeight } = envelope.data;

        if (!prePrepareAdmissible(this, envelope, seq, view, config, configDigest)) return;

        if (!this.pendingProposals.has(seq)) {
            if (!stampedHeightUsable(this, seq, envelope, btcBlockHeight)) return;
            if (this.isFederated()) {
                let myTip = this.hub && this.hub.resolveBtcLatestBlock
                    ? await this.hub.resolveBtcLatestBlock()
                    : null;
                if (!tipBoundOk(this, seq, envelope, btcBlockHeight, myTip)) return;
            }
            // Lock the federation validator-set snapshot at the SAME block
            // the leader snapshotted at (stamped into the PRE_PREPARE
            // envelope). Follower quorum-checks use proposal.quorum, so we
            // stay in lockstep with the leader for the whole round.
            let { snapshot, weighted } = await this.lockSnapshot(btcBlockHeight);
            let round = followerRoundQuorum(this, { seq, view, envelope, snapshot, weighted, btcBlockHeight });
            if (!round) return;
            openFollowerRound(this, { seq, view, config, configDigest, snapshot,
                weighted: round.weighted, quorum: round.quorum, btcBlockHeight });
        } else if (!this.leaderIdentityOk(seq, view, envelope,
                this.pendingProposals.get(seq).memberPubkeys)) {
            // Repeat PRE_PREPARE for a seq this hub already opened: re-run the
            // same guard against the population that round was opened over, so
            // the check is never skipped and never costs a second indexer trip.
            return;
        }

        castPrepare(this, envelope, seq, configDigest);
    }
};
