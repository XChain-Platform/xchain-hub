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
 * XChain Hub - Attestation Consensus
 *
 * PBFT consensus for attestation rounds. Each round is keyed by request_id
 * (not a round number). The flow:
 *
 *   AttestationRound.propose(requestId, roundState)
 *     -> if I'm responsible, broadcast ATTEST_PROPOSE with my fetched body
 *   ATTEST_PROPOSE handler
 *     -> collect proposals; once REDUNDANCY are in (or timeout), run
 *        provider.agree(proposals) -> winner. Sign canonical bytes for the
 *        winner. Broadcast ATTEST_PREPARE.
 *   ATTEST_PREPARE handler
 *     -> collect prepares; finalize on max(quorum, REDUNDANCY). The PBFT quorum
 *        (max(2f+1, ceil((N+1)/2)) over the responsible set, size=REDUNDANCY) is
 *        provably <= REDUNDANCY by construction, so REDUNDANCY is the binding
 *        threshold in every reachable case; the 2f+1/majority form is retained as
 *        scaffolding but is currently dominated (see the invariant in propose()).
 *        Broadcast ATTEST_COMMIT.
 *   ATTEST_COMMIT handler
 *     -> collect commits; on quorum, emit 'request:finalized' for the
 *        publisher to ship the on-chain ATTEST v1 (response).
 *
 * Validator-set snapshot is locked at the request's block_index via
 * CapabilitySnapshot: every hub derives the same responsible set (and thus
 * the same PBFT quorum over it) for the round.
 *
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const ValidatorIdentity = require('../validators/identity.js');
const ah                = require('../lib/admission_height.js');
const { getLogger } = require('../observability');
const logger = getLogger();
// The parts this class is assembled from. Each exports plain methods that are
// installed on the prototype below, so a caller, a stub or a walk over an
// instance sees exactly the class it saw before the split. What stays HERE is
// every site that builds or signs a round's canonical bytes, kept in one file
// because the era argument they all pass is the thing a new call site is most
// likely to forget (test/unit/attest_response_canonical_era.test.js reads them).
const { ATTEST_PROPOSE, ATTEST_PREPARE, ATTEST_COMMIT } = require('./consensus/constants.js');
const options       = require('./consensus/options.js');
const lifecycle     = require('./consensus/lifecycle.js');
const roundRecords  = require('./consensus/round_records.js');
const earlyBuffer   = require('./consensus/early_buffer.js');
const wire          = require('./consensus/wire.js');
const canonical     = require('./consensus/canonical.js');
const effectiveTime = require('./consensus/effective_time.js');
const proposeRound  = require('./consensus/propose.js');
const advance       = require('./consensus/advance.js');
const prepare       = require('./consensus/prepare.js');
const commit        = require('./consensus/commit.js');
const coSign        = require('./consensus/co_sign.js');

class AttestationConsensus extends EventEmitter {

    constructor(hub, providerRegistry){
        super();
        this.hub              = hub;
        this.peerManager      = hub.getPeerManager();
        this.db               = hub.db;
        this.identity         = hub.getIdentity ? hub.getIdentity() : null;
        this.providerRegistry = providerRegistry;
        this.config           = hub.p2pConfig || {};
        this.initRoundRings();
        this.initNonOkThrottle();
        this.initRoundCounters();
        this.initEarlyBuffers();
        this.initTeardownRecords();
    }

    // Registered here, in the file that exports the class, because the listener
    // ceiling reads 'message' subscribers by the class their file exports.
    async start(){
        if(!this.peerManager){
            logger.info('AttestationConsensus: no peer manager; skipping start');
            return;
        }
        this._messageHandler = (env) => this._handleMessage(env);
        this.peerManager.on('message', this._messageHandler);
        this.checkNonOkSizingFloor();
        logger.info('AttestationConsensus: started');
    }

