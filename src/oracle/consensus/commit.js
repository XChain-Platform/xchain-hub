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
 * XChain Hub - Oracle Consensus: quorum, commit and signatures
 *
 * The vote tally in both quorum modes, the PREPARE and COMMIT quorum checks, the
 * durable finalize with its bounded retry and self-healing re-drive, and the PRICE v0
 * signing and verification the votes carry.
 *
 ********************************************************************/

'use strict';

const ValidatorIdentity = require('../../validators/identity.js');
const swq               = require('../../stake_weighted_quorum.js');
const { ORACLE_COMMIT } = require('./constants.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Backoff for the self-heal re-drive of a committed round whose snapshot store keeps
// failing (item 4281, see armFinalizeRetry). Starts fast because most DB stalls are
// brief, caps low enough that a recovered DB is picked up within half a minute.
const FINALIZE_RETRY_BASE_MS = 1000;
const FINALIZE_RETRY_MAX_MS  = 30000;

// Announce a durably stored round: mark it finalized, drop its in-memory state and emit
// round:finalized with the signatures the quorum collected.
function announceCommittedRound(round, pending, attempt) {
    // Persistence succeeded: now (and only now) it is safe to finalize and
    // drop the in-memory round state.
    this.markFinalized(round);
    this.pendingRounds.delete(round);
    this.clearRoundTracking(round);
    logger.info('Oracle: Round ' + round + ' finalized (' +
        pending.prepares.size + ' prepares, ' +
        pending.commits.size + ' commits)' +
        (attempt > 1 ? ' after ' + attempt + ' store attempts' : ''));

    // Convert collected signatures to the [{pubkey, sig}, ...] array format used by OraclePublisher
    let sigsArray = [];
    for (let [pubkey, sig] of pending.signatures) {
        sigsArray.push({ pubkey: pubkey, sig: sig });
    }

    this.emit('round:finalized', {
        round:          round,
        btcBlockHeight: pending.btcBlockHeight,
        btcBlockTime:   pending.btcBlockTime,
        prices:         pending.prices,
        // The round's admission map, the one the v0 signatures above cover, so
        // the publisher's batch carries the map the producer actually signed.
        admitBlocks:    pending.admitBlocks == null ? null : pending.admitBlocks,
        // SIGNING KEYS, not addrs: the reward/slash consumer pays by key,
        // so a validator the chain attributes but the registry never saw
        // is payable for the round it just helped finalize.
        participants:   [...pending.prepares],
        signatures:     sigsArray,
        submissions:    this.oracleRound.getSubmissions(round)
    });
}

module.exports = {

    // Whether the round has cleared quorum. STAKE_WEIGHTED_QUORUM tallies the
    // SUMMED STAKE (source-deduped, >2/3 of S) of validators that have produced a
    // valid signature on the canonical (keyed on `pending.signatures`), which is
    // exactly the signer set the indexer re-verifies (actions/price.js). A value
    // cannot finalize without >2/3 stake having signed it, so the published PRICE
    // always clears the indexer's identical weighted gate. Below activation: the
    // count of the passed vote set against the locked quorum.
    quorumMet(pending, voteSet) {
        if (pending.weighted)
            return swq.meetsStakeThreshold(pending.validators, [...pending.signatures.keys()]);
        let quorum = (typeof pending.quorum === 'number') ? pending.quorum : this.getQuorum();
        // Count-mode quorum tallies DISTINCT MEMBER KEYS. The quorum above is sized
        // from the snapshot's qualified set, so a vote from a key with no qualifying
        // stake must not count toward it. Null memberPubkeys keeps the raw count
        // (graceful degradation, matching the quorum fallback).
        return this.countDistinctMembers(pending, voteSet) >= quorum;
    },

    // Distinct qualified MEMBER-KEY tally for one of the round's vote sets. The
    // sets already hold proven signing keys (one entry per key however many
    // senders it named), so this only has to intersect them with the round's
    // snapshot membership. Null memberPubkeys (no usable snapshot) degrades to the
    // raw count, matching the quorum fallback. Defined once so the finalization
    // tally and the validator_count recorded beside it cannot drift.
    countDistinctMembers(pending, voteSet) {
        if (!voteSet) return 0;
        if (!pending || !pending.memberPubkeys) return voteSet.size;
        let counted = 0;
        for (let pk of voteSet) {
            if (pending.memberPubkeys.has(pk)) counted++;
        }
        return counted;
    },

    checkPrepareQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        // Use the round's locked quorum (snapshot at the block boundary),
        // not a live recompute, to keep every hub in lockstep across the round.
        if (this.quorumMet(pending, pending.prepares) && !pending._commitSent) {
            pending._commitSent = true;
            let selfPk = this.selfPubkey();
            if (selfPk) pending.commits.add(selfPk);

            // Include this validator's signature in the COMMIT message so late-joining nodes
            // can collect signatures from any of the three phases (PROPOSE, PREPARE, COMMIT)
            let mySig = this.signPriceV0(round, pending.btcBlockTime, pending.prices, pending.btcBlockHeight, pending.admitBlocks);
            if (mySig && !pending.signatures.has(mySig.pubkey)) {
                pending.signatures.set(mySig.pubkey, mySig.sig);
            }

            this.peerManager.broadcast(ORACLE_COMMIT, {
                round:      round,
                digest:     pending.digest,
                sig_pubkey: mySig ? mySig.pubkey : null,
                sig:        mySig ? mySig.sig    : null
            });

            this.checkCommitQuorum(round);
        }
    },

    checkCommitQuorum(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending || pending.finalized) return;

        // Same quorum rule as checkPrepareQuorum (see quorumMet).
        if (this.quorumMet(pending, pending.commits)) {
            pending.finalized = true;
            if (pending.timer) clearTimeout(pending.timer);
            // Fire-and-forget (mirrors the prior promise-chain behavior); durability,
            // retry, and re-drive-on-failure live in finalizeCommittedRound.
            this.finalizeCommittedRound(round);
        }
    },

    // Persist a quorum-finalized round's snapshot, then mark finalized + emit
    // round:finalized. A round reaching commit quorum carries collected validator
    // signatures, so a transient DB error while storing MUST NOT silently drop it
    // (the prior code deleted pending + tracking in the .catch with no retry and no
    // durable record, leaving pending.finalized already true so replayed COMMITs
    // could never re-finalize; the round evaporated on a one-off DB hiccup). Retry
    // the store a bounded number of times; only on durable success do we markFinalized,
    // delete round state, and emit. If every attempt fails we do NOT delete round state
    // and we RESET pending.finalized=false, so a later replayed COMMIT re-enters
    // checkCommitQuorum and re-drives finalization instead of the round being lost.
    async finalizeCommittedRound(round) {
        let pending = this.pendingRounds.get(round);
        if (!pending) return;

        // Record the endorsement breadth the round actually finalized on: distinct
        // qualified member pubkeys, the same tally quorumMet counts, not the raw
        // addr-keyed prepare set. A key registered under two addrs (or a registered
        // non-member whose PREPARE joined the set but never the quorum) inflated the
        // persisted, mirrored and API-served validator_count above the endorsers that
        // cleared quorum (item 4941).
        let validatorCount = this.countDistinctMembers(pending, pending.prepares);
        let proof = JSON.stringify([...pending.commits]);

        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this.storeSnapshot(round, pending.prices, validatorCount, proof,
                    pending.btcBlockHeight, pending.btcBlockTime, pending.admitBlocks);

                announceCommittedRound.call(this, round, pending, attempt);
                return;
            } catch (err) {
                logger.error(nodeUtil.format('Oracle: Error storing snapshot for round %s (attempt %d/%d):', round, attempt, maxAttempts, err.message));
                if (attempt < maxAttempts) {
                    // Linear backoff between retries for a transient DB hiccup.
                    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                    // The shared tree could have been cleared out from under us by a
                    // concurrent path; bail if the round is gone.
                    if (!this.pendingRounds.has(round)) return;
                }
            }
        }

        // Every store attempt failed. Do NOT delete round state and do NOT leave
        // pending.finalized=true: resetting it lets a subsequent replayed COMMIT
        // re-enter checkCommitQuorum and re-drive finalization once the DB recovers,
        // rather than the quorum-signed round being silently and permanently dropped.
        logger.error('Oracle: Round ' + round + ' snapshot store failed after ' +
            maxAttempts + ' attempts; retaining round state and re-driving on a timer ' +
            '(round NOT dropped).');
        let stillPending = this.pendingRounds.get(round);
        if (!stillPending) return;
        stillPending.finalized = false;
        this.armFinalizeRetry(round, stillPending);
    },

    // Re-drive a stalled finalize on our OWN timer, so a quorum-signed round self-heals when
    // the DB comes back (item 4281). Resetting finalized=false above only makes the round
    // re-drivable BY A PEER, and each peer broadcasts COMMIT exactly once behind
    // pending._commitSent (checkPrepareQuorum), so nothing is guaranteed to arrive: with the
    // eviction timer already cleared at commit quorum and no sweep over pendingRounds, a DB
    // outage outlasting the bounded retry above stranded the round in memory forever,
    // unpersisted and unpublished.
    //
    // Reuses the pending.timer slot so stop() and a later checkCommitQuorum both tear this
    // down, and clears first so a round can never hold two outstanding retries.
    armFinalizeRetry(round, pending) {
        let delay = Math.min((pending._finalizeRetryMs || 0) * 2 || FINALIZE_RETRY_BASE_MS,
                             FINALIZE_RETRY_MAX_MS);
        pending._finalizeRetryMs = delay;
        if (pending.timer) clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
            let p = this.pendingRounds.get(round);
            // Bail when another path already finished the round, or one is mid-flight:
            // finalized=true is exactly the in-flight claim checkCommitQuorum makes.
            if (!p || p.finalized || this.finalized.has(round)) return;
            // Make the same claim before re-entering, so a peer COMMIT landing now cannot
            // start a second finalize and emit round:finalized twice.
            p.finalized = true;
            Promise.resolve(this.finalizeCommittedRound(round)).catch(err =>
                logger.error(nodeUtil.format('Oracle: re-finalize of round %s threw:', round, err && err.message)));
        }, delay);
        // Never hold the process open on a retry that may re-arm indefinitely; stop() is
        // what tears it down on a clean shutdown.
        if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
        logger.warn('Oracle: re-finalize of round ' + round + ' scheduled in ' + delay + 'ms');
    },

    // Sign the canonical PRICE v0 payload with the local validator identity
    // Returns { pubkey, sig } or null if no identity is configured.
    // `admitBlocks` is the round's admission map, forwarded to the canonical builder so a
    // signature always covers the heights the round is admitted at; omitted is the legacy
    // round, which is every round below the activation.
    signPriceV0(round, btcBlockTime, prices, btcBlockHeight, admitBlocks) {
        let identity = this.hub && this.hub.getIdentity ? this.hub.getIdentity() : null;
        if (!identity) return null;
        try {
            let payload = this.buildPriceV0Payload(round, btcBlockTime, prices, btcBlockHeight, admitBlocks);
            let sigHex  = identity.sign(payload);
            return { pubkey: identity.getPubkeyHex(), sig: sigHex };
        } catch (e) {
            logger.warn(nodeUtil.format('Oracle: failed to sign PRICE v0 payload:', e));
            return null;
        }
    },

    // Verify a (pubkey, sig) pair against the pending round's canonical PRICE v0 payload,
    // and store it on the pending round's signatures map if valid.
    // The pending object must have a `round` field set when it's created.
    verifyAndStoreSig(pending, pubkeyHex, sigHex) {
        if (!pending || !pubkeyHex || !sigHex) return false;
        // Key the signatures map on LOWERCASE pubkey hex (item 5334). This was the one
        // wire-pubkey keying site in the engine that stored the value verbatim, while every
        // structure the map is read beside is normalized: pending.validators (:697/:1235),
        // memberPubkeySet, resolveSenderPubkey, and PriceAggregator's verifier of the same
        // PRICE v0 proof. Hex decoding is case-insensitive, so a peer sending 'AB..' hex
        // verified and then took a SECOND map slot beside its own 'ab..' entry, duplicating
        // that validator in the sigsArray this hub publishes on the wire. (The weighted
        // tally itself is unaffected: swq.meetsStakeThreshold lowercases both sides and
        // dedupes by source, so no stake was ever mis-counted.) Normalizing in the helper,
        // not at the three callers, keeps the invariant for any future caller.
        pubkeyHex = String(pubkeyHex).toLowerCase();
        if (pending.signatures.has(pubkeyHex)) return false; // already collected
        if (pending.round === undefined || pending.round === null) {
            logger.warn('Oracle: cannot verify sig: pending round has no round number');
            return false;
        }
        try {
            // The ROUND's pinned admission map, never a freshly read one: every message of
            // one round must verify against the same heights, or two tip readings inside a
            // round would split the signatures over two canonicals.
            let payload = this.buildPriceV0Payload(pending.round, pending.btcBlockTime, pending.prices,
                                                    pending.btcBlockHeight, pending.admitBlocks);
            let ok = ValidatorIdentity.verify(payload, sigHex, pubkeyHex);
            if (ok) {
                pending.signatures.set(pubkeyHex, sigHex);
                return true;
            } else {
                logger.warn('Oracle: invalid PRICE v0 signature from ' + pubkeyHex.substring(0, 16) + '... for round ' + pending.round);
                return false;
            }
        } catch (e) {
            logger.warn(nodeUtil.format('Oracle: signature verification error:', e));
            return false;
        }
    }
};
