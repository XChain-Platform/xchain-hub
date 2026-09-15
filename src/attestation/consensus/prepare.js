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
 * XChain Hub - Attestation Prepare Adoption
 *
 * What a PREPARE is allowed to establish, and on what evidence. A PREPARE is
 * the first point at which a hub adopts bytes it did not derive itself, so
 * every gate a follower applies before co-signing lives here: the derivable
 * non-ok statuses, the leader-only judge_model path with its A-F1 proposal
 * match, and byte_equality's A-F4 corroboration rule.
 *
 ********************************************************************/

'use strict';
const crypto            = require('crypto');
// Body-size ceiling every proposed/signed response must clear, leader and
// follower alike (spec §5.3, D40/D41, row 9). Applies in both canonical eras.
const { ATTEST_RESPONSE_BODY_MAX_BYTES, bodyByteLength, assertBodyWithinCap } = require('../attest_response_body_cap.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    handlePrepare(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){
            this.bufferEarlyMessage(rid, envelope);
            return;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)) return;

        if(!this.envelopeWithinCaps(pending, d, 'PREPARE', senderPubkey, rid)) return;

        // If we haven't picked a winner yet, this PREPARE tells us what the leader/sender
        // believes is the winning body. Adopt it after sig verification.
        let body;
        try { body = Buffer.from(String(d.body_b64 || ''), 'base64'); }
        catch (_) { return; }
        let meta = String(d.meta || '');
        let status = String(d.status || 'ok');
        // FOLLOWER gate (spec §5.3, D40/D41, row 9), run before this hub can adopt
        // or co-sign ANY PREPARE-carried body. A PREPARE can be the very first place
        // a Byzantine leader (or, in byte_equality, a corroborating peer) introduces
        // a body: the A-F4 corroboration path below signs over a peer's PREPARE
        // directly and never re-derives it from a stored proposal, so the
        // handlePropose gate alone does not cover every path into a signature.
        // Once a winner is already established this hub signs over
        // `pending.winner.body` (already gated at establishment), never over this
        // wire `body`, so a late echo's own decoded length is harmless either way.
        if(!assertBodyWithinCap(body)){
            this.bodyOverCapRejectCount++;
            logger.warn('AttestationConsensus: oversized PREPARE body (decoded ' + bodyByteLength(body) +
                ' bytes, over ATTEST_RESPONSE_BODY_MAX_BYTES=' + ATTEST_RESPONSE_BODY_MAX_BYTES + ') from ' +
                senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }
        if(!pending.winner && status !== 'ok'){
            if(!this.adoptNonOkPrepare(envelope, pending, rid, d, body, meta, status, senderPubkey)) return;
        } else if(!pending.winner){
            if(!this.adoptOkPrepare(envelope, pending, rid, d, body, meta, status, senderPubkey)) return;
        } else if(d.sig && d.sig_pubkey){
            this.countLatePrepare(pending, rid, d, senderPubkey);
        }

        this.finishPrepare(rid, pending, senderPubkey);
    },

    // NON-OK adoption (Phase 4). A non-ok outcome is DETERMINISTIC
    // (canonical empty body + empty meta + status), so unlike a
    // judge_model ok-winner it may be established by ANY responsible
    // sender, not just the leader: a dead leader must not block an
    // outage from being recorded. Safety comes from the co-sign rules
    // (mayCoSignNonOk: a hub only vouches for what it observed), never from
    // trusting the sender.
    adoptNonOkPrepare(envelope, pending, rid, d, body, meta, status, senderPubkey){
        if(body.length !== 0 || meta !== ''){
            logger.warn('AttestationConsensus: non-ok PREPARE with non-canonical body/meta from ' + senderPubkey.substring(0,16) + '... (rejected)');
            return false;
        }
        // Whitelist the adopted status to the exact set a hub can DERIVE
        // (`establishNonOkWinner` only ever emits these two). `status` is
        // the raw wire value; without this gate a single Byzantine
        // responsible sender could forge any other non-ok status (e.g. the
        // indexer-terminal 'expired'), have honest peers whose own fetch
        // failed co-sign it, and finalize a terminal ATTEST that kills an
        // otherwise-retryable request and triggers a wrongful refund.
        if(status !== 'provider_error' && status !== 'no_quorum'){
            logger.warn('AttestationConsensus: non-ok PREPARE with non-derivable status "' + status + '" from ' + senderPubkey.substring(0,16) + '... (rejected)');
            return false;
        }
        let seenNonOk = this.nonOkPublished.get(rid);
        if(seenNonOk && seenNonOk.has(status)) return false;  // this status already published; don't co-sign a duplicate
        if(!d.sig || !d.sig_pubkey){
            logger.warn('AttestationConsensus: unsigned non-ok PREPARE rejected from ' + senderPubkey.substring(0,16) + '...');
            return false;
        }
        let verified = this.verifyNonOkPrepare(pending, d, rid, body, meta, status, senderPubkey);
        if(!verified) return false;
        // Adoption is deferred to the commit point below (item 6491), as on the
        // ok path: the self-derivation gate can still refuse this PREPARE, and a
        // refused one must leave the round's bytes exactly as it found them or a
        // sender this hub declines to co-sign could still shift its stamp.
        if(this.nonOkDerivationRefuses(envelope, pending, rid, status, senderPubkey)) return false;

        // Every check has passed: adopt the establisher's stamp, and only now.
        // The co-sign below signs those exact bytes (`canonical` was built over
        // wireEffective, so this leaves the two in step).
        pending.effectiveTime = verified.wireEffective;
        pending.signatures.set(senderPubkey, String(d.sig));
        pending.winner = { body: body, meta: meta };
        pending.status = status;
        this.coSignNonOkWinner(pending, rid, verified.canonical, body, meta, status);
        return true;
    },

    // Self-derivation gate (items 2641, 2579). For byte_equality a
    // no_quorum verdict is LOCALLY DERIVABLE: agree() is a deterministic
    // byte tally over collected proposals, so this hub must not adopt or
    // co-sign a no_quorum PREPARE it cannot itself derive. Without this a
    // single Byzantine responsible sender racing a signed no_quorum PREPARE
    // ahead of proposal collection makes every honest hub (each of which
    // always holds its own proposal) co-sign on faith, forcing the round to
    // no_quorum even though all honest bodies are byte-identical - stalling
    // the request to deadline. Buffer until `need` proposals are in hand
    // (the same threshold maybeAdvanceFromProposals uses), then adopt only
    // if our own agree() over the ok proposals yields no winner. judge_model
    // is deliberately exempt: only the leader runs the judge, so a follower
    // genuinely cannot re-derive the verdict (the seam note below), and its
    // adoption stays participation-gated by the co-sign policy.
    nonOkDerivationRefuses(envelope, pending, rid, status, senderPubkey){
        if(status === 'no_quorum' && pending.pinnedConsensusStrategy === 'byte_equality'){
            let needNq = Math.min(pending.redundancy, pending.responsible.length);
            if(pending.proposals.size < needNq){
                this.bufferEarlyMessage(rid, envelope);
                return true;
            }
            let nonOkModule = this.providerRegistry.getModule(pending.providerId);
            let okForVerdict = [...pending.proposals.values()].filter(p => (p.status || 'ok') === 'ok');
            let derivedWinner = null;
            try {
                if(nonOkModule && typeof nonOkModule.agree === 'function')
                    derivedWinner = nonOkModule.agree(okForVerdict, { expectedN: needNq });
            } catch (_) { derivedWinner = null; }
            // agree() is dual-shape by contract (see maybeAdvanceFromProposals):
            // the ok-winner path awaits it, but this is the SYNCHRONOUS PBFT
            // PREPARE handler and cannot. A thenable return is therefore not a
            // derived winner, and reading it as one (every Promise is truthy)
            // would refuse EVERY no_quorum PREPARE for this provider and expire
            // the round at its deadline instead of publishing the audit row. The
            // gate keys on the pinned STRATEGY while the shape rides the MODULE,
            // so governance pointing byte_equality at an async module reaches
            // here. Settle the orphaned promise before dropping it: an unhandled
            // rejection from a provider call nobody awaits takes the hub process
            // down. Fail closed either way - a verdict this hub cannot itself
            // derive is one it must not co-sign (items 2641, 2579).
            if(derivedWinner && typeof derivedWinner.then === 'function'){
                derivedWinner.then(() => {}, () => {});
                logger.error('AttestationConsensus: byte_equality provider "' + pending.providerId +
                    '" exports an async agree(); no_quorum self-derivation is unavailable on the ' +
                    'synchronous PREPARE path, so ' + rid.substring(0,16) + '... is not co-signed ' +
                    '(config error: strategy/module shape mismatch)');
                return true;
            }
            if(derivedWinner){
                logger.warn('AttestationConsensus: refusing no_quorum PREPARE from ' + senderPubkey.substring(0,16) +
                    '... for ' + rid.substring(0,16) + '... (own agree() derives an ok winner; not co-signing)');
                return true;
            }
            // derivedWinner === null: this hub independently derives no_quorum,
            // so adopting and co-signing below is self-evidenced.
        }
        return false;
    },

    // judge_model is non-deterministic across hubs: only the ELECTED LEADER
    // runs agree() and its selected body is the canonical winner. So only the
    // leader's PREPARE may establish the winner. A Byzantine responsible
    // non-leader that broadcasts a divergent body FIRST must not have honest
    // followers adopt it. Buffer a non-leader judge_model PREPARE until the
    // leader's winner lands (it then replays through the "winner already
    // established" path below and verifies over the canonical winner) or the
    // round expires. byte_equality is deterministic (independently-fetched
    // identical bodies) and stays first-verified-PREPARE-wins.
    adoptOkPrepare(envelope, pending, rid, d, body, meta, status, senderPubkey){
        if(pending.pinnedConsensusStrategy === 'judge_model' && pending.leaderPubkey &&
           senderPubkey !== String(pending.leaderPubkey).toLowerCase()){
            this.bufferEarlyMessage(rid, envelope);
            return false;
        }
        // First PREPARE we accept establishes the winner. It MUST carry a valid
        // signature from its sender over the proposed body. An unsigned (or badly
        // signed) PREPARE must never set the winner: otherwise a peer that spoofs
        // the sender pubkey can inject an arbitrary body honest followers then
        // co-sign (item 4559). For judge_model the sender is already constrained to
        // the elected leader above; a node that cannot sign cannot lead a round.
        if(!d.sig || !d.sig_pubkey){
            logger.warn('AttestationConsensus: unsigned PREPARE rejected from ' + senderPubkey.substring(0,16) + '...');
            return false;
        }
        let verified = this.verifyEstablishingPrepare(pending, d, rid, body, meta, status, senderPubkey);
        if(!verified) return false;
        // Adoption itself is deferred to the point the winner is actually set,
        // below: the A-F1 and A-F4 body checks can still refuse this PREPARE,
        // and a refused one must leave the round's bytes exactly as it found
        // them or a leader could shift this hub's stamp with a body it never
        // proves.
        let prepBodyHash = crypto.createHash('sha256').update(body).digest('hex');
        if(pending.pinnedConsensusStrategy === 'judge_model'){
            if(!this.leaderBodyMatchesProposal(envelope, pending, rid, d, meta, senderPubkey, prepBodyHash)) return false;
        } else {
            if(!this.byteEqualityCorroborated(pending, rid, d, meta, status, senderPubkey, prepBodyHash, verified.wireEffective)) return false;
        }
        // Every check has passed: adopt the establisher's bytes, stamp included,
        // and only now.
        pending.effectiveTime = verified.wireEffective;
        pending.signatures.set(senderPubkey, String(d.sig));
        pending.winner = { body: body, meta: meta };
        pending.status = status;
        // Sign our own copy if we agreed (we might have proposed the same body)
        let myProposal = pending.proposals.get(pending.myPubkey);
        if(myProposal){
            if(pending.pinnedConsensusStrategy === 'judge_model'){
                if(!this.coSignJudgeWinner(pending, rid, body, meta, status, myProposal)) return false;
            } else {
                this.coSignByteEqualWinner(pending, rid, verified.canonical, body, meta, status, myProposal);
            }
        }
        return true;
    },

    // A-F1: the leader's signature proves authorship, not honesty. agree()
    // only ever SELECTS one of the collected proposals, so an honest
    // leader's winner must hash-match a proposal this follower collected
    // itself; a Byzantine per-request leader injecting a fabricated body
    // (that no responsible validator proposed) must not be adopted and
    // re-signed on faith. If we haven't collected enough proposals to
    // check yet, buffer the PREPARE (replayed once proposals arrive via
    // handlePropose) instead of accepting blind.
    leaderBodyMatchesProposal(envelope, pending, rid, d, meta, senderPubkey, prepBodyHash){
        let need = Math.min(pending.redundancy, pending.responsible.length);
        if(pending.proposals.size < need){
            this.bufferEarlyMessage(rid, envelope);
            return false;
        }
        let matchesProposal = false;
        for(let p of pending.proposals.values()){
            // Only OK proposals can vouch: agree() selects among ok proposals
            // exclusively (maybeAdvanceFromProposals filters), and a failed
            // fetch proposes provider_error with an EMPTY body - without this
            // filter a Byzantine leader could canonicalize an empty-body
            // 'ok' winner by hash-matching any peer's error proposal (AF1-R1).
            if((p.status || 'ok') !== 'ok') continue;
            if(crypto.createHash('sha256').update(p.body).digest('hex') === prepBodyHash && p.meta === meta){
                matchesProposal = true;
                break;
            }
        }
        if(!matchesProposal){
            logger.warn('AttestationConsensus: leader PREPARE body matches no collected proposal from ' +
                senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected, A-F1)');
            return false;
        }
        return true;
    },

    // A-F4: byte_equality winner adoption must not latch from a single
    // foreign PREPARE. The strategy's whole safety argument is that every
    // honest validator independently fetched identical bytes, so before
    // adopting we require either (a) our OWN proposal to byte-match the
    // announced winner, or (b) a second responsible signer corroborating
    // the same body+meta+status. A lone Byzantine responsible peer racing
    // its divergent body in first can otherwise wedge this hub's round
    // (honest sigs then "don't verify over winner" and never count).
    byteEqualityCorroborated(pending, rid, d, meta, status, senderPubkey, prepBodyHash, wireEffective){
        let ownMatches = false;
        let myP = pending.proposals.get(pending.myPubkey);
        if(myP && (myP.status || 'ok') === 'ok'){
            ownMatches = crypto.createHash('sha256').update(myP.body).digest('hex') === prepBodyHash
                && myP.meta === meta;
        }
        if(!ownMatches){
            if(!pending.prepareCandidates) pending.prepareCandidates = new Map();
            // The key is the CANONICAL's identity, not the body's. In the
            // mirror era two corroborators that stamped different
            // effective_times signed two different canonicals, so counting
            // them as one corroboration would adopt a winner and carry a
            // signature into its set that does not verify over the round's
            // bytes - the exact inflation of signatures.size this handler
            // re-verifies everywhere else to prevent. `wireEffective` is null
            // for every legacy-era sender, so the suffix is constant there
            // and the grouping is exactly the pre-mirror one; the key is a
            // process-local map key and is not observable anywhere else.
            let key = prepBodyHash + '|' + meta + '|' + status + '|' + String(wireEffective);
            // One live candidate per sender (AF4-R1): a re-announce replaces the
            // sender's previous body rather than accumulating. Without this a
            // Byzantine responsible peer streaming distinct self-signed bodies
            // grows the map without bound for the round's lifetime; honest
            // validators only ever announce one body per round anyway.
            for(let [k, m] of pending.prepareCandidates){
                if(k !== key && m.delete(senderPubkey) && m.size === 0) pending.prepareCandidates.delete(k);
            }
            let cand = pending.prepareCandidates.get(key);
            if(!cand){ cand = new Map(); pending.prepareCandidates.set(key, cand); }
            cand.set(senderPubkey, String(d.sig));
            // Bounded: senders are membership-checked responsible validators,
            // each holding at most one live candidate entry, so entries <=
            // responsible.length.
            if(cand.size < 2){
                pending.prepares.add(senderPubkey);
                return false;   // hold: not corroborated yet, and our own body disagrees/is absent
            }
            // Corroborated by two distinct responsible signers: adopt, and
            // carry both already-verified sigs into the winner's sig set.
            for(let [pk, sg] of cand) pending.signatures.set(pk, sg);
        }
        return true;
    },

    // The tail every accepted PREPARE runs: count the vote, test the prepare
    // quorum, and replay whatever was waiting on a winner this one established.
    finishPrepare(rid, pending, senderPubkey){
        pending.prepares.add(senderPubkey);
        this.checkPrepareQuorum(rid);

        // A PREPARE can be the first thing to establish our winner (when we
        // adopt the leader's body above). Replay any COMMITs buffered before
        // then so their votes aren't lost, and any non-leader judge_model
        // PREPAREs buffered pre-winner, which now verify over the canonical winner.
        if(pending.winner){
            this.drainEarlyCommits(rid);
            this.drainEarlyMessages(rid);
            // A late PREPARE can carry the signature that crosses the commit
            // quorum AFTER this node already broadcast its COMMIT. In that state
            // checkPrepareQuorum short-circuits on `_commitSent`, so the only
            // finalization gate (checkCommitQuorum) would otherwise never be
            // re-run and a fully-quorate round would stall until round timeout
            // (e.g. the peer's COMMIT was lost on best-effort gossip). Re-check,
            // but ONLY once we have committed: before that, prepare quorum is the
            // required gate, and signatures.size can already equal `needed` from
            // the agree phase, so an unconditional call would finalize before
            // prepare quorum is reached. Post-commit the call is idempotent
            // (gated on signatures.size >= needed and the finalized flag).
            if(pending._commitSent) this.checkCommitQuorum(rid);
        }
    }

};
