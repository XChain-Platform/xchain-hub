/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Reorg handler - the PREPARE/COMMIT round
 *
 * Joining, opening and finishing a reorg consensus round. Every path that creates a
 * round has verified the reorg against our own node first, and the quorum is locked
 * when the round opens.
 *
 ********************************************************************/

'use strict';

const { noteDrop } = require('../../consensus/diagnostics');
const { isAdmissibleSigner } = require('../../lib/chain_signer_admission.js');
const nodeUtil = require('node:util');
const { XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT } = require('./message_types.js');
const snapshotRoundMethods = require('./snapshot_round.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

function armLeaderTimeout(self, reorgId, pending) {
    pending.timer = setTimeout(() => {
        if (pending.finalized) return;
        logger.warn('Reorg: Consensus timeout for ' + reorgId);
        self.emit('reorg:timeout', {
            reorgId,
            sourceChain:    pending.chain,
            reorgHeight:    pending.reorgHeight,
            timestamp:      pending.timestamp,
            affectedChains: pending.affectedChains,
            prepares:       self.reorgVoteCount(pending, 'prepare'),
            commits:        self.reorgVoteCount(pending, 'commit'),
            quorum:         pending.quorum
        });
        self.pendingReorgs.delete(reorgId);
    }, self.timeout);
}

async function openRoundFromPrepare(self, envelope, fields, auth) {
    let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
        oldHash, newHash, btcBlockHeight } = fields;
    if (self.processed.has(reorgId)) return false;
    if (self.pendingReorgs.size >= self.maxPendingReorgs) return false;

    let snapshotContext = await self.lockReorgFederationSnapshot(btcBlockHeight, true);
    if (snapshotContext.refused) return false;
    let expectedDigest = self.reorgRoundDigest(reorgId, chain, reorgHeight, timestamp,
        oldHash, newHash, snapshotContext.active ? snapshotContext.btcBlockHeight : null);
    if (digest !== expectedDigest) return false;
    if (snapshotContext.active) {
        let senderPubkey = self.resolveReorgSenderPubkey(envelope);
        if (!auth.pubkeyKnown || !senderPubkey || !snapshotContext.members.has(senderPubkey)) return false;
    } else if (!auth.legacyKnown) {
        return false;
    }

    let verified = await self.verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash);
    if (!verified) return false;
    let observedBlockTimeMs = Number.isFinite(verified.blockTimeMs) ? verified.blockTimeMs : null;
    if (!self.timestampConsistentWithBlockTime(timestamp, observedBlockTimeMs)) return false;
    if (!self.pendingReorgs.has(reorgId)) {
        self.openFollowerRound({ reorgId, chain, reorgHeight, timestamp, affectedChains,
            digest, oldHash, newHash, observedBlockTimeMs, snapshotContext });
    }
    return true;
}

