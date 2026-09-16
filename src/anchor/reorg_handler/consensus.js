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
const nodeUtil = require('node:util');
const { XCHAIN_REORG_PREPARE, XCHAIN_REORG_COMMIT } = require('./message_types.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    async handleAlert(envelope) {
        if (!this.isKnownSender(envelope.sender)) {
            noteDrop({ reason: 'unknown_sender', phase: 'reorg_alert', sender: envelope.sender, envelope });
            return;
        }
        let { chain, reorgHeight, timestamp, reorgId, oldHash, newHash } = envelope.data;
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

        let affectedChains = this.getAffectedChains(chain);
        this.initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash, observedBlockTimeMs);
    },

    initiateReorgConsensus(reorgId, chain, reorgHeight, timestamp, affectedChains, oldHash, newHash, observedBlockTimeMs) {
        if (this.pendingReorgs.has(reorgId)) return;

        let digest = this.digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash);

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
            quorum:   this.getQuorum(),
            prepares: new Set(),
            commits:  new Set(),
            finalized: false,
            timer:    null
        };

        pending.prepares.add(this.peerManager.validatorAddr);
        this.pendingReorgs.set(reorgId, pending);

        pending.timer = setTimeout(() => {
            if (!pending.finalized) {
                logger.warn('Reorg: Consensus timeout for ' + reorgId);
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

        this.checkPrepareQuorum(reorgId);
    },

    async handlePrepare(envelope) {
        if (!this.isKnownSender(envelope.sender)) {
            noteDrop({ reason: 'unknown_sender', phase: 'reorg_prepare', sender: envelope.sender, envelope });
            return;
        }
        let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest, oldHash, newHash } = envelope.data;
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

        // The digest is fully derivable from the PREPARE's own fields, so never
        // trust the wire value: a mismatch is either corruption or an attempt to
        // fragment the round with per-follower digests.
        if (digest !== this.digest(reorgId, chain, reorgHeight, timestamp, oldHash, newHash)) return;

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
            let verified = await this.verifyReorgAgainstOwnNode(chain, parseInt(reorgHeight), oldHash, newHash);
            if (!verified) return;
            let observedBlockTimeMs = Number.isFinite(verified.blockTimeMs) ? verified.blockTimeMs : null;
            // Same over-rollback abstain as handleAlert: never co-sign a round
            // whose timestamp predates the reorged block's own block_time.
            if (!this.timestampConsistentWithBlockTime(timestamp, observedBlockTimeMs)) return;
            if (this.pendingReorgs.has(reorgId)) {
                // Round appeared while we were verifying; fall through to record.
            } else {
                // Create pending from the received (now verified) data
                this.openFollowerRound({ reorgId, chain, reorgHeight, timestamp, affectedChains, digest, oldHash, newHash, observedBlockTimeMs });
            }
        }

        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.digest !== digest) return;

        pending.prepares.add(envelope.sender);
        this.checkPrepareQuorum(reorgId);
    },

    // Open the round a PREPARE brought us into when we never saw its ALERT, from the
    // PREPARE's own fields once handlePrepare has verified them against our node. Its
    // timeout is twice the leader's, and it clears the round whether or not it finalized.
    openFollowerRound(fields) {
        let { reorgId, chain, reorgHeight, timestamp, affectedChains, digest, oldHash, newHash, observedBlockTimeMs } = fields;
        let pending = {
            reorgId, chain, reorgHeight, timestamp,
            affectedChains: affectedChains || [],
            digest,
            oldHash, newHash,
            observedBlockTimeMs,
            selfVerified: true,
            // Lock quorum at round start (see initiateReorgConsensus).
            quorum:   this.getQuorum(),
            prepares: new Set(),
            commits:  new Set(),
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
                    prepares:       pending.prepares.size,
                    commits:        pending.commits.size,
                    quorum:         pending.quorum
                });
            }
            this.pendingReorgs.delete(reorgId);
        }, this.timeout * 2);
        this.pendingReorgs.set(reorgId, pending);
    },

    handleCommit(envelope) {
        if (!this.isKnownSender(envelope.sender)) {
            noteDrop({ reason: 'unknown_sender', phase: 'reorg_commit', sender: envelope.sender, envelope });
            return;
        }
        let { reorgId, digest } = envelope.data;
        if (!reorgId || !digest) return;

        let pending = this.pendingReorgs.get(reorgId);
        if (!pending || pending.digest !== digest) return;

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
        if (pending.prepares.size >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            pending.commits.add(this.peerManager.validatorAddr);

            this.peerManager.broadcast(XCHAIN_REORG_COMMIT, {
                reorgId: reorgId,
                digest:  pending.digest
            });

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
        if (pending.commits.size >= quorum) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);

            let proof = JSON.stringify([...pending.commits]);

            this.executeRollback(
                pending.chain, pending.reorgHeight, pending.timestamp,
                reorgId, pending.prepares.size, proof, pending.observedBlockTimeMs
            ).then(() => {
                this.pendingReorgs.delete(reorgId);
            }).catch(err => {
                logger.error(nodeUtil.format('Reorg: Error executing rollback for %s:', reorgId, err.message));
                this.pendingReorgs.delete(reorgId);
            });
        }
    }

};
