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
 * XChain Hub - Attestation Round Pins
 *
 * Everything a round must fix at the REQUEST's own block before it fetches: the
 * model it fetches with, the model-vendor map and approved list that travel with
 * that id, the PBFT strategy the round will run, and the hub-local fee floor the
 * request has to clear. Two hubs whose governance reloads raced still pin the
 * same values here, because every one of them is read at the request's block.
 *
 ********************************************************************/

'use strict';
const bc     = require('../../bcmath.js');
const esc    = require('../escalation.js');
// SUPPORTED_CONSENSUS_STRATEGIES is the admission allowlist startRound declines an
// unrecognised block-anchored strategy against; shared with the dispatch sites it names.
const { SUPPORTED_CONSENSUS_STRATEGIES } = require('../../constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The whole pin set for a round, or null when this build must not serve it.
    // Order matters and is the order a round meets them: models, then the
    // strategy that decides which state machine runs, then the fee floor.
    pinRoundRules(rid, providerId, snapshotBlk, latestBlock, request, providerDef){
        let pins = this.pinModels(providerId, snapshotBlk, latestBlock, request);
        let pinnedConsensusStrategy = this.pinConsensusStrategy(rid, providerId, snapshotBlk);
        if(!pinnedConsensusStrategy) return null;
        if(!pins.pinnedFetchModel){
            logger.warn('AttestationRound: provider "' + providerId + '" has no approved_models at block ' +
                         snapshotBlk + '; fetch falls back to the provider module default (un-pinned)');
        }
        if(this.feeBelowProviderFloor(rid, providerId, providerDef, request)) return null;
        pins.pinnedConsensusStrategy = pinnedConsensusStrategy;
        return pins;
    },

    // The model identity for this round, resolved from the block-anchored
    // provider config so every hub fetches and judges with the same model.
    pinModels(providerId, snapshotBlk, latestBlock, request){
        // Resolve the provider's model identity from the BLOCK-ANCHORED provider
        // config at the request's block (snapshotBlk), so every hub fetches and
        // judges with the same model for this request regardless of when its local
        // governance change finalized, and a governance change activated at a later
        // block cannot alter an in-flight round. Mirrors the block-anchored MIN_STAKE
        // resolution that locks the responsible set.
        let pinnedAc = this.providerRegistry.getAdditionalConfig(providerId, snapshotBlk) || {};
        // Model fallback ladder (Phase 4): the block-anchored approved_models
        // list is an ORDERED fallback chain. The request's serviceable span is
        // split into one segment per model, so a dead primary vendor stops
        // burning the deadline window once the chain crosses into the next
        // segment. Deterministic: every hub derives the same modelIdx from the
        // same chain height, so all validators in a round fetch with the SAME
        // model (a judge_model round mixing vendors would fail equivalence).
        let approvedModels = Array.isArray(pinnedAc.approved_models) ? pinnedAc.approved_models : [];
        let modelIdx = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? esc.modelIndex(Number(latestBlock), snapshotBlk, this.confirmationsFor(snapshotBlk), Number(request.deadline_block), approvedModels.length)
            : 0;
        let pinnedFetchModel = approvedModels[modelIdx] || approvedModels[0] || null;
        let pinnedJudgeModel = pinnedAc.judge_model || null;
        // The model->vendor map has to travel with the pinned model ids,
        // not be read from each hub's live hotReloaded config. A governance change
        // that adds a new-family model plus its model_vendors entry in one block
        // otherwise splits the round, since a laggard hub holds the pinned id but
        // not the mapping and cannot resolve a vendor at all.
        let pinnedVendors = (pinnedAc.model_vendors && typeof pinnedAc.model_vendors === 'object')
            ? pinnedAc.model_vendors : null;
        return {
            approvedModels:   approvedModels,
            modelIdx:         modelIdx,
            pinnedFetchModel: pinnedFetchModel,
            pinnedJudgeModel: pinnedJudgeModel,
            pinnedVendors:    pinnedVendors
        };
    },

    // The round's PBFT strategy, or null when it cannot be resolved or this
    // build does not implement it.
    pinConsensusStrategy(rid, providerId, snapshotBlk){
        // The PBFT strategy is anchored for a stronger reason than the model identity is:
        // it selects which state machine AttestationConsensus runs for this round, not
        // merely which model answers it. Read live off the hot-reloadable registry at each
        // decision site, one hub could adopt a leader's PREPARE while another ran its own
        // agree() over the same round, because hotReload() re-parses every provider def on
        // EVERY proposal:finalized event regardless of subject. Resolved ONCE here at the
        // request's own block and carried on roundState, so a reload landing mid-round
        // cannot move it and two hubs whose reloads raced still run the same machine.
        // Fail closed on an unresolvable strategy, exactly as the provider floor does
        // below: guessing a default here would silently run byte_equality against a
        // judge_model federation.
        //
        // Fail closed on an UNSUPPORTED one for the same reason. The registry carries an
        // unrecognised name verbatim (ProviderRegistry.normalizeConsensusStrategy) so every
        // hub resolves the same value rather than walking back to an older strategy; this
        // gate is the half that then declines. Without it a non-empty unknown name is
        // truthy, pins, and reaches AttestationConsensus, whose dispatch is positive
        // equality against SUPPORTED_CONSENSUS_STRATEGIES only: the round would run the
        // byte_equality branches with the no_quorum self-derivation gate (items 2641/2579)
        // switched off, which is not a machine any peer runs. Checked HERE, before the
        // provider fetch, so a round this build cannot serve costs no vendor call.
        let pinnedConsensusStrategy = (this.providerRegistry && typeof this.providerRegistry.getConsensusStrategy === 'function')
            ? this.providerRegistry.getConsensusStrategy(providerId, snapshotBlk) : null;
        if(!pinnedConsensusStrategy){
            logger.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has no block-anchored consensus_strategy at block ' + snapshotBlk + ' (failing closed)');
            return null;
        }
        if(SUPPORTED_CONSENSUS_STRATEGIES.indexOf(pinnedConsensusStrategy) === -1){
            logger.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has unsupported consensus_strategy "' + pinnedConsensusStrategy + '" at block ' + snapshotBlk +
                         ' (failing closed; this build implements ' + SUPPORTED_CONSENSUS_STRATEGIES.join(', ') + ')');
            return null;
        }
        return pinnedConsensusStrategy;
    },

    // Hub-local min_fee floor (E1, governance-synced via the provider
    // definition). Below-floor requests are skipped BEFORE any provider
    // fetch; with every hub applying the same floor the request simply
    // expires on-chain and the fee refunds. This is economically clean
    // back-pressure with zero consensus involvement.
    feeBelowProviderFloor(rid, providerId, providerDef, request){
        let minFee    = (providerDef && !bc.isNull(providerDef.min_fee_xchain)) ? String(providerDef.min_fee_xchain) : '0';
        let reqFeeAmt = (request && !bc.isNull(request.fee_amount)) ? String(request.fee_amount) : '0';
        if(bc.bcgt(minFee, '0') && bc.bclt(reqFeeAmt, minFee)){
            logger.info('AttestationRound: skipping ' + rid.substring(0,16) + '... fee ' + reqFeeAmt +
                        ' below provider "' + providerId + '" min_fee ' + minFee + ' (request will expire + refund)');
            return true;
        }
        return false;
    }

};
