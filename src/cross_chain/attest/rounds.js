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
 * XChain Hub - Cross-Chain Attestation Rounds
 *
 * One attestation round from both sides: the leader's request, its single-operator fast path
 * and the promise a federated round resolves, the follower's round for a verified PROPOSE,
 * and the PREPARE and COMMIT tallies that finalize and store it.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { noteDrop } = require('../../consensus/diagnostics');
const { ALLOWED_CHAINS, DEFAULT_CONFIRMATIONS, XCHAIN_ATTEST_PROPOSE, XCHAIN_ATTEST_PREPARE, XCHAIN_ATTEST_COMMIT } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
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
            return await this.getStoredAttestation(attestationId);
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
            return await this.finalizeSingleNode(attestationId, sourceChain, sourceActionIndex,
                destChain, confirmations, btcBlockHeight);
        }

        // Check if this node is the leader for this chain pair
        this.seq++;
        let leader = this._getLeader(this.seq, sourceChain, destChain);
        if (leader && leader.addr !== this.peerManager.validatorAddr) {
            throw new Error('Not the leader for attestation (leader: ' + leader.addr + ')');
        }

        let digest = this._digest(attestationId, confirmations);

        // Lock the VOTE POPULATION alongside the quorum, from the same snapshot that
        // sized it, so N's divisor and its numerator read one set (see countedVotes).
        let memberPubkeys = await this.resolveMemberPubkeys(btcBlockHeight);

        return new Promise((resolve, reject) => {
            this.openAttestationRound({ attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest, quorum, memberPubkeys, btcBlockHeight }, resolve, reject);
        });
    },

    // The single-operator fast path: store and announce an attestation no peer co-signs,
    // refused when a federation snapshot resolved empty at this block.
    async finalizeSingleNode(attestationId, sourceChain, sourceActionIndex, destChain, confirmations, btcBlockHeight) {
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
        await this.storeAttestation(attestation);
        // Same post-store bookkeeping the consensus path does in
        // checkCommitQuorum. Without it a single-operator hub wrote an
        // 'attested' row that nothing downstream ever heard about: SwapTracker
        // subscribes to 'attestation:finalized', so its swap_records rows sat at
        // 'initiated' forever, and a repeat request re-ran the whole path instead
        // of short-circuiting on the finalized ring.
        this.markFinalized(attestationId);
        this.emit('attestation:finalized', attestation);
        return attestation;
    },

    // Open the leader's round: lock its quorum and member set, arm the timeout, broadcast PROPOSE.
    openAttestationRound(round, resolve, reject) {
        let { attestationId, sourceChain, sourceActionIndex, destChain,
              confirmations, digest, quorum, memberPubkeys, btcBlockHeight } = round;
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
        // Vote sets hold PROVEN SIGNING KEYS, not sender addrs (see addVote).
        let selfPkOnPropose = this.selfPubkey();
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

        this.checkPrepareQuorum(attestationId);
    },

    _handleMessage(envelope) {
        switch (envelope.type) {
            case XCHAIN_ATTEST_PROPOSE:
                // _handlePropose is async because it locks the cross_chain
                // validator-set snapshot at the round's block boundary via an
                // indexer call. Errors are caught and logged; they never bubble up
                // to the gossip layer (mirrors OracleConsensus).
                this._handlePropose(envelope).catch(err =>
                    logger.error(nodeUtil.format('CrossChain: PROPOSE handler error for %s:',
                        (envelope && envelope.data && envelope.data.attestationId),
                        err && err.message)));
                break;
            case XCHAIN_ATTEST_PREPARE: this.handlePrepare(envelope); break;
            case XCHAIN_ATTEST_COMMIT:  this._handleCommit(envelope);  break;
        }
    },

    async _handlePropose(envelope) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest, btcBlockHeight } = envelope.data;
        if (!attestationId || !digest) return;
        if (!/^[A-Z]{2,6}:\d+:[A-Z]{2,6}$/.test(attestationId)) return;
        if (this.finalized.has(attestationId)) return;

        // Discard proposals from senders that are not registered validators
        // before doing any snapshot/indexer work for them.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'xchain_propose', sender: envelope.sender, envelope });
            return;
        }

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
        if (!(await this.verifySourceAction(sourceChain, sourceActionIndex))) {
            logger.warn('CrossChain: refusing to PREPARE ' + attestationId +
                ': source action not verified against local indexer');
            return;
        }

        // Create pending if not exists
        if (!this.pendingAttestations.has(attestationId)) {
            if (!(await this.openFollowerRound({ attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest, btcBlockHeight }))) return;
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

    // A follower's round for a verified PROPOSE, over the quorum and member set of the block the
    // leader named. False when this hub refuses to PREPARE.
    async openFollowerRound(round) {
        let { attestationId, sourceChain, sourceActionIndex, destChain, confirmations, digest, btcBlockHeight } = round;
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
            logger.warn('CrossChain: refusing to PREPARE ' + attestationId + ': ' + err.message);
            return false;
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
            logger.warn('CrossChain: refusing to PREPARE ' + attestationId +
                ': cross_chain snapshot resolved a 0 quorum (empty / bootstrap) at block ' + btcBlockHeight);
            return false;
        }
        // Same block boundary the leader resolved, carried in the PROPOSE envelope, so
        // follower and leader gate their tallies on the identical member set.
        let memberPubkeys = await this.resolveMemberPubkeys(btcBlockHeight);
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
        return true;
    },

    handlePrepare(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count PREPARE votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'xchain_prepare', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        this.addVote(pending.prepares, envelope);
        this.checkPrepareQuorum(attestationId);
    },

    _handleCommit(envelope) {
        let { attestationId, digest } = envelope.data;
        if (!attestationId || !digest) return;

        // Only count COMMIT votes whose signing key the chain or the registry attributes.
        if (!this._isKnownSender(envelope)) {
            noteDrop({ reason: 'unknown_sender', phase: 'xchain_commit', sender: envelope.sender, envelope });
            return;
        }

        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.digest !== digest) return;

        this.addVote(pending.commits, envelope);
        this.checkCommitQuorum(attestationId);
    },
};
