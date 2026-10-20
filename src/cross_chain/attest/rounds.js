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
 * The leader's side of an attestation round: the request, joining a round already in flight,
 * the single-operator fast path and the promise a federated round resolves. The follower's
 * side lives in follower.js and the PREPARE and COMMIT tallies in tally.js.
 *
 ********************************************************************/

const { ALLOWED_CHAINS, DEFAULT_CONFIRMATIONS, XCHAIN_ATTEST_PROPOSE } = require('./constants.js');

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
        this.refuseWhileStoring(attestationId);

        // Join a round already in flight for this id, led here or followed from a peer's PROPOSE:
        // a second round would replace it and drop the votes it holds.
        let inFlight = this.pendingAttestations.get(attestationId);
        if (inFlight) return await this.joinAttestationRound(inFlight);

        // Resolve the cross_chain validator set at the current BTC block
        // boundary so every hub locks the same quorum for this attestation,
        // regardless of when it processes the round (mirrors Consensus /
        // OracleConsensus). The block height is stamped into the PROPOSE
        // envelope below so followers resolve the identical snapshot. Falls
        // back to the live validator set when the indexer is unreachable.
        let btcBlockHeight = this.hub.resolveBtcLatestBlock
            ? await this.hub.resolveBtcLatestBlock()
            : null;

        // Single-node fallback
        let quorum = await this.resolveQuorum(sourceChain, destChain, btcBlockHeight);
        if (quorum === 0) {
            return await this.finalizeSingleNode(attestationId, sourceChain, sourceActionIndex,
                destChain, confirmations, btcBlockHeight);
        }

        // Any hub may open the round: proposals for one id merge in handlePropose, and safety rests on
        // the snapshot-locked quorum and member set plus each follower's own source-action check.
        let digest = this.digest(attestationId, confirmations);

        // Lock the VOTE POPULATION alongside the quorum, from the same snapshot that
        // sized it, so N's divisor and its numerator read one set (see countedVotes).
        let memberPubkeys = await this.resolveMemberPubkeys(btcBlockHeight);

        return new Promise((resolve, reject) => {
            this.openAttestationRound({ attestationId, sourceChain, sourceActionIndex, destChain,
                confirmations, digest, quorum, memberPubkeys, btcBlockHeight }, resolve, reject);
        });
    },

    // Throw while a round under this id that reached quorum is still re-driving its store:
    // a new round would replace it and drop the quorum peers already signed.
    refuseWhileStoring(attestationId) {
        let inFlight = this.pendingAttestations.get(attestationId);
        if (inFlight && inFlight.quorate) {
            throw new Error('Attestation ' + attestationId + ' reached quorum but is not stored yet (persistence pending, retrying)');
        }
    },

    // Wait on a round already in flight, sending no second PROPOSE. The caller hears back when the
    // round stores its attestation, when the round is evicted or the engine stops, or at its own timeout.
    joinAttestationRound(pending) {
        return new Promise((resolve, reject) => {
            let waiter = { resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                waiter.timer = null;
                pending.waiters = (pending.waiters || []).filter((w) => w !== waiter);
                reject(new Error(pending.quorate
                    ? 'Attestation ' + pending.attestationId + ' reached quorum but is not stored yet (persistence pending, retrying)'
                    : 'Attestation timeout for ' + pending.attestationId));
            }, this.timeout);
            pending.waiters = (pending.waiters || []).concat([waiter]);
        });
    },

    // Settle every caller joined to a round, with its stored attestation or with `err`.
    settleWaiters(pending, err, attestation) {
        let waiters = pending.waiters || [];
        pending.waiters = [];
        for (let waiter of waiters) {
            if (waiter.timer) clearTimeout(waiter.timer);
            if (err) waiter.reject(err);
            else waiter.resolve(attestation);
        }
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
        // Refuse a one-member snapshot that does not hold this hub: only its sole member may
        // attest alone, so a non-member would mint a row no qualifying validator signed.
        let self = this.selfPubkey();
        if (snap && Array.isArray(snap.validators) &&
            !(self && snap.validators.some(v => v && String(v.pubkey).toLowerCase() === self))) {
            throw new Error('CrossChain: refusing to finalize attestation ' + attestationId +
                ' unilaterally over a cross_chain snapshot (block ' + btcBlockHeight +
                ') that does not hold this hub; will retry when the snapshot changes');
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
            // Callers that joined this round from a later request for the same id.
            waiters:  [],
            resolve, reject
        };

        // Add own PREPARE
        // Vote sets hold PROVEN SIGNING KEYS, not sender addrs (see addVote).
        let selfPkOnPropose = this.selfPubkey();
        if (selfPkOnPropose) pending.prepares.add(selfPkOnPropose);
        this.pendingAttestations.set(attestationId, pending);

        // Timeout. The caller always hears back at the deadline. A round that reached commit
        // quorum stays in memory, because its store re-drive must still write the row peers hold.
        pending.timer = setTimeout(() => {
            pending.timer = null;
            if (pending.quorate) {
                reject(new Error('Attestation ' + attestationId + ' reached quorum but is not stored yet (persistence pending, retrying)'));
                return;
            }
            if (!pending.finalized) {
                pending.finalized = true;
                // Evict only this round: a later round under the same id is not this timer's to drop.
                if (this.pendingAttestations.get(attestationId) === pending) this.pendingAttestations.delete(attestationId);
                reject(new Error('Attestation timeout for ' + attestationId));
                this.settleWaiters(pending, new Error('Attestation timeout for ' + attestationId));
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
};
