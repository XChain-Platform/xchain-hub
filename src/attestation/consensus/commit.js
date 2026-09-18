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
 * XChain Hub - Attestation Commit and Finalization
 *
 * The two quorum gates and what crossing the second one means: the COMMIT this
 * hub broadcasts once prepares are in, the VALID-signature count that finalizes
 * a round, and the event that hands the finalized response to the publisher.
 *
 ********************************************************************/

'use strict';
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ATTEST_COMMIT } = require('./constants.js');

const PENDING_EVICT_MS         = 10000;   // hold finalized state ~10s for late-arriving duplicates, then evict

module.exports = {

    checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || !pending.winner) return;
        if(pending._commitSent) return;

        let quorum = pending.quorum;
        // `pending.quorum` is the PBFT quorum computed INLINE in propose() over the
        // PRE-WIDENING responsible-set size (item 6490), NOT
        // CapabilitySnapshot.getQuorum() (which is scoped to the full snapshot
        // count and is deliberately not the source here). For very small
        // federations (e.g. a set of size <= 1) that inline value is 0;
        // collapse to REDUNDANCY in that case. Given the quorum <= redundancy
        // invariant documented in propose(), this max() always resolves to
        // redundancy: the effective gate is redundancy-of-redundancy.
        let needed = Math.max(quorum, pending.redundancy);

        if(pending.prepares.size >= needed){
            pending._commitSent = true;
            if(pending.myPubkey) pending.commits.add(pending.myPubkey);

            let mySig = pending.signatures.get(pending.myPubkey) || null;
            if(this.peerManager){
                this.broadcastWinnerVote(ATTEST_COMMIT, rid, pending, mySig);
            }
            this.checkCommitQuorum(rid);
        }
    },

    // A COMMIT that arrived before this round knew its winner. Membership is
    // still checked here (A-F5 parity), so an unauthenticated peer cannot grow
    // the buffer; the signature is re-checked on replay.
    holdPreWinnerCommit(pending, rid, envelope, d){
        // Winner not yet established (the PROPOSE->agree() transition is
        // async). Hold this COMMIT and replay it once the winner is set,
        // rather than dropping the peer's vote. See drainEarlyCommits.
        // Membership gate (A-F5 parity): pending.responsible is populated at
        // round start, before the winner, so apply the same responsible-set
        // check used post-winner (below) here too. This refuses to buffer
        // COMMITs from non-responsible peers, closing an unauthenticated
        // memory-amplification vector; buffered members are still re-checked
        // for a valid signature on replay.
        let earlySender = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.responsible.some(v => v.pubkey === earlySender)) return;
        this.bufferEarlyCommit(rid, envelope);
    },

    // A COMMIT this round can count: buffered before its round opens, held
    // before its winner is set, dropped from outside the responsible set.
    // Returns the parsed envelope and its round, or null when the caller stops.
    admittableCommit(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return null;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return null;
        let pending = this.pending.get(rid);
        if(!pending){
            this.bufferEarlyMessage(rid, envelope);
            return null;
        }
        if(!pending.winner){
            this.holdPreWinnerCommit(pending, rid, envelope, d);
            return null;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)) return null;
        return { d: d, rid: rid, pending: pending, senderPubkey: senderPubkey };
    },

    checkCommitQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        // As in checkPrepareQuorum: quorum <= redundancy by construction (see
        // propose()), so this max() always resolves to redundancy.
        let needed = Math.max(pending.quorum, pending.redundancy);
        // Gate on the number of VALID signatures over the canonical body, not on
        // raw participation (commits.size). A COMMIT vote is counted even when it
        // carries no verifying signature (null sig, or a sig over a divergent
        // body), so finalizing on commits.size would emit an on-chain response
        // with fewer signatures than REDUNDANCY, which the indexer
        // deterministically rejects. Requiring `needed` signatures guarantees the
        // emitted response is on-chain-fulfillable; rounds that can't reach it
        // (genuine divergence under byte_equality) correctly fall through to
        // deadline expiry instead of dead-lettering a doomed payload every cycle.
        if(pending.signatures.size < needed) return;

        pending.finalized = true;
        this.settleFinalizedRound(rid, pending);

        // We need at least max(REDUNDANCY, quorum) sigs on the on-chain response.
        let sigsArray = [];
        for(let [pk, sg] of pending.signatures){
            sigsArray.push({ pubkey: pk, sig: sg });
        }

        logger.info('AttestationConsensus: finalized ' + rid.substring(0,16) + '... (' +
                    pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits, ' +
                    sigsArray.length + ' sigs)');
        this.emitFinalized(rid, pending, sigsArray);

        this.earlyCommits.delete(rid);
        let evictTimer = setTimeout(() => this.pending.delete(rid), PENDING_EVICT_MS);
        if (evictTimer.unref) evictTimer.unref();  // housekeeping timer; never pin process liveness
    },

    // Terminal bookkeeping for a finalized round, which differs by outcome: an
    // ok round is terminal on the hub, a non-ok one stays retryable and must
    // leave nothing behind for the retry to replay.
    settleFinalizedRound(rid, pending){
        if(pending.status === 'ok'){
            // Terminal on the hub: the indexer flips the request to fulfilled.
            this.markFinalized(rid);
        } else {
            // Non-ok statuses are RETRYABLE on the indexer (the request stays
            // pending), so the rid must NOT enter `finalized` or no retry round
            // could ever start. Record the publication instead so retries stop
            // re-publishing the same failure (once per request_id + status).
            this.recordNonOkPublished(rid, pending.status);
            // This teardown path does not enter `this.finalized`, so clear the
            // early-message buffer and suppress post-teardown buffering to stop a
            // retry round replaying this attempt's stale PBFT votes (item 2640).
            this.earlyMessages.delete(rid);
            this.earlyMessageTtl.delete(rid);
            this.markTornDown(rid);
        }
        if(pending.timer) clearTimeout(pending.timer);
    },

    // Hand the finalized response to AttestationPublisher. Every field the
    // signatures cover travels with them, because a consumer that recomputed
    // one would store bytes no signature verifies over.
    emitFinalized(rid, pending, sigsArray){
        // Emit for AttestationPublisher to broadcast on-chain. Only the leader
        // actually broadcasts the response tx; followers' publishers are no-ops
        // for this request (publisher checks role).
        this.emit('request:finalized', {
            requestId:    rid,
            request:      pending.request,
            providerId:   pending.providerId,
            responseBody: pending.winner.body,
            meta:         pending.winner.meta,
            status:       pending.status,
            signatures:   sigsArray,
            leaderPubkey: pending.leaderPubkey,
            role:         pending.role,
            // The stamp the signatures above actually cover, or null in the legacy
            // era. The mirror row is not re-derivable without it: a consumer that
            // recomputed `now + margin` at write time would store a value no
            // signature covers, and every indexer would skip the row.
            effectiveTime: pending.effectiveTime == null ? null : pending.effectiveTime,
            // The admission map the signatures cover, for the same reason: the mirror row
            // stores it verbatim and every verifier rebuilds the canonical from the stored
            // column, so a consumer that re-read a tip at write time would store heights no
            // signature covers. Null in the legacy era.
            admitBlocks:  pending.admitBlocks == null ? null : pending.admitBlocks,
            // Extra responsible slots the liveness ladder granted this round
            // (attest_responsible_widening_gate.js). Derived from the set consensus actually
            // ran, not recomputed, so the publisher's failover rank is ordered over the
            // SAME membership that signed. 0 below the flag-day, and an older queue entry
            // carrying no field reads as 0, which is the pre-widening ordering.
            widen:        Math.max(0, (Array.isArray(pending.responsible) ? pending.responsible.length : 0)
                                      - Math.max(1, Number(pending.redundancy) || 1))
        });
    }

};
