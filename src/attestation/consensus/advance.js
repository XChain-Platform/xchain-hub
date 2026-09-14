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
 * XChain Hub - Attestation Winner Selection
 *
 * The transition from collected proposals to a winner: who is allowed to run
 * the provider's agree(), what it is asked, what a round that raced it must do
 * with the answer, and what a proposal that does not match the winner means.
 *
 ********************************************************************/

'use strict';
const { positiveIntConfig } = require('../../lib/config_int.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ATTEST_PREPARE } = require('./constants.js');

module.exports = {

    // Once enough proposals are in, run provider.agree() to pick a winner and
    // transition to PREPARE phase. Idempotent by early return, NOT by re-sweeping:
    // once a winner exists this returns at the first statement below, so a PROPOSE
    // arriving afterwards is stored by _handlePropose but never re-verified against
    // the winner canonical and never counted into pending.signatures. The
    // winner-canonical sweep further down runs exactly once, at the moment the winner
    // is established, and establishNonOkWinner's sweep is guarded the same way.
    //
    // So a late proposer's signature reaches the set ONLY through its own PREPARE or
    // COMMIT, each verified over the winner canonical at its own handler. That is a
    // cross-handler dependency, not an incidental one: it is why liveness holds today
    // (a validator that PROPOSEs also PREPAREs) and why moving where signatures are
    // counted must account for this path. Pinned by
    // "a post-winner PROPOSE contributes no signature; the same peer's PREPARE does"
    // in test/unit/AttestationConsensus.test.js.
    //
    // provider.agree() may be sync (http_get returns the winner immediately)
    // or async (llm runs judge_model via an API call). We always await it via
    // Promise.resolve so both shapes work.
    async maybeAdvanceFromProposals(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        if(pending.winner) return;  // Already advanced; new proposals handled in PREPARE
        if(pending._agreeing) return;  // judge_model API call in flight; don't fire twice

        // Wait until we have at least REDUNDANCY proposals (or all responsible
        // validators have submitted). Single-validator collapses to immediate.
        // Error proposals count toward arrival: a round where every fetch
        // failed must still advance (to a non-ok outcome), not stall.
        let need = Math.min(pending.redundancy, pending.responsible.length);
        if(pending.proposals.size < need) return;
        let proposalsArr = this.okProposalsForRound(rid, pending);
        if(!proposalsArr) return;
        let providerModule = this.roundProviderModule(rid, pending);
        if(!providerModule) return;
        if(this.awaitsJudgeLeader(pending)) return;

        pending._agreeing = true;
        let winner;
        // Log-only could-not-judge channel (providers/llm.js markInconclusive):
        // agree() fills it before every inconclusive null so the warn line below
        // can tell a judge outage / pause / spent budget from a genuine
        // not-equivalent verdict. Never reaches the canonical, PREPARE or status.
        let judgeOutcome = {};
        try {
            winner = await Promise.resolve(providerModule.agree(proposalsArr, this.agreeOptions(pending, need, judgeOutcome)));
        } catch (e) {
            logger.warn(nodeUtil.format('AttestationConsensus: agree() threw for %s...:', rid.substring(0,16), e));
            winner = null;
        }
        pending._agreeing = false;
        if(this.roundMovedDuringAgree(rid, pending)) return;

        if(!winner){
            this.concludeWithoutWinner(rid, judgeOutcome, proposalsArr);
            return;
        }

        pending.winner = winner;
        pending.status = 'ok';

        // Settle the round's single effective_time, before any canonical below is
        // built from it. Which value that is depends on the strategy; see
        // settleWinnerEffectiveTime for the rule and why judge_model cannot take
        // the same one byte_equality does.
        this.settleWinnerEffectiveTime(pending, pending.status);
        let winnerHash = this.collectWinnerSignatures(rid, pending, winner);
        this.resignJudgeWinner(rid, pending, winner);
        this.resignMirrorWinner(rid, pending, winner, winnerHash);
        this.broadcastAgreedPrepare(rid, pending);
    },

    // Establish a NON-OK round outcome (Phase 4): winner is the canonical
    // empty body + empty meta with an explicit failure status, so every hub
    // that reaches the same conclusion signs byte-identical canonicals and the
    // round converges without a judge call. Statuses:
    //   provider_error - every responsible fetch failed (upstream outage)
    //   no_quorum      - fetches succeeded but agree() returned no winner: either
    //                    a genuine not-equivalent verdict or a could-not-judge
    //                    (judge outage, paused provider, spent budget,
    //                    unparseable verdict); the distinction is log-only
    //                    (judgeOutcome in maybeAdvanceFromProposals) since the
    //                    reason is leader-local
    // The indexer treats both as RETRYABLE: the request stays pending, so a
    // later round (e.g. after the model-fallback ladder advances) can still
    // fulfill it. Throttled to one publication per (request_id, status).
    // Returns the round with its winner adopted, or null when there is nothing
    // to establish.
    adoptNonOkWinner(rid, status){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || pending.winner) return null;

        let seen = this.nonOkPublished.get(rid);
        if(seen && seen.has(status)) return null;  // already on-chain; retries stay silent

        pending.winner = { body: Buffer.alloc(0), meta: '' };
        pending.status = status;

        // Same settling as the ok path, and the status is what decides which value
        // it takes: provider_error is derivable by every hub independently, so
        // every hub reaches this line on its own and must converge on a stamp
        // already on the wire, while a judge_model no_quorum is only ever reached
        // behind the leader gate and carries the judge call's latency with it. See
        // settleWinnerEffectiveTime.
        this.settleWinnerEffectiveTime(pending, status);
        return pending;
    },

    // The ok proposals a winner may be chosen from, or null when the round has
    // already been concluded as a provider outage.
    okProposalsForRound(rid, pending){
        // Split ok fetches from error reports. Every responsible validator
        // failing its fetch is the provider-outage signal: publish an explicit
        // status='provider_error' ATTEST v1 (Phase 4) so the outage is an
        // on-chain fact instead of a silent stall. The outcome is
        // deterministic (empty body, empty meta, same status → identical
        // canonical on every hub), so no judge call and no leader gate.
        let okProposals = [...pending.proposals.values()].filter(p => (p.status || 'ok') === 'ok');
        if(okProposals.length === 0){
            this.establishNonOkWinner(rid, 'provider_error');
            return null;
        }
        return okProposals;
    },

    // The provider module that decides this round, or null when the provider
    // cannot decide one.
    roundProviderModule(rid, pending){
        // Run provider's consensus strategy
        let providerModule = this.providerRegistry.getModule(pending.providerId);
        if(!providerModule || typeof providerModule.agree !== 'function'){
            logger.warn('AttestationConsensus: provider ' + pending.providerId + ' has no agree(); cannot finalize ' + rid.substring(0,16) + '...');
            return null;
        }
        return providerModule;
    },

    // judge_model is non-deterministic across hubs: each runs its own LLM
    // judge over its own proposal ordering and may select a different winning
    // body. If every hub broadcast its own PREPARE, followers would lock
    // whichever arrived first and the federation could never converge on one
    // canonical body. So for judge_model only the elected leader runs agree()
    // and broadcasts the canonical winner; followers adopt + re-sign it via
    // the leader's PREPARE (see handlePrepare). If the leader never resolves
    // (offline / failed self-test), the round falls through to deadline
    // expiry rather than finalizing divergent bodies. byte_equality stays
    // deterministic (the agreed body is the common one) so every hub resolves
    // locally as before.
    awaitsJudgeLeader(pending){
        if(pending.pinnedConsensusStrategy === 'judge_model'
           && pending.leaderPubkey && pending.myPubkey
           && String(pending.leaderPubkey).toLowerCase() !== String(pending.myPubkey).toLowerCase()){
            return true;
        }
        return false;
    },

    // What agree() is asked, and under what budget. Both are pinned values: the
    // judge budget matches the fetch leg's, and the majority denominator is the
    // responsible-set bound rather than the surviving proposal count.
    agreeOptions(pending, need, judgeOutcome){
        // Bound the judge call to the same fetch-timeout budget as a
        // provider fetch, so a slow-drip judge vendor call cannot overrun
        // the round window (see the wall-clock deadline guard in
        // providers/llm.js's transports).
        // positiveIntConfig for the reason the option notes give: a negative budget
        // makes providers/llm.js's deadlineAt already elapsed, so the judge fallback
        // chain breaks at its first iteration ("judge budget exhausted") and every
        // judge_model round resolves no_quorum.
        // The 20000 default matches AttestationRound's DEFAULT_FETCH_TIMEOUT (raised
        // from 10000 by operator ruling 2026-09-11); a hub with no explicit key must
        // give the judge the same budget the fetch leg got, or the two legs of one
        // round disagree about how long a slow vendor is allowed to be.
        let judgeTimeoutMs = positiveIntConfig(this.config.ATTESTATION_FETCH_TIMEOUT, 20000,
            'ATTESTATION_FETCH_TIMEOUT');
        // expectedN pins the majority denominator to the responsible-set size,
        // not the surviving ok-proposal count (item 2642). Without it, failed
        // fetches shrink `proposals.length` and a lone unreplicated body clears
        // ceil((N+1)/2) with N=1, becoming the round winner and suppressing the
        // deterministic no_quorum audit row (byte_equality's independent-fetch
        // premise goes unexercised). byte_equality honours it; judge_model
        // ignores it. `need` is the responsible-set bound maybeAdvanceFromProposals computed.
        return { pinnedJudgeModel: pending.pinnedJudgeModel || null, pinnedVendors: pending.pinnedVendors || null,
                 pinnedApprovedModels: pending.pinnedApprovedModels || null,
                 timeoutMs: judgeTimeoutMs, expectedN: need, outcome: judgeOutcome };
    },

    // Round could have been pruned/finalized while we awaited (rare but possible).
    // Re-assert the SAME preconditions this function checked before the await, on
    // the object the map holds NOW. agree() is an API call on the judge_model path,
    // so PBFT messages are delivered while it runs:
    //   - a responsible peer's signed no_quorum PREPARE can establish a winner and
    //     leave signatures in the map over THAT canonical. Assigning the judge's ok
    //     winner below would not clear them, and checkCommitQuorum gates on
    //     signatures.size, so the round finalizes carrying a signature that does not
    //     verify over the emitted canonical and the indexer rejects the response
    //     below redundancy. First writer wins: the raced outcome stands, and the
    //     request stays retryable because a non-ok outcome is not terminal.
    //   - a retry round can replace the pending object entirely while this closure
    //     still holds the old one; mutating that would broadcast a dead round's
    //     PREPARE. Identity, not presence, is the check that catches it.
    // The judge spend is lost in both cases, which is the correct trade against
    // emitting an unfulfillable response. establishNonOkWinner is already guarded
    // this way, which is why only this ok path could overwrite.
    roundMovedDuringAgree(rid, pending){
        let pendingNow = this.pending.get(rid);
        return !!(pendingNow !== pending || pending.finalized || pending.winner);
    },

    // No winner: say why, then publish the deterministic no_quorum audit row.
    concludeWithoutWinner(rid, judgeOutcome, proposalsArr){
        if(judgeOutcome.inconclusive)
            logger.warn('AttestationConsensus: no consensus on ' + rid.substring(0,16) + '... (could not judge: reason=' +
                         judgeOutcome.reason + '; ' + proposalsArr.length + ' proposals)');
        else
            logger.warn('AttestationConsensus: no consensus on ' + rid.substring(0,16) + '... (' + proposalsArr.length + ' proposals diverged)');
        // Phase 4: publish an explicit STATUS=no_quorum ATTEST v1 (audit
        // row; the request stays pending on the indexer so later retry
        // rounds can still fulfill it before the deadline).
        this.establishNonOkWinner(rid, 'no_quorum');
    },

    // A proposal that did not contribute a signature. Either it agreed on the
    // body and signed different bytes, which is arithmetic rather than an
    // anomaly, or it diverged under byte_equality, which is slash evidence.
    noteUncountedProposal(rid, pending, pubkey, p, matchesWinner, pHash, winnerHashHex, strategy){
        if(matchesWinner){
            // In the mirror era a body-matching proposer whose own stamp is not
            // the round's simply signed a different canonical, which is the
            // normal case for every hub except the leader. That is expected
            // arithmetic, not an anomaly, and it is repaired by the re-sign
            // below (self) or by the peer's own PREPARE (everyone else), so it
            // must not be logged as one: at redundancy 3 it would print twice
            // per round forever and bury the genuine status-mismatch case this
            // warning exists for.
            if(!(pending.mirrorEra && p.effectiveTime !== pending.effectiveTime))
                logger.warn('AttestationConsensus: PROPOSE sig not over winner canonical from ' + String(pubkey).substring(0,16) + '... (not counted)');
        } else if(strategy === 'byte_equality' && (p.status || 'ok') === 'ok' && this.hub.slashDetector){
            // Diverged OK proposal under byte_equality; record as slash
            // candidate. An honest status='provider_error' report is a
            // fetch failure, not a divergence; it must never accrue here.
            // Best-effort; failures don't disrupt the round.
            this.hub.slashDetector.recordAttestationDivergence(
                pubkey, rid, pending.providerId, pHash.toString('hex'), winnerHashHex
            ).catch(e => logger.warn(nodeUtil.format('AttestationConsensus: divergence record failed:', e)));
        }
    },

    // Broadcast PREPARE so other followers can verify and contribute their sigs
    broadcastAgreedPrepare(rid, pending){
        let mySig = pending.signatures.get(pending.myPubkey);
        if(this.peerManager){
            this.broadcastWinnerVote(ATTEST_PREPARE, rid, pending, mySig || null);
        }
        if(pending.myPubkey) pending.prepares.add(pending.myPubkey);

        this.checkPrepareQuorum(rid);

        // Winner is now set; replay any COMMITs that arrived (and were
        // buffered) before this point so their votes count toward quorum, plus any
        // non-leader judge_model PREPAREs buffered before the leader established it.
        this.drainEarlyCommits(rid);
        this.drainEarlyMessages(rid);
    }

};