    // Called by AttestationRound after it fetches the body for a request.
    // Initializes the per-request state, captures the locked validator-set
    // snapshot + PBFT quorum, signs the canonical bytes for our own body,
    // and gossips ATTEST_PROPOSE.
    async propose(requestId, roundState){
        let rid = String(requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        if(this.pending.has(rid)) return;
        this.notePrematureEviction(rid);
        let quorum = this.admittableQuorum(rid, roundState);
        if(quorum === null) return;

        let { myPubkey, myBody, myMeta, myStatus, requestBlock, mirrorEra, myEffective } = this.ownProposalFields(roundState);
        // The ADMISSION map for this round, resolved once here for the same reason
        // myEffective is: every canonical below reads the round's stored value rather
        // than re-resolving a tip that moves under it. An attest response is read by
        // BTC alone (the indexer's call-site guard), so the map has one entry.
        //
        // C4, and it is a refusal to OPEN the round rather than a guess: with no fresh
        // BTC admission tip this hub cannot justify an admission height, and a guessed
        // one forks the federation while a refusal stalls this one rail and says so.
        let myAdmit = null;
        if(ah.isAdmissionEra(this.hub && this.hub.network, requestBlock)){
            myAdmit = await this.resolveRoundAdmitBlocks();
            if(!myAdmit){
                logger.error('AttestationConsensus: refusing to open round ' + rid.substring(0,16) +
                    '... at block ' + requestBlock + '; no fresh BTC admission tip to stamp an admission height from');
                return;
            }
        }
        let mySig     = this.signCanonical(rid, roundState.providerId, myBody, myStatus, myMeta, requestBlock, myEffective, myAdmit);
        this.openRound(rid, roundState, { quorum: quorum, myPubkey: myPubkey, myBody: myBody, myMeta: myMeta,
            myStatus: myStatus, mirrorEra: mirrorEra, myEffective: myEffective, myAdmit: myAdmit, mySig: mySig });
    }

    _handlePropose(envelope){
        let admitted = this.admittablePropose(envelope);
        if(!admitted) return;
        let { d, rid, pending, senderPubkey } = admitted;

        // Decode body and verify signature against canonical bytes
        let body;
        try {
            body = Buffer.from(String(d.body_b64 || ''), 'base64');
        } catch (_) { return; }
        let meta = String(d.meta || '');
        // Mirror era: the proposer signed over ITS OWN stamp, so the canonical that
        // verifies its signature is built from the wire value, not from this hub's.
        // Spelling guard first (see readWireEffectiveTime).
        let wireEffective = this.readWireEffectiveTime(pending, d, 'PROPOSE', senderPubkey, rid);
        if(wireEffective === undefined) return;
        let canonical = this._buildCanonical(rid, pending.providerId, body, String(d.status || 'ok'), meta, Number(pending.request.block_index), wireEffective);
        if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig || ''), senderPubkey)){
            logger.warn('AttestationConsensus: bad PROPOSE sig from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '...');
            return;
        }
        this.admitVerifiedProposal(pending, rid, d, body, meta, senderPubkey, wireEffective);
    }

    // Walk back through the proposals and collect any sigs that match the winner.
    // Proposals that diverge from the winner are slash candidates for
    // byte_equality providers (e.g. http_get). For judge_model the
    // winner is one of many semantically-equivalent candidates, so
    // non-match doesn't imply wrong.
    collectWinnerSignatures(rid, pending, winner){
        let winnerHash = crypto.createHash('sha256').update(winner.body).digest();
        let winnerHashHex = winnerHash.toString('hex');
        let strategy = pending.pinnedConsensusStrategy;
        // The canonical the on-chain verifier reconstructs binds `status` (hardcoded
        // 'ok' for a winner), but a proposal stores only {body, meta, sig} and its sig
        // was verified in _handlePropose over the sender's own wire status. A proposer
        // can match the winner body+meta yet have signed over status='fail', so its sig
        // does NOT verify over the winner canonical. Re-verify here before counting it,
        // mirroring handlePrepare (614) and _handleCommit; an unverifiable sig inflates
        // signatures.size and the indexer would deterministically reject the response.
        let winnerCanonical = this._buildCanonical(rid, pending.providerId, winner.body, pending.status, winner.meta, Number(pending.request.block_index), pending.effectiveTime).toString('utf8');
        for(let [pubkey, p] of pending.proposals){
            let pHash = crypto.createHash('sha256').update(p.body).digest();
            let matchesWinner = (Buffer.compare(pHash, winnerHash) === 0 && p.meta === winner.meta);
            if(matchesWinner && ValidatorIdentity.verify(winnerCanonical, String(p.sig), pubkey)){
                pending.signatures.set(pubkey, p.sig);
            } else {
                this.noteUncountedProposal(rid, pending, pubkey, p, matchesWinner, pHash, winnerHashHex, strategy);
            }
        }
        return winnerHash;
    }

    // judge_model: re-sign the canonical winner so THIS validator vouches for
    // the agreed bytes (why, and when it abstains: judgeReSignEligible).
    resignJudgeWinner(rid, pending, winner){
        if(!this.judgeReSignEligible(rid, pending)) return;
        let reSig = this.signCanonical(rid, pending.providerId, winner.body, pending.status, winner.meta, Number(pending.request.block_index), pending.effectiveTime);
        if(reSig) pending.signatures.set(pending.myPubkey, reSig);
    }

    // MIRROR ERA, byte_equality: re-sign a winner our own PROPOSE signature
    // could not cover (why, and the gate: mirrorReSignEligible).
    resignMirrorWinner(rid, pending, winner, winnerHash){
        if(!this.mirrorReSignEligible(pending, winner, winnerHash)) return;
        let reSig = this.signCanonical(rid, pending.providerId, winner.body, pending.status, winner.meta, Number(pending.request.block_index), pending.effectiveTime);
        if(reSig) pending.signatures.set(pending.myPubkey, reSig);
    }

    // Establish a NON-OK round outcome (Phase 4; the statuses and why they
    // converge: adoptNonOkWinner), then sign and broadcast it like an ok winner.
    establishNonOkWinner(rid, status){
        let pending = this.adoptNonOkWinner(rid, status);
        if(!pending) return;

        // Error PROPOSEs were signed over this exact canonical (empty body,
        // empty meta, same status), so their sigs transfer directly - in the LEGACY
        // era. In the mirror era they carried the proposer's own stamp, so only the
        // leader's transfers and everyone else contributes through its own PREPARE,
        // exactly as on the ok path. Anything else (e.g. this hub's own OK proposal
        // ahead of a no_quorum verdict) needs a fresh signature over the non-ok
        // canonical.
        let winnerCanonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, status, pending.winner.meta, Number(pending.request.block_index), pending.effectiveTime).toString('utf8');
        for(let [pubkey, p] of pending.proposals){
            if(ValidatorIdentity.verify(winnerCanonical, String(p.sig), pubkey))
                pending.signatures.set(pubkey, String(p.sig));
        }
        if(pending.myPubkey && pending.proposals.has(pending.myPubkey) && !pending.signatures.has(pending.myPubkey)){
            let reSig = this.signCanonical(rid, pending.providerId, pending.winner.body, status, pending.winner.meta, Number(pending.request.block_index), pending.effectiveTime);
            if(reSig) pending.signatures.set(pending.myPubkey, reSig);
        }
        logger.warn('AttestationConsensus: non-ok outcome status=' + status + ' for ' + rid.substring(0,16) +
                    '... (' + pending.signatures.size + ' aligned sig(s))');
        this.broadcastAgreedPrepare(rid, pending);
    }

    // WINNER-ESTABLISHING BLOCK: this hub is about to adopt a field it did
    // not choose, so this is where the two guards belong. Spelling first
    // (D59, and buildResponseCanonicalRaw throws on a bad one), bounds
    // immediately after the signature verify.
    verifyNonOkPrepare(pending, d, rid, body, meta, status, senderPubkey){
        let wireEffective = this.readWireEffectiveTime(pending, d, 'non-ok PREPARE', senderPubkey, rid);
        if(wireEffective === undefined) return;
        let canonical = this._buildCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index), wireEffective);
        if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
            logger.warn('AttestationConsensus: bad non-ok PREPARE sig from ' + senderPubkey.substring(0,16) + '...');
            return;
        }
        if(this.wireEffectiveOutOfWindow(wireEffective, 'non-ok PREPARE', senderPubkey, rid)) return;
        return { wireEffective: wireEffective, canonical: canonical };
    }

    // Co-sign a non-ok winner, but only one this hub can stand behind
    // (the policy: mayCoSignNonOk).
    coSignNonOkWinner(pending, rid, canonical, body, meta, status){
        let myProposal = pending.proposals.get(pending.myPubkey);
        if(this.mayCoSignNonOk(myProposal, status) && !pending.signatures.has(pending.myPubkey)){
            let reSig = ValidatorIdentity.verify(canonical.toString('utf8'), String(myProposal.sig || ''), pending.myPubkey)
                ? String(myProposal.sig)
                : this.signCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index), pending.effectiveTime);
            if(reSig){
                pending.signatures.set(pending.myPubkey, reSig);
                // Echo our endorsing PREPARE exactly once (this !winner
                // block only runs on first adoption) so prepare-quorum is
                // reachable; mirrors the judge_model ok-winner echo.
                this.echoAdoptedPrepare(rid, pending, reSig);
            }
        }
    }

    // WINNER-ESTABLISHING BLOCK (ok path). Same two guards, same order, same
    // reasons as the non-ok block above: this is the first point at which a
    // follower adopts a leader-chosen field.
    verifyEstablishingPrepare(pending, d, rid, body, meta, status, senderPubkey){
        let wireEffective = this.readWireEffectiveTime(pending, d, 'PREPARE', senderPubkey, rid);
        if(wireEffective === undefined) return;
        let canonical = this._buildCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index), wireEffective);
        if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
            logger.warn('AttestationConsensus: bad PREPARE sig from ' + senderPubkey.substring(0,16) + '...');
            return;
        }
        if(this.wireEffectiveOutOfWindow(wireEffective, 'PREPARE', senderPubkey, rid)) return;
        return { wireEffective: wireEffective, canonical: canonical };
    }

    // judge_model follower: re-sign the leader's winner, once this hub has
    // passed the liveness guard in judgeCoSignEligible.
    coSignJudgeWinner(pending, rid, body, meta, status, myProposal){
        if(!this.judgeCoSignEligible(rid, myProposal)) return false;
        // Semantic consensus: our own body is byte-divergent from the
        // judge-selected winner even though both are valid. Re-sign
        // the canonical winner so our vote carries a verifying
        // signature over the agreed bytes (see maybeAdvanceFromProposals).
        let reSig = this.signCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index), pending.effectiveTime);
        if(reSig) pending.signatures.set(pending.myPubkey, reSig);
        // judge_model elects ONE leader to run agree() + PREPARE; followers
        // only adopt that winner here and never run agree(), so without
        // echoing our own endorsing PREPARE no node ever sees more than the
        // leader's single PREPARE and prepare-quorum (max(quorum, REDUNDANCY))
        // is never reached, deadlocking the round despite the leader holding
        // enough matching-proposal sigs. Re-broadcast our PREPARE over the
        // adopted canonical winner exactly once (this !winner block runs only
        // on first adoption). byte_equality is unaffected: there every
        // validator runs its own agree() and broadcasts its own PREPARE.
        this.echoAdoptedPrepare(rid, pending, reSig);
        return true;
    }

    // byte_equality: only sign if our independently-fetched body
    // is byte-identical to the winner. A divergence is a genuine
    // disagreement and must NOT be papered over with a signature.
    coSignByteEqualWinner(pending, rid, canonical, body, meta, status, myProposal){
        if(!this.ownBodyMatchesWinner(body, meta, myProposal)) return;
        // Our PROPOSE sig transfers only if it verifies over the winner
        // canonical (it binds status: a matching body signed over a
        // non-ok status does not verify; see maybeAdvanceFromProposals);
        // otherwise re-sign the winner canonical.
        let mySig = ValidatorIdentity.verify(canonical.toString('utf8'), String(myProposal.sig || ''), pending.myPubkey)
            ? String(myProposal.sig)
            : this.signCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index), pending.effectiveTime);
        if(mySig) pending.signatures.set(pending.myPubkey, mySig);
        // Prepare-quorum liveness (mirrors the judge_model echo above):
        // we adopted the winner from a peer's PREPARE BEFORE running our
        // own agree() (gossip reordering: missed a PROPOSE, got the
        // derived PREPARE), and the winner-set early-return in
        // maybeAdvanceFromProposals means we will never broadcast our
        // own PREPARE by any other route. Without this echo every
        // responsible node tops out one prepare short of
        // max(quorum, REDUNDANCY), no COMMIT is ever sent, and the round
        // expires despite enough matching signatures. Echo exactly once
        // (this !winner block runs only on first adoption) and self-add
        // to prepares; a non-matching body still abstains entirely.
        this.echoAdoptedPrepare(rid, pending, mySig);
    }

    // Winner already established: a later PREPARE's signature must verify
    // over the CANONICAL WINNER body/status/meta (mirror _handleCommit),
    // NOT over the sender's own (possibly divergent) body. Storing a sig
    // over a divergent body would inflate signatures.size, which is the gate
    // checkCommitQuorum finalizes on, so the emitted on-chain response
    // could carry signatures that don't all verify over the winner (and
    // be deterministically rejected by the indexer).
    // Winner (and, in the mirror era, its stamp) already settled: the sender
    // must have signed OUR round's bytes. A peer that settled on a different
    // stamp is not counted here for the same reason a peer that settled on a
    // different body is not - the emitted response carries one canonical.
    countLatePrepare(pending, rid, d, senderPubkey){
        let canonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, pending.status, pending.winner.meta, Number(pending.request.block_index), pending.effectiveTime);
        if(ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
            pending.signatures.set(senderPubkey, String(d.sig));
        } else {
            logger.warn('AttestationConsensus: PREPARE sig not over winner body from ' + senderPubkey.substring(0,16) + '... (not counted)');
        }
    }

    _handleCommit(envelope){
        let admitted = this.admittableCommit(envelope);
        if(!admitted) return;
        let { d, rid, pending, senderPubkey } = admitted;

        if(d.sig && d.sig_pubkey){
            // Over the round's settled canonical, stamp included (see the matching
            // note on countLatePrepare).
            let canonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, pending.status, pending.winner.meta, Number(pending.request.block_index), pending.effectiveTime);
            if(ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
                pending.signatures.set(senderPubkey, String(d.sig));
            }
        }
        pending.commits.add(senderPubkey);
        this.checkCommitQuorum(rid);
    }
}

// The parts are installed as NON-ENUMERABLE prototype methods, the descriptor a
// class body gives its own, so the split cannot change what a for-in walk, a deep
// compare or a sinon stub over an instance sees.
for (const part of [options, lifecycle, roundRecords, earlyBuffer, wire, canonical,
                    effectiveTime, proposeRound, advance, prepare, commit, coSign]) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
        Object.defineProperty(AttestationConsensus.prototype, name, Object.assign(descriptor, { enumerable: false }));
    }
}

module.exports = Object.assign(AttestationConsensus, {
    ATTEST_PROPOSE,
    ATTEST_PREPARE,
    ATTEST_COMMIT
});