module.exports = {

    async handleAlert(envelope) {
        let legacyKnown = this.isKnownSender(envelope.sender);
        let pubkeyKnown = isAdmissibleSigner(this.peerManager, envelope);
        if (!legacyKnown && !pubkeyKnown) {
            noteDrop({ reason: 'unknown_sender', phase: 'reorg_alert', sender: envelope.sender, envelope });
            return;
        }
        let { chain, reorgHeight, timestamp, reorgId, oldHash, newHash, btcBlockHeight } = envelope.data;
        if (!chain || !reorgHeight || !timestamp || !reorgId) return;
        // Bind reorgId to its canonical (chain:reorgHeight:timestamp) form so one valid
        // observation cannot spawn unlimited distinct rounds (REORG-INBOUND-UNBOUNDED-ROUNDS-1):
        // the self-verify in-flight key excludes reorgId/timestamp, so without this a Byzantine
        // validator could re-broadcast the same real (height,newHash) under endless reorgId
        // strings, each creating a fresh round + PREPARE fan-out. Honest reporters always send
        // this exact form (reportReorg), so legitimate ALERTs are unaffected.
        if (reorgId !== this.canonicalReorgId(chain, reorgHeight, timestamp)) return;
        if (this.processed.has(reorgId)) return;
        if (this.pendingReorgs.has(reorgId)) return;
        // Abstain when already at the concurrent-round cap (a later ALERT retries).
        if (this.pendingReorgs.size >= this.maxPendingReorgs) return;

        // Refuse to even start consensus on an out-of-window reorg. An honest majority
        // applying this bound denies a Byzantine reporter the quorum to drive a rollback
        // that reaches back arbitrarily far (blast-radius bound).
        if (!this.timestampInBounds(timestamp)) return;

        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this.hashesWellFormed(oldHash, newHash)) return;

        // Independent observation: co-sign only what our own indexer confirms.
        let verified = await this.verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash);
        if (!verified) return;
        let observedBlockTimeMs = Number.isFinite(verified.blockTimeMs) ? verified.blockTimeMs : null;
        // Abstain from a round whose timestamp predates the reorged block itself
        // (over-rollback attempt); an honest majority abstaining denies it quorum.
        if (!this.timestampConsistentWithBlockTime(timestamp, observedBlockTimeMs)) return;

        // Reentrancy (the await above yields): another ALERT/PREPARE for the same
        // reorg may have created the round meanwhile.
        if (this.processed.has(reorgId) || this.pendingReorgs.has(reorgId)) return;

        let snapshotContext = await this.lockReorgFederationSnapshot(btcBlockHeight, true);
        if (snapshotContext.refused) return;
        if (snapshotContext.active) {
            let senderPubkey = this.resolveReorgSenderPubkey(envelope);
            if (!pubkeyKnown || !senderPubkey || !snapshotContext.members.has(senderPubkey)) return;
        } else if (!legacyKnown) {
            return;
        }

        let affectedChains = this.getAffectedChains(chain);
        this.initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains,
            oldHash, newHash, observedBlockTimeMs, snapshotContext);
    },

    initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash,
            observedBlockTimeMs, snapshotContext) {
        if (this.pendingReorgs.has(reorgId)) return;
        if (snapshotContext && snapshotContext.refused) return;

        let snapshotActive = !!(snapshotContext && snapshotContext.active);
        let btcBlockHeight = snapshotActive ? snapshotContext.btcBlockHeight : null;
        let digest = this.reorgRoundDigest(reorgId, chain, reorgHeight, timestamp,
            oldHash, newHash, btcBlockHeight);

        let pending = {
            reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
            oldHash, newHash,
            // OUR OWN node's block_time (ms) for reorgHeight, captured during
            // self-verification: the rollback bound (executeRollback) anchors to
            // it instead of the reporter-supplied timestamp. Null when the indexer
            // reported no block_time (legacy timestamp bound applies).
            observedBlockTimeMs: Number.isFinite(observedBlockTimeMs) ? observedBlockTimeMs : null,
            // Every creation path verified this reorg against our own node first;
            // the commit gates re-check this flag (belt-and-braces).
            selfVerified: true,
            // Lock quorum at round start so the threshold can't shift between
            // PREPARE and COMMIT (validator set / peer count may change during
            // the 60s window), keeping every hub in lockstep across the round.
            quorum:   snapshotActive ? snapshotContext.quorum : this.getQuorum(),
            snapshotActive,
            btcBlockHeight,
            memberPubkeys: snapshotActive ? snapshotContext.members : null,
            prepares: new Set(),
            commits:  new Set(),
            preparePubkeys: new Set(),
            commitPubkeys:  new Set(),
            finalized: false,
            timer:    null
        };

        pending.prepares.add(this.peerManager.validatorAddr);
        if (snapshotActive) pending.preparePubkeys.add(snapshotContext.selfPubkey);
        this.pendingReorgs.set(reorgId, pending);

        armLeaderTimeout(this, reorgId, pending);

        let prepare = {
            reorgId, chain, reorgHeight, timestamp,
            affectedChains, digest, oldHash, newHash
        };
        if (snapshotActive) prepare.btcBlockHeight = btcBlockHeight;
        this.peerManager.broadcast(XCHAIN_REORG_PREPARE, prepare);

        this.checkPrepareQuorum(reorgId);
    },

    async handlePrepare(envelope) {
        let legacyKnown = this.isKnownSender(envelope.sender);
        let pubkeyKnown = isAdmissibleSigner(this.peerManager, envelope);
        if (!legacyKnown && !pubkeyKnown) {
            noteDrop({ reason: 'unknown_sender', phase: 'reorg_prepare', sender: envelope.sender, envelope });
            return;
        }
        let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
            oldHash, newHash, btcBlockHeight } = envelope.data;
        if (!reorgId || !digest) return;
        // Same canonical-reorgId binding as handleAlert: reject a PREPARE whose reorgId is
        // not the canonical form of its own (chain,reorgHeight,timestamp), so the round-
        // creation path here cannot be driven with attacker-minted reorgId strings
        // (REORG-INBOUND-UNBOUNDED-ROUNDS-1).
        if (!chain || !reorgHeight || !timestamp) return;
        if (reorgId !== this.canonicalReorgId(chain, reorgHeight, timestamp)) return;

        // A follower must not co-sign a reorg it would not itself accept: apply the same
        // blast-radius bound as handleAlert so a Byzantine leader can't gather quorum
        // from followers that skipped the ALERT. PREPARE carries the timestamp.
        if (!this.timestampInBounds(timestamp)) return;

        oldHash = String(oldHash || '').toLowerCase();
        newHash = String(newHash || '').toLowerCase();
        if (!this.hashesWellFormed(oldHash, newHash)) return;

        if (!this.pendingReorgs.has(reorgId)) {
            let opened = await openRoundFromPrepare(this, envelope, {
                reorgId, chain, reorgHeight, timestamp, affectedChains, digest,
                oldHash, newHash, btcBlockHeight
            }, { legacyKnown, pubkeyKnown });
            if (!opened) return;
        }

        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.digest !== digest) return;
        if (pending.snapshotActive) {
            if (btcBlockHeight !== pending.btcBlockHeight) return;
            let senderPubkey = this.resolveReorgSenderPubkey(envelope);
            if (!pubkeyKnown || !senderPubkey || !pending.memberPubkeys.has(senderPubkey)) return;
            pending.preparePubkeys.add(senderPubkey);
        } else {
            if (!legacyKnown) return;
            if (digest !== this.reorgRoundDigest(reorgId, chain, reorgHeight, timestamp,
                    oldHash, newHash, null)) return;
        }

        pending.prepares.add(envelope.sender);
        this.checkPrepareQuorum(reorgId);
    },

    // Open the round a PREPARE brought us into when we never saw its ALERT, from the
    // PREPARE's own fields once handlePrepare has verified them against our node. Its
    // timeout is twice the leader's, and it clears the round whether or not it finalized.
    openFollowerRound(fields) {
        let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest, oldHash,
            newHash, observedBlockTimeMs, snapshotContext } = fields;
        let snapshotActive = !!(snapshotContext && snapshotContext.active);
        let pending = {
            reorgId, chain, reorgHeight, timestamp,
            affectedChains: affectedChains || [],
            digest,
            oldHash, newHash,
            observedBlockTimeMs,
            selfVerified: true,
            // Lock quorum at round start (see initiateReorgConsensus).
            quorum:   snapshotActive ? snapshotContext.quorum : this.getQuorum(),
            snapshotActive,
            btcBlockHeight: snapshotActive ? snapshotContext.btcBlockHeight : null,
            memberPubkeys: snapshotActive ? snapshotContext.members : null,
            prepares: new Set(),
            commits:  new Set(),
            preparePubkeys: new Set(),
            commitPubkeys:  new Set(),
            finalized: false,
            timer: null
        };
        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                // Same silent-discard fix as initiateReorgConsensus: emit the
                // dropped rollback so it isn't lost without a signal.
                logger.warn('Reorg: Consensus timeout for ' + reorgId);
                this.emit('reorg:timeout', {
                    reorgId,
                    sourceChain:    pending.chain,
                    reorgHeight:    pending.reorgHeight,
                    timestamp:      pending.timestamp,
                    affectedChains: pending.affectedChains,
                    prepares:       this.reorgVoteCount(pending, 'prepare'),
                    commits:        this.reorgVoteCount(pending, 'commit'),
                    quorum:         pending.quorum
                });
            }
            this.pendingReorgs.delete(reorgId);
        }, this.timeout * 2);
        this.pendingReorgs.set(reorgId, pending);
    },

    handleCommit(envelope) {
        let { reorgId, digest, btcBlockHeight } = envelope.data;
        if (!reorgId || !digest) return;

        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.digest !== digest) return;

        if (pending.snapshotActive) {
            if (btcBlockHeight !== pending.btcBlockHeight ||
                    !isAdmissibleSigner(this.peerManager, envelope)) return;
            let senderPubkey = this.resolveReorgSenderPubkey(envelope);
            if (!senderPubkey || !pending.memberPubkeys.has(senderPubkey)) return;
            pending.commitPubkeys.add(senderPubkey);
        } else if (!this.isKnownSender(envelope.sender)) {
            noteDrop({ reason: 'unknown_sender', phase: 'reorg_commit', sender: envelope.sender, envelope });
            return;
        }
        pending.commits.add(envelope.sender);
        this.checkCommitQuorum(reorgId);
    },

    checkPrepareQuorum(reorgId) {
        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.finalized) return;
        // Never move to COMMIT for a reorg our own node did not confirm. Every
        // creation path sets this after verification; this guard is the invariant.
        if (pending.selfVerified !== true) return;

        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this.getQuorum();
        if (this.reorgVoteCount(pending, 'prepare') >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);
            if (pending.snapshotActive) {
                let selfPubkey = this.selfReorgPubkey();
                if (!selfPubkey || !pending.memberPubkeys.has(selfPubkey)) return;
                pending.commitPubkeys.add(selfPubkey);
            }

            let commit = {
                reorgId: reorgId,
                digest:  pending.digest
            };
            if (pending.snapshotActive) commit.btcBlockHeight = pending.btcBlockHeight;
            this.peerManager.broadcast(XCHAIN_REORG_COMMIT, commit);

            this.checkCommitQuorum(reorgId);
        }
    },

    checkCommitQuorum(reorgId) {
        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.finalized) return;
        // Same invariant as checkPrepareQuorum: an unverified round never
        // executes a rollback on this hub, no matter how many commits arrive.
        if (pending.selfVerified !== true) return;

        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this.getQuorum();
        if (this.reorgVoteCount(pending, 'commit') >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let proofSet = pending.snapshotActive ? pending.commitPubkeys : pending.commits;
            let proof = JSON.stringify([...proofSet]);
            let validatorCount = pending.snapshotActive
                ? pending.preparePubkeys.size : pending.prepares.size;

            this.executeRollback(
                pending.chain, pending.reorgHeight, pending.timestamp,
                reorgId, validatorCount, proof, pending.observedBlockTimeMs
            ).then(() => {
                this.pendingReorgs.delete(reorgId);
            }).catch(err => {
                logger.error(nodeUtil.format('Reorg: Error executing rollback for %s:', reorgId, err.message));
                this.pendingReorgs.delete(reorgId);
            });
        }
    }

};

Object.assign(module.exports, snapshotRoundMethods);
