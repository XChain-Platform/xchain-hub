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
 * XChain Hub - Cross-Chain Attestation Follower
 *
 * The follower's side of an attestation round: routing PROPOSE, PREPARE and COMMIT messages,
 * the checks a PROPOSE passes before this hub co-signs it, the follower's round over the
 * leader's snapshot, and the PREPARE and COMMIT votes counted toward its quorum.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { noteDrop } = require('../../consensus/diagnostics');
const { XCHAIN_ATTEST_PROPOSE, XCHAIN_ATTEST_PREPARE, XCHAIN_ATTEST_COMMIT } = require('./constants.js');
const { SNAPSHOT_BLOCK_TOLERANCE } = require('../bridge/constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    handleMessage(envelope) {
        switch (envelope.type) {
            case XCHAIN_ATTEST_PROPOSE:
                // handlePropose is async because it locks the cross_chain
                // validator-set snapshot at the round's block boundary via an
                // indexer call. Errors are caught and logged; they never bubble up
                // to the gossip layer (mirrors OracleConsensus).
                this.handlePropose(envelope).catch(err =>
                    logger.error(nodeUtil.format('CrossChain: PROPOSE handler error for %s:',
                        (envelope && envelope.data && envelope.data.attestationId),
                        err && err.message)));
                break;
            case XCHAIN_ATTEST_PREPARE: this.handlePrepare(envelope); break;
            case XCHAIN_ATTEST_COMMIT:  this.handleCommit(envelope);  break;
        }
    },

    async handlePropose(envelope) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest, btcBlockHeight } = envelope.data;
        if (!this.admissibleProposal(envelope)) return;

        // Never trust the proposer's claim: confirm the source action exists on
        // the source chain, at sufficient depth, against this hub's OWN
        // indexer before co-signing. Fails closed (drop, don't sign) when the
        // action is missing, under-confirmed, or unverifiable.
        if (!(await this.verifySourceAction(sourceChain, sourceActionIndex))) {
            logger.warn('CrossChain: refusing to PREPARE ' + attestationId +
                ': source action not verified against local indexer');
            return;
        }

        // Create pending if not exists. Both snapshot awaits stay in this function so the
        // round opens and takes the leader's and our own PREPARE in one synchronous step.
        if (!this.pendingAttestations.has(attestationId)) {
            // Lock quorum from the same block-boundary cross_chain snapshot the
            // leader used (btcBlockHeight carried in the envelope) so every hub
            // freezes the same N for this round. With no snapshot (indexer down or no
            // btcBlockHeight), resolveQuorum throws on a federated hub and the catch drops
            // the PROPOSE; only single-node / regtest hubs fall back to the live set.
            if (!(await this.proposeHeightBounded(attestationId, envelope, btcBlockHeight))) return;
            let quorum;
            try {
                quorum = await this.resolveQuorum(sourceChain, destChain, btcBlockHeight);
            } catch (err) {
                // Fail closed: resolveQuorum throws when federated but no
                // deterministic snapshot resolved. Drop the PROPOSE (don't co-sign)
                // rather than PREPARE over a locally-derived quorum peers aren't using.
                logger.warn('CrossChain: refusing to PREPARE ' + attestationId + ': ' + err.message);
                return;
            }
            if (this.refusesZeroQuorum(attestationId, quorum, btcBlockHeight)) return;
            // Same block boundary the leader resolved, carried in the PROPOSE envelope, so
            // follower and leader gate their tallies on the identical member set.
            let memberPubkeys = await this.resolveMemberPubkeys(btcBlockHeight);
            this.openFollowerRound({ attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest, btcBlockHeight, quorum, memberPubkeys });
        }

        let pending = this.pendingAttestations.get(attestationId);
        this.addVote(pending.prepares, envelope);
        let selfPkOnAccept = this.selfPubkey();
        if (selfPkOnAccept) pending.prepares.add(selfPkOnAccept);

        // Send PREPARE
        this.peerManager.broadcast(XCHAIN_ATTEST_PREPARE, {
            attestationId, digest
        });

        this.checkPrepareQuorum(attestationId);
    },

    // Bound the proposer's snapshot height against our own BTC tip before it locks N, the
    // quorum and the vote population. An old but indexed height still resolves a valid
    // snapshot, so without this the proposer picks the electorate (same guard as pbft
    // tipBoundOk and oracle boundedProposeHeight). A PROPOSE only comes from a peer, so this
    // hub is federated here. A missing height, an unresolvable tip or a gap over
    // SNAPSHOT_BLOCK_TOLERANCE returns false after a warning, and the PROPOSE is dropped.
    async proposeHeightBounded(attestationId, envelope, btcBlockHeight) {
        let height = Number(btcBlockHeight);
        let myTip = null;
        try {
            myTip = this.hub && this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
        } catch (err) {
            myTip = null;
        }
        let reason = null;
        if (btcBlockHeight == null || !Number.isInteger(height) || height <= 0) reason = 'carries no valid btcBlockHeight';
        else if (myTip == null || !Number.isFinite(Number(myTip))) reason = 'cannot resolve our own BTC tip to bound its height';
        else if (Math.abs(Number(myTip) - height) > SNAPSHOT_BLOCK_TOLERANCE) {
            reason = 'btcBlockHeight ' + height + ' deviates from our own BTC tip ' + myTip +
                ' by more than ' + SNAPSHOT_BLOCK_TOLERANCE + ' blocks';
        }
        if (!reason) return true;
        logger.warn('CrossChain: refusing to PREPARE ' + attestationId + ' from ' +
            (envelope && envelope.sender) + ': PROPOSE ' + reason +
            '; a stale height would let the proposer select the quorum and the voter set');
        return false;
    },

    // The checks a PROPOSE passes before any snapshot or indexer work is spent on it: a
    // well-formed id this hub has not finalized, a registered sender, a matching digest and
    // discrete fields bound to the id. False drops the PROPOSE.
    admissibleProposal(envelope) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest } = envelope.data;
        if (!attestationId || !digest) return false;
        if (!/^[A-Z]{2,6}:\d+:[A-Z]{2,6}$/.test(attestationId)) return false;
        if (this.finalized.has(attestationId)) return false;

        // Discard proposals from senders that are not registered validators
        // before doing any snapshot/indexer work for them.
        if (!this.isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'xchain_propose', sender: envelope.sender, envelope });
            return false;
        }

        // Verify digest
        let computedDigest = this.digest(attestationId, confirmations);
        if (computedDigest !== digest) return false;

        // The discrete fields are what get stored when the round finalizes, so
        // bind them to the attestationId the digest covers; a proposer must
        // not be able to verify one action while attesting another.
        let [idSource, idIndex, idDest] = attestationId.split(':');
        if (idSource !== sourceChain || idDest !== destChain ||
            parseInt(idIndex, 10) !== parseInt(sourceActionIndex, 10)) return false;
        return true;
    },

    // A follower must NEVER finalize over a quorum of 0. Unlike the leader's
    // single-operator fast path (requestAttestation, which self-signs only after
    // confirming no federation snapshot resolved), reaching handlePropose means a
    // PEER proposed, so a federation exists. A 0 quorum here means the cross_chain
    // capability snapshot at btcBlockHeight resolved EMPTY (bootstrap / a misconfigured
    // indexer / an unpopulated qualifying set); co-signing would let a single PROPOSE
    // mint an 'attested' row no quorum ratified, which downstream indexers then settle
    // from escrow. This is the same empty-snapshot hazard the leader path already guards
    // and the DEX engine was hardened against. Refuse; the round retries once the
    // snapshot populates. (A genuine single-node hub has no peers, so never reaches here.)
    // True, after the warning, when this hub refuses to PREPARE.
    refusesZeroQuorum(attestationId, quorum, btcBlockHeight) {
        if (quorum !== 0) return false;
        logger.warn('CrossChain: refusing to PREPARE ' + attestationId +
            ': cross_chain snapshot resolved a 0 quorum (empty / bootstrap) at block ' + btcBlockHeight);
        return true;
    },

    // A follower's round for a verified PROPOSE, over the quorum and member set handlePropose
    // resolved at the block the leader named. Synchronous on purpose: handlePropose counts the
    // leader's and its own PREPARE right after, so no vote can reach the round without them.
    openFollowerRound(round) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest,
            btcBlockHeight, quorum, memberPubkeys } = round;
        let pending = {
            attestationId, sourceChain, sourceActionIndex, destChain,
            confirmations, digest,
            memberPubkeys,
            btcBlockHeight: btcBlockHeight || null,
            quorum,
            prepares: new Set(),
            commits:  new Set(),
            finalized: false,
            timer: null,
            // Callers on this hub that requested the same id while it was being followed.
            waiters: [],
            resolve: null, reject: null
        };
        // Evict a round that never reached commit quorum; a quorate one is kept until its store lands.
        // Only this round is evicted: a later round under the same id is not this timer's to drop.
        pending.timer = setTimeout(() => {
            pending.timer = null;
            if (pending.quorate) return;
            if (this.pendingAttestations.get(attestationId) === pending) this.pendingAttestations.delete(attestationId);
            this.settleWaiters(pending, new Error('Attestation timeout for ' + attestationId));
        }, this.timeout * 2);
        this.pendingAttestations.set(attestationId, pending);
    },

    handlePrepare(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count PREPARE votes whose signing key the chain or the registry attributes.
        if (!this.isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'xchain_prepare', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        this.addVote(pending.prepares, envelope);
        this.checkPrepareQuorum(attestationId);
    },

    handleCommit(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count COMMIT votes whose signing key the chain or the registry attributes.
        if (!this.isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'xchain_commit', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        this.addVote(pending.commits, envelope);
        this.checkCommitQuorum(attestationId);
    },
};
