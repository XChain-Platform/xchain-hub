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
 * XChain Hub - Attestation Co-Signing Rules
 *
 * When this hub may put its own signature on a winner it did not fetch byte
 * for byte, and the one echo that makes such a signature count. The signing
 * itself stays in consensus.js beside every other canonical build; what lives
 * here is each rule's evidence test, so a rule and its reason read together.
 *
 ********************************************************************/

'use strict';
const crypto            = require('crypto');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ATTEST_PREPARE } = require('./constants.js');

module.exports = {

    // judge_model is a SEMANTIC consensus: each responsible validator runs
    // its own model call and produces a byte-divergent body that the judge
    // deems equivalent, then selects ONE as canonical. The match-based sig
    // collection in collectWinnerSignatures therefore captures at most the
    // single validator whose body happened to be chosen. Every other
    // responsible validator contributes nothing, so an N>=3 round would finalize with one
    // signature and the on-chain response would be rejected (it requires
    // REDUNDANCY signatures over the single canonical body). Re-sign the
    // canonical winner here so THIS validator vouches for the agreed bytes.
    // Only validators that actually produced a proposal (did the work) sign.
    // "Did the work" means a non-empty ok body, NOT merely having an entry in
    // pending.proposals: a failed own fetch also lands there as an error
    // proposal ({body: empty, status: 'provider_error'}). Without this guard a
    // judge_model leader whose own fetch failed would re-sign a winner body it
    // never fetched or evaluated, and that improper vote is exactly the one
    // that pushes signatures.size to REDUNDANCY, finalizing 'ok' with only
    // REDUNDANCY-1 genuine attestations. Mirrors the follower abstention in
    // _onPrepare (no own non-empty body -> do not co-sign); fails safe (the
    // round times out / retries) rather than open.
    judgeReSignEligible(rid, pending){
        let strategy = pending.pinnedConsensusStrategy;
        if(!(strategy === 'judge_model' && pending.myPubkey && pending.proposals.has(pending.myPubkey))) return false;
        let myP = pending.proposals.get(pending.myPubkey);
        let myBodyOk = myP && myP.body && myP.body.length > 0 && (myP.status || 'ok') === 'ok';
        if(!myBodyOk){
            logger.warn('AttestationConsensus: leader abstaining from judge_model re-sign for ' + rid +
                ' (no own non-empty ok body fetched; will not vouch for a winner it never evaluated)');
            return false;
        }
        return true;
    },

    // MIRROR ERA, byte_equality: the same repair the judge_model rule above
    // performs, for the reason that only exists in this era. Our own PROPOSE
    // signature covered OUR candidate stamp, and the round settled on the
    // leader's, so the sweep could not transfer it even though our body is
    // byte-identical to the winner. Without a re-sign this hub broadcasts a
    // PREPARE carrying no signature of its own and contributes nothing to a
    // round it fully agrees with, and a three-hub round tops out one signature
    // short of redundancy and expires.
    //
    // The gate is byte_equality's own safety rule, unchanged: sign only if our
    // independently-fetched body IS the winner. A divergence still abstains.
    // Legacy-era rounds never enter here, so their signature sets are untouched.
    mirrorReSignEligible(pending, winner, winnerHash){
        let strategy = pending.pinnedConsensusStrategy;
        if(!(pending.mirrorEra && strategy !== 'judge_model' && pending.myPubkey
           && !pending.signatures.has(pending.myPubkey) && pending.proposals.has(pending.myPubkey))) return false;
        let myP = pending.proposals.get(pending.myPubkey);
        let myMatches = myP && (myP.status || 'ok') === 'ok' && myP.meta === winner.meta
            && Buffer.compare(crypto.createHash('sha256').update(myP.body).digest(), winnerHash) === 0;
        return !!myMatches;
    },

    // Co-sign policy: only vouch for a failure mode we can stand
    // behind ourselves.
    //   provider_error - our own fetch must ALSO have failed. A hub
    //                    whose fetch succeeded has direct evidence the
    //                    provider is up and abstains.
    //   no_quorum      - we participated (produced a proposal) but no
    //                    equivalence verdict is checkable by a
    //                    follower (only the leader runs the judge), so
    //                    participation is the strongest local check.
    mayCoSignNonOk(myProposal, status){
        // Require the claimed status to match the failure mode THIS hub
        // itself observed, not merely that our own fetch failed. For
        // provider_error that means our own proposal is provider_error too
        // (a hub that saw a different failure mode must abstain rather than
        // vouch for a status it did not derive).
        return !!myProposal && (
            status === 'no_quorum'
            || (status === 'provider_error' && (myProposal.status || 'ok') === 'provider_error')
        );
    },

    // Liveness guard (item 5314): a follower re-signs the leader's
    // chosen body only after verifying the leader's Ed25519 sig, so it
    // never re-judges (LLM non-determinism makes that infeasible; the
    // AttestationSpotChecker audits divergence instead). At minimum it
    // must have independently fetched a NON-EMPTY body of its own for
    // this request. If its own fetch failed it abstains rather than
    // vouching for bytes it never evaluated; the round still reaches
    // quorum via other validators or correctly times out.
    judgeCoSignEligible(rid, myProposal){
        let ownBody = myProposal.body;
        if(!ownBody || ownBody.length === 0){
            logger.warn('AttestationConsensus: abstaining from judge_model PREPARE for ' + rid + ' (no own non-empty body fetched; will not co-sign leader winner)');
            return false;
        }
        return true;
    },

    // byte_equality's safety rule: our independently-fetched body and meta ARE
    // the winner's, compared by body hash.
    ownBodyMatchesWinner(body, meta, myProposal){
        let winnerHash = crypto.createHash('sha256').update(body).digest();
        let myHash     = crypto.createHash('sha256').update(myProposal.body).digest();
        return Buffer.compare(winnerHash, myHash) === 0 && myProposal.meta === meta;
    },

    // The bounds guard on a leader-chosen stamp, run immediately after the
    // signature verify. True (and logged) when the stamp must be rejected.
    wireEffectiveOutOfWindow(wireEffective, label, senderPubkey, rid){
        if(wireEffective === null || this.effectiveTimeWithinFollowerWindow(wireEffective)) return false;
        logger.warn('AttestationConsensus: ' + label + ' effective_time ' + wireEffective + ' out of window from ' +
            senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
        return true;
    },

    // Re-broadcast this hub's endorsing PREPARE over an adopted winner and count
    // its own prepare. Each caller reaches it at most once per round, on first
    // adoption; a missing signature or an offline hub sends nothing.
    echoAdoptedPrepare(rid, pending, sig){
        if(!sig || !this.peerManager) return;
        this.broadcastWinnerVote(ATTEST_PREPARE, rid, pending, sig);
        pending.prepares.add(pending.myPubkey);
    }

};
