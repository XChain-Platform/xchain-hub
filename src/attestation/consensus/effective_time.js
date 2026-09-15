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
 * XChain Hub - Attestation Effective Time
 *
 * The mirror-era `effective_time` (spec §3.1, §4.2; rows 6 and 8): the stamp a
 * leader picks, the window a follower will accept one inside, the rule that
 * settles which of them the round signs, and the wire fields that carry it.
 *
 ********************************************************************/

'use strict';
// Era selection, keyed on the REQUEST's own block (never the response's).
const { isResponseMirrorActive } = require('../../attest_response_mirror_activation.js');
// The spelling rule the appended field must obey, from the same byte-twinned
// module as the canonical; never reimplement it here.
const { isCanonicalIntSpelling } = require('../attest_response_canonical.js');
const { resolveAttestResponseForwardS } = require('../attest_response_timing.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Follower acceptance window for a leader-chosen mirror-era `effective_time`,
// expressed as slack either side of the value this hub itself would have picked
// (`now + ATTEST_RESPONSE_FORWARD_S`).
//
// CENTRED ON THE EXPECTATION, which is a tighter shape than the cross-chain
// relay's `now + RELAY_MIN_FUTURE_S .. now + 3600` (CrossChainCallEngine.js:604-607),
// and deliberately so. There the producer margin is per-chain and operator-tunable
// (XCALL_RELAY_MARGIN_BLOCKS), so a follower genuinely cannot predict an honest
// leader's value and can only bound the range it must not leave. Here the margin
// is a FROZEN protocol constant every hub resolves from the same source, so an
// honest leader's stamp differs from this hub's expectation only by clock skew
// and one gossip hop. A proposal far from it is a misconfigured or hostile
// leader, not a slow one, and refusing it costs an honest round nothing.
//
// The window is asymmetric for the relay's reasons, adapted: the LOW guard is a
// propagation floor (a value at or behind the fleet's clocks makes the row
// eligible the instant it lands, so an indexer already holding it applies a
// block earlier than one still receiving it, and their action-index counters
// fork for good), while the HIGH guard is a griefing bound (a far-future row
// pins the callback out past the request's deadline and the response is never
// applied at all).
const ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_BEHIND_S = 60;
const ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_AHEAD_S  = 3600;

module.exports = {

    // Seam for tests; every clock read on this path goes through it.
    _nowSeconds(){
        return Math.floor(Date.now() / 1000);
    },

    // True when the response to a request admitted at `requestBlock` is served by
    // the mirror. Keyed on the request's own block, so the rule for a given request
    // is fixed the moment it is admitted and cannot move under it mid-round.
    isMirrorEra(requestBlock){
        return isResponseMirrorActive(requestBlock, this.hub && this.hub.network);
    },

    // The forward margin this hub stamps and bounds against. Resolved per call
    // rather than cached so a regtest harness can move the seam between rounds;
    // off regtest it is a constant read and cannot move at all.
    forwardSeconds(){
        return resolveAttestResponseForwardS(this.hub && this.hub.network, this.config);
    },

    // The LEADER's pick, made once at proposal time: the same shape as the relay's
    // CrossChainCallEngine.relayEffectiveTime, differing only in which margin it
    // adds (see lib/attest_response_timing.js for why 120 and not 2400).
    chooseEffectiveTime(){
        return this._nowSeconds() + this.forwardSeconds();
    },

    // Read a peer-supplied effective_time off a PROPOSE/PREPARE envelope.
    //
    // Returns null in the legacy era (nothing on the wire can move those bytes),
    // an integer when the wire value is usable, and UNDEFINED to mean "reject this
    // envelope" - a distinct value from the legal null, so a caller cannot confuse
    // "no field, correctly" with "bad field".
    //
    // THE SPELLING GUARD RUNS BEFORE ANY NUMERIC WORK, and before the canonical is
    // built, for two reasons. First, decision D59: a leader proposing '0120'
    // survives every Number()-based check, collects an honest quorum, and produces
    // a row whose canonical no verifier can rebuild, permanently stranding the
    // request - the same trap the relay pairs its bounds with `allCanonicalInts`
    // to close (CrossChainCallEngine.js:585-586). Second, mechanically:
    // buildResponseCanonicalRaw THROWS on a non-canonical spelling by contract, so
    // the guard cannot be moved after the signature verify without the build
    // throwing first.
    readWireEffectiveTime(pending, d, phase, senderPubkey, rid){
        if(!pending.mirrorEra) return null;
        let raw = (d && d.effective_time !== undefined && d.effective_time !== null) ? d.effective_time : null;
        if(raw === null){
            logger.warn('AttestationConsensus: mirror-era ' + phase + ' with no effective_time from ' +
                String(senderPubkey).substring(0,16) + '... for ' + String(rid).substring(0,16) + '... (rejected)');
            return undefined;
        }
        if(!isCanonicalIntSpelling(raw)){
            logger.warn('AttestationConsensus: mirror-era ' + phase + ' with non-canonical effective_time ' +
                JSON.stringify(raw) + ' from ' + String(senderPubkey).substring(0,16) + '... for ' +
                String(rid).substring(0,16) + '... (rejected, D59)');
            return undefined;
        }
        return Number(raw);
    },

    // Follower bound on an adopted leader-chosen effective_time. See the slack
    // constants for why the window is centred on this hub's own expectation rather
    // than on its bare clock. Also the backstop that closes isCanonicalIntSpelling's
    // one soft edge: a NUMBER like 1e21 spells as an integer to that guard but
    // stringifies to '1e+21', and it cannot survive the upper bound here.
    effectiveTimeWithinFollowerWindow(effectiveTime){
        let expected = this._nowSeconds() + this.forwardSeconds();
        return Number.isSafeInteger(effectiveTime)
            && effectiveTime >= expected - ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_BEHIND_S
            && effectiveTime <= expected + ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_AHEAD_S;
    },

    // Settle the round's single effective_time at the moment a winner is
    // established locally, preferring the ELECTED LEADER's proposed value over this
    // hub's own candidate.
    //
    // WITHOUT THIS A byte_equality ROUND CANNOT CONVERGE IN THE MIRROR ERA. Every
    // responsible hub runs its own agree() and establishes its own winner there, so
    // if each kept its own stamp, every hub's PREPARE would carry a signature over
    // a canonical no peer could rebuild, `signatures` would stall at one per hub,
    // and the round would run to timeout with all honest hubs agreeing on the body.
    // Reading the leader's proposal instead gives every hub the same bytes from
    // data it already holds: the leader is a member of the responsible set
    // (AttestationRound.js:460), and a hub only reaches a winner after collecting
    // `need` proposals, so in a healthy round the leader's is among them.
    //
    // Falls back to this hub's own candidate when the leader's proposal is absent
    // (a failed leader fetch, or gossip loss). That round then reaches quorum only
    // if the peers that matter fell back identically, and otherwise times out and
    // retries - the same liveness profile a missing leader already has for
    // judge_model, and a stall rather than a divergence.
    resolveRoundEffectiveTime(pending){
        if(!pending.mirrorEra) return null;
        let leader = pending.leaderPubkey ? String(pending.leaderPubkey).toLowerCase() : null;
        let leaderProposal = leader ? pending.proposals.get(leader) : null;
        if(leaderProposal && leaderProposal.effectiveTime != null)
            pending.effectiveTime = leaderProposal.effectiveTime;
        return pending.effectiveTime;
    },

    // Settle the round's single effective_time at winner establishment, choosing
    // between the two rules the two consensus strategies need.
    //
    // BYTE_EQUALITY CONVERGES ON THE LEADER'S PROPOSAL STAMP; JUDGE_MODEL STAMPS AT
    // ESTABLISHMENT BECAUSE THE JUDGE CALL AGES THE PROPOSAL STAMP PAST THE FOLLOWER
    // FLOOR. Under byte_equality every hub runs its own agree() and establishes its
    // own winner locally, so the only value they can all arrive at without a round
    // trip is one that is already on the wire - which is the whole argument in
    // resolveRoundEffectiveTime's header, unchanged. Under judge_model only the
    // elected leader establishes a winner and every follower adopts the stamp off
    // the leader's PREPARE (handlePrepare's winner-establishing blocks), so the
    // leader is free to pick a fresh value here, and has to: agree() is an LLM
    // round trip that runs for as long as it runs, and a stamp chosen back at
    // proposal time has aged by that whole latency before any follower sees it.
    // Once the ageing exceeds ATTEST_RESPONSE_EFFECTIVE_TIME_SLACK_BEHIND_S the
    // PREPARE fails effectiveTimeWithinFollowerWindow at every follower and the
    // round times out on a body all of them agree with, every cycle, forever.
    // Widening that slack is not the repair: the low guard is a propagation floor
    // (see the constants), so a stamp that has aged that close to the fleet's
    // clocks is genuinely unsafe to publish, not merely inconvenient.
    //
    // PROVIDER_ERROR KEEPS THE PROPOSAL STAMP EVEN UNDER JUDGE_MODEL. That outcome
    // is derivable with no judge call, so maybeAdvanceFromProposals reaches it
    // ahead of the leader gate and EVERY responsible hub establishes it locally.
    // The adoption branch that would carry a leader's fresh stamp to a follower
    // only runs while that follower has no winner of its own, so a leader stamping
    // freshly there would sign bytes no peer ever adopts and break the one path
    // that converges today. It also has nothing to gain: with no judge in it, the
    // proposal stamp has aged by one gossip hop rather than by a model call.
    settleWinnerEffectiveTime(pending, status){
        if(!pending.mirrorEra) return null;
        if(pending.pinnedConsensusStrategy === 'judge_model' && status !== 'provider_error'){
            pending.effectiveTime = this.chooseEffectiveTime();
            return pending.effectiveTime;
        }
        return this.resolveRoundEffectiveTime(pending);
    },

    // Outbound wire fields carrying the round's effective_time. Empty in the legacy
    // era so a legacy envelope is byte-identical to the one this engine sent before
    // the mirror existed, which is what keeps a mixed-version federation working
    // for every request below the height.
    effectiveTimeWireFields(pending){
        return pending.effectiveTime == null ? {} : { effective_time: pending.effectiveTime };
    }

};
