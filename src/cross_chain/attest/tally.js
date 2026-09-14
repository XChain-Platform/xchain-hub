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
 * XChain Hub - Cross-Chain Attestation Tally
 *
 * Counting a round's votes against the population its quorum was sized from, the COMMIT this
 * hub broadcasts once PREPARE clears, and the store, the finalized ring and the event a
 * cleared COMMIT quorum produces.
 *
 ********************************************************************/

const { XCHAIN_ATTEST_COMMIT } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
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
    countedVotes(pending, voteSet) {
        if (!pending || !pending.memberPubkeys) return voteSet ? voteSet.size : 0;
        let counted = 0;
        for (let pk of voteSet) {
            if (pending.memberPubkeys.has(pk)) counted++;
        }
        return counted;
    },

    checkPrepareQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        // Use the round's locked quorum (captured at attestation creation),
        // not a live recompute; this keeps every hub in lockstep across the round.
        // Votes are counted against the round's locked snapshot population (countedVotes),
        // so the threshold and the electorate come from one set.
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this.getQuorum();
        if (this.countedVotes(pending, pending.prepares) >= quorum && !pending._commitSent) {
            pending._commitSent = true;
            let selfPkOnCommit = this.selfPubkey();
            if (selfPkOnCommit) pending.commits.add(selfPkOnCommit);

            this.peerManager.broadcast(XCHAIN_ATTEST_COMMIT, {
                attestationId:  attestationId,
                digest:         pending.digest
            });

            this.checkCommitQuorum(attestationId);
        }
    },

    checkCommitQuorum(attestationId) {
        let pending = this.pendingAttestations.get(attestationId);
        if (!pending || pending.finalized) return;

        // Same locked quorum and same snapshot-gated tally as checkPrepareQuorum.
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this.getQuorum();
        if (this.countedVotes(pending, pending.commits) >= quorum) {
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

            this.storeWithRetry(attestation)
                .then(() => {
                    if (pending.timer) clearTimeout(pending.timer);
                    this.markFinalized(attestationId);
                    this.pendingAttestations.delete(attestationId);

                    logger.info('CrossChain: Attestation finalized: ' + attestationId +
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
                    logger.error('CrossChain: Error storing attestation after ' +
                        this.storeRetryAttempts + ' attempt(s), retaining round for retry: ' + err.message);
                    pending.finalized = false;
                });
        }
    },

    // Record a finalized attestation id under the bounded FIFO ring (R2-CCF4).
    // Evicts the oldest id once the window is full so the set cannot grow without
    // limit over the process lifetime.
    markFinalized(attestationId) {
        if (this.finalized.has(attestationId)) return;
        this.finalized.add(attestationId);
        this._finalizedOrder.push(attestationId);
        if (this._finalizedOrder.length > this.finalizedMax) {
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
        }
    },
};
