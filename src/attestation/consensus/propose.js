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
 * XChain Hub - Attestation Round Opening
 *
 * Everything around this hub's own proposal: whether a round may be opened at
 * all, the pinned state it opens with, the timer that tears it down, and what
 * happens to a peer's PROPOSE once its signature has verified.
 *
 ********************************************************************/

'use strict';
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
// Body-size ceiling every proposed/signed response must clear, leader and
// follower alike (spec §5.3, D40/D41, row 9). Applies in both canonical eras.
const { ATTEST_RESPONSE_BODY_MAX_BYTES, bodyByteLength, assertBodyWithinCap } = require('../attest_response_body_cap.js');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ATTEST_PROPOSE } = require('./constants.js');

module.exports = {

    // Premature-eviction proof. Reaching here for a rid this hub already
    // ok-finalized and then evicted means the indexer still listed the request
    // as pending after the ring dropped it, i.e. ATTESTATION_FINALIZED_MAX sits
    // below the sizing invariant in initRoundRings. The round propose() opens will
    // re-publish an already-fulfilled response and burn a BTC tx, so count and
    // warn: the cap is the cause and nothing else names it. Observation only,
    // never a gate - a reorg that rolled the fulfillment back also arrives here
    // legitimately, and refusing the round would strand that request until its
    // deadline. The tombstone is left in place: if this round finalizes ok the
    // rid re-enters `finalized` and propose()'s finalized guard suppresses the next poll,
    // and if it does not, the next poll's fee is real and worth warning about
    // again.
    notePrematureEviction(rid){
        if(this._finalizedEvicted.has(rid)){
            this.finalizedEvictedWhilePendingCount++;
            logger.warn('AttestationConsensus: re-proposing request ' + rid.substring(0,16) +
                '... whose finalized entry was already evicted (ring full at ' + this.finalizedMax +
                '; raise ATTESTATION_FINALIZED_MAX; evictions_while_pending=' +
                this.finalizedEvictedWhilePendingCount + ')');
        }
    },

    // This hub's own proposal and the era the WHOLE round runs in, both read
    // once at proposal time.
    ownProposalFields(roundState){
        let myPubkey  = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let myBody    = roundState.myProposal.body;
        let myMeta    = roundState.myProposal.meta;
        // A failed fetch proposes status='provider_error' with an empty body
        // (see AttestationRound); the canonical binds the status, so the sig
        // is only ever valid for the outcome the proposer actually observed.
        let myStatus  = roundState.myProposal.status || 'ok';
        // Era selection for the WHOLE round, decided once from the request's own
        // block. Every canonical built for the round reads these two fields rather
        // than re-evaluating the activation, so a round cannot straddle the height even
        // if the fleet crosses it mid-round.
        let requestBlock  = Number(roundState.request.block_index);
        let mirrorEra     = this._isMirrorEra(requestBlock);
        // This hub's candidate stamp, picked here at proposal time. It is the
        // ROUND's effective time only if this hub is the elected leader; every hub
        // settles on the leader's in resolveRoundEffectiveTime. Picking one
        // regardless is what lets any responsible hub lead without a second round
        // trip, and it is the value this hub's own PROPOSE signature covers.
        let myEffective   = mirrorEra ? this.chooseEffectiveTime() : null;
        return { myPubkey: myPubkey, myBody: myBody, myMeta: myMeta, myStatus: myStatus,
            requestBlock: requestBlock, mirrorEra: mirrorEra, myEffective: myEffective };
    },

    // The PBFT quorum for this round, or null when the round could never
    // finalize and this hub must not open it at all.
    admittableQuorum(rid, roundState){
        // PBFT messages (PROPOSE/PREPARE/COMMIT) only flow within the
        // REDUNDANCY-sized responsible set, so prepares/commits are bounded by
        // responsible.length (NOT the full attestation-validator count N).
        // Compute the quorum over the responsible set; computing it over N
        // would make the threshold unreachable whenever N > REDUNDANCY and
        // deadlock every round until timeout. The 2f+1 form is floored at a
        // simple majority (bare 2f+1 degenerates to quorum=1 at size 3).
        // INVARIANT (item 6490): quorum <= redundancy, held by measuring the
        // PRE-WIDENING set size rather than responsible.length. AttestationRound
        // now builds the set as slice(0, max(1, redundancy) + widen) with widen up
        // to ATTEST_RESPONSIBLE_WIDENING.maxSlots, and above ATTEST_ZERO_CONF_ACTIVATION
        // up to ATTEST_RESPONSIBLE_WIDENING_V2.headroom + .maxSlots, a max of 3 and
        // nonzero from the request's own block, so bftQuorum over the widened
        // length exceeds redundancy for small redundancies (redundancy 1, widen 1
        // -> bftQuorum(2) = 2), which would raise the finalization bar in exactly
        // the rounds the liveness ladder fires for and make it tip-dependent per
        // hub. Clamping to max(1, redundancy) keeps max(quorum, redundancy) at
        // redundancy, which is the bar the indexer verifies against
        // (xchain-indexer/src/actions/attest/attest_response_verify.js) and the contract the
        // ladder states (attest_responsible_widening_activation.js: widening grows
        // the pool permitted to sign, never the count required to finalize).
        // `quorum` is retained as PBFT scaffolding (and to document intent) but
        // never sets the gate today. Do NOT wire it into a new path expecting it
        // to bind without first re-checking this invariant.
        let responsible = roundState.responsible || [];
        // Measure the quorum over the unwidened set size (0 when size <= 1), so
        // extra liveness-ladder slots cannot move the finalization threshold.
        let baseSize    = Math.min(responsible.length, Math.max(1, Number(roundState.redundancy) || 0));
        let quorum      = bftQuorumOrSingle(baseSize, 0);
        // Unfinalizable-round guard. The finalization gates require
        // max(quorum, redundancy) VALID signatures, and signatures can only ever
        // come from responsible-set members (_handleCommit rejects non-members).
        // When the block-anchored snapshot or weighted source-dedup shrinks the
        // responsible set below that threshold (AttestationRound._computeResponsibleSet
        // slices to max(1, redundancy) + widen and can return fewer), signatures.size can
        // never reach `needed`: every PROPOSE/PREPARE/COMMIT cycle stalls to
        // timeout, including the non-ok outcome paths. Do NOT lower the gates to
        // responsible.length here: the indexer deterministically rejects any
        // payload carrying fewer than `redundancy` valid signatures, so a relaxed
        // gate would publish rows the indexer discards. Skip round admission
        // instead and let the request reach its normal deadline expiry + refund.
        let needed = Math.max(quorum, roundState.redundancy);
        if(responsible.length < needed){
            logger.warn('AttestationConsensus: skipping unfinalizable round for ' + rid.substring(0,16) +
                '... (responsible=' + responsible.length + ' < needed=' + needed +
                '; quorum=' + quorum + ' redundancy=' + roundState.redundancy + ')');
            return null;
        }
        return quorum;
    },

    // Install the round: this hub's own proposal, the teardown timer, and the
    // PROPOSE that tells the responsible set what it fetched.
    openRound(rid, roundState, my){
        let { quorum, myPubkey, myBody, myMeta, myStatus, mirrorEra, myEffective, myAdmit, mySig } = my;
        // LEADER gate (spec §5.3, D40/D41, row 9): refuse to propose a body over
        // ATTEST_RESPONSE_BODY_MAX_BYTES rather than let it finalize and die at the
        // publisher's post-finalization wire check (AttestationPublisher.js:319-324).
        // Scoped to THIS hub's own candidate only, not the whole round: a peer's body
        // may still be within cap, so this hub still opens the round below and can
        // sign for a peer's in-cap proposal even though it has none of its own to
        // offer.
        let myBodyOverCap = !!myBody && !assertBodyWithinCap(myBody);
        if(myBodyOverCap){
            this.bodyOverCapRejectCount++;
            logger.warn('AttestationConsensus: refusing to propose ' + rid.substring(0,16) +
                '... (own body is ' + bodyByteLength(myBody) + ' bytes, over ATTEST_RESPONSE_BODY_MAX_BYTES=' +
                ATTEST_RESPONSE_BODY_MAX_BYTES + '; request is not proposable by this hub)');
        }
        let pending = this.buildPendingRound(rid, roundState, my);

        if(myPubkey && myBody && mySig && !myBodyOverCap){
            pending.proposals.set(myPubkey, { body: myBody, meta: myMeta, sig: mySig, status: myStatus, effectiveTime: myEffective });
            // Same record the wire path keeps for peers, so this hub never proves
            // ITSELF silent as leader on a retry round after its own round timed out.
            this.recordProposer(rid, myPubkey);
        }
        pending.timer = this.armRoundTimeout(rid, pending);

        // A fresh round for this rid is opening; allow its envelopes to buffer
        // again after any prior torn-down attempt (item 2640).
        this.tornDown.delete(rid);
        this.pending.set(rid, pending);

        if(this.peerManager && !myBodyOverCap){
            this.peerManager.broadcast(ATTEST_PROPOSE, {
                requestId:  rid,
                providerId: pending.providerId,
                body_b64:   myBody ? myBody.toString('base64') : '',
                meta:       String(myMeta || ''),
                status:     myStatus,
                sig_pubkey: myPubkey,
                sig:        mySig,
                ...this.effectiveTimeWireFields(pending)
            });
        }
        // Replay messages that arrived before our round was set up. With
        // staggered hub polls, the first proposer's PROPOSE typically lands
        // before peers create their pending entry; without this drain,
        // _handlePropose's `if(!pending) return` loses those votes.
        this.drainEarlyMessages(rid);

        // For single-validator stacks (N=1) we already have everything we need
        this.maybeAdvanceFromProposals(rid).catch(e =>
            logger.error('AttestationConsensus: advance error for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e)));
    },

    // The round's terminal backstop. A round that reaches it is torn down
    // WITHOUT ever entering `finalized`, which is what markTornDown then has to
    // tell the early buffer (item 2640).
    armRoundTimeout(rid, pending){
        return setTimeout(() => {
            if(!pending.finalized){
                logger.warn('AttestationConsensus: round timeout for ' + rid.substring(0,16) + '...');
                // Count before teardown so the metric rail carries the quorum
                // loss even when the warn above is never scraped (item 8c1148c0).
                this.roundTimeoutCount++;
                this.pending.delete(rid);
                this.earlyCommits.delete(rid);
                // Clear the early-message buffer and suppress post-teardown
                // buffering so a retry round cannot replay this attempt's stale
                // PBFT envelopes (item 2640).
                this.earlyMessages.delete(rid);
                this.earlyMessageTtl.delete(rid);
                this.markTornDown(rid);
            }
        }, this.roundTimeoutMs);
    },

    // The per-request state every handler for this rid reads. Assembled once,
    // here, so no two messages of one round can answer to different values.
    buildPendingRound(rid, roundState, my){
        let { quorum, myPubkey, mirrorEra, myEffective, myAdmit } = my;
        let snapshot = roundState.snapshot;
        return {
            requestId:    rid,
            request:      roundState.request,
            // Mirror-era gate and the round's currently-settled effective_time.
            // Held on `pending` so every handler for this rid reads one decision.
            mirrorEra:    mirrorEra,
            effectiveTime: myEffective,
            providerId:   roundState.providerId,
            redundancy:   roundState.redundancy,
            snapshot:     snapshot,
            quorum:       quorum,
            responsible:  roundState.responsible,
            leaderPubkey: roundState.leaderPubkey,
            role:         roundState.role,
            myPubkey:     myPubkey,
            // Map<pubkey, { body, meta, sig }>
            proposals:    new Map(),
            // Set<pubkey>: PREPARE/COMMIT votes (track by pubkey, not addr,
            // because attestation responsibility is pubkey-scoped)
            prepares:     new Set(),
            commits:      new Set(),
            // Map<pubkey, sig over canonical(winning body)>
            signatures:   new Map(),
            // Set once provider.agree() picks a winner from accumulated proposals
            winner:       null,
            status:       'ok',
            ...this.pinnedRoundFields(roundState),
            finalized:    false,
            // The round's admission map, pinned at proposal time above. Every canonical
            // built for this rid reads it through _roundAdmitBlocks, so no two messages
            // of one round can carry heights from two different tip readings.
            admitBlocks:  myAdmit,
            timer:        null
        };
    },

    // The values this round is pinned to for its whole life. Every one was
    // resolved at the request's own block by AttestationRound; reading any of
    // them live would let a governance reload move them mid-round.
    pinnedRoundFields(roundState){
        return {
            // Model identity snapshotted by AttestationRound at round start (Phase
            // 2: block-anchored at the request's block). Threaded into the leader's
            // provider.agree() call so the judge model cannot drift mid-round via a
            // governance hotReload of the module-mutable JUDGE_MODEL.
            pinnedJudgeModel: roundState.pinnedJudgeModel || null,
            // Block-anchored model->vendor map from the same config that pinned the
            // judge model, so the judge's vendor is not resolved from this hub's
            // live hotReloaded map while the id came from the block (item 3482).
            pinnedVendors: roundState.pinnedVendors || null,
            // Block-anchored approved_models from that same config, so the meta
            // allowlist gate judges against the set the fetch model was pinned
            // from rather than this hub's live one. Without it a
            // governance delisting of the pinned model froze the round at
            // no_quorum forever, since every retry re-pinned the same model.
            pinnedApprovedModels: roundState.pinnedApprovedModels || null,
            // Block-anchored PBFT strategy for this round. Every consensus_strategy
            // decision below reads THIS and never providerRegistry.getDef(): the registry
            // is re-parsed from the local configs table on every proposal:finalized
            // hotReload, so a live read could flip this hub's state machine between two
            // messages of one round, and two hubs whose reloads raced could run different
            // machines against the same request. AttestationRound resolves it once at the
            // request's own block and fails the round closed when it cannot.
            pinnedConsensusStrategy: roundState.pinnedConsensusStrategy || null,
            // Inbound body-size gate for this round's lifetime, derived from the
            // max_response_bytes AttestationRound already read to bound its own
            // fetch. Pinning it here is what keeps the gate consistent with the
            // bytes this hub itself proposed; see bodyB64Limit. Null when the
            // round state carries no cap (legacy/synthetic round states), which
            // leaves the live per-message read in place.
            maxBodyB64Length: Number(roundState.pinnedMaxResponseBytes) > 0
                ? Math.ceil(Number(roundState.pinnedMaxResponseBytes) * 1.4)
                : null,
        };
    },

    // A PROPOSE this round may verify: buffered when its round has not opened
    // yet, dropped from outside the responsible set or over the wire caps.
    // Returns the parsed envelope and its round, or null when the caller stops.
    admittablePropose(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return null;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return null;
        let pending = this.pending.get(rid);
        if(!pending){
            // Round not started yet; buffer for drain in propose(). Without
            // this, the first proposer's PROPOSE is lost to peers whose
            // _startRound hasn't run yet, and PBFT can't reach 2f+1.
            this.bufferEarlyMessage(rid, envelope);
            return null;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!senderPubkey) return null;

        // Sender must be in the responsible set for this request
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)){
            return null;  // Outsider proposal; ignore
        }

        if(!this.envelopeWithinCaps(pending, d, 'PROPOSE', senderPubkey, rid)) return null;
        return { d: d, rid: rid, pending: pending, senderPubkey: senderPubkey };
    },

    // A PROPOSE whose signature has verified over its sender's own canonical:
    // bound its stamp, measure its decoded body, and record the vote.
    admitVerifiedProposal(pending, rid, d, body, meta, senderPubkey, wireEffective){
        // Bound it here as well as at the PREPARE adoption sites, because the
        // ELECTED LEADER's proposal is where resolveRoundEffectiveTime takes the
        // round's stamp from: an unbounded value reaching that resolver would be a
        // leader-chosen field adopted without ever having been checked. An honest
        // proposal is inside the window by construction, so this refuses only a
        // misconfigured or hostile proposer, and refusing the whole proposal (rather
        // than just the field) keeps `proposals` free of entries whose stamp the
        // resolver would have to re-screen.
        if(wireEffective !== null && !this.effectiveTimeWithinFollowerWindow(wireEffective)){
            logger.warn('AttestationConsensus: PROPOSE effective_time ' + wireEffective + ' out of window from ' +
                senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }

        // FOLLOWER gate (spec §5.3, D40/D41, row 9). Measured on the DECODED body,
        // not the base64 wire form the pre-decode length check above bounds: a
        // proposal that never enters `pending.proposals` can never be selected as
        // the round's winner and therefore can never be co-signed in a PREPARE, so
        // this is the point that keeps this hub from ever signing for it.
        if(!assertBodyWithinCap(body)){
            this.bodyOverCapRejectCount++;
            logger.warn('AttestationConsensus: oversized PROPOSE body (decoded ' + bodyByteLength(body) +
                ' bytes, over ATTEST_RESPONSE_BODY_MAX_BYTES=' + ATTEST_RESPONSE_BODY_MAX_BYTES + ') from ' +
                senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }

        // This member has now spoken for this request. Recorded outside `pending`
        // so it survives the round teardown a timeout performs, and recorded even
        // when the proposal itself is a duplicate: the leader-rotation question is
        // whether the slot answered at all, not how many times.
        this.recordProposer(rid, senderPubkey);

        // Store (idempotent; dedup by sender pubkey). Status is trusted only
        // because the sig was just verified over a canonical that binds it.
        if(!pending.proposals.has(senderPubkey)){
            pending.proposals.set(senderPubkey, { body: body, meta: meta, sig: String(d.sig), status: String(d.status || 'ok'), effectiveTime: wireEffective });
            // A-F1 liveness: a judge_model leader PREPARE that arrived before this
            // follower had collected `need` proposals was buffered (see
            // handlePrepare) so it could be hash-checked against real proposals
            // instead of adopted on faith. Nothing else replays that buffer before
            // a winner exists, so drain it here the moment the proposal count
            // crosses the check threshold; a still-early replay just re-buffers.
            let need = Math.min(pending.redundancy, pending.responsible.length);
            if(!pending.winner && pending.proposals.size >= need) this.drainEarlyMessages(rid);
        }

        this.maybeAdvanceFromProposals(rid).catch(e =>
            logger.error('AttestationConsensus: advance error for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e)));
    }

};
