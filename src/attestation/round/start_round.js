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
 * XChain Hub - Attestation Round Start
 *
 * One request, from the poll that surfaced it to the PROPOSE consensus drives.
 * The order here is the order a round meets its refusals: a provider this build
 * cannot serve, a set that cannot finalize, rules that cannot be pinned, a fee
 * below the floor, and a round this hub has already served - every one of them
 * ahead of the paid provider call.
 *
 ********************************************************************/

'use strict';
const swq    = require('../../stake_weighted_quorum.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Idempotent: repeat calls for the same requestId are dropped.
    // `latestBlock` is the indexer tip observed by the poll that surfaced this
    // request; it drives the deterministic leader-rotation + model-fallback
    // ladders (attestation_escalation.js).
    async _startRound(request, latestBlock){
        let rid          = String(request.request_id).toLowerCase();
        let providerId   = String(request.provider_id);
        let redundancy   = Number(request.redundancy) || 1;
        let snapshotBlk  = Number(request.block_index);
        let myPubkey     = this.identity.getPubkeyHex().toLowerCase();
        let providerModule = this.servableProviderModule(rid, providerId);
        if(!providerModule) return;

        // Gated on the request's block + the hub's network so every hub flips on
        // the same anchor (see resolveRoundSnapshot).
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlk, this.hub.network);
        let snapshot = await this.resolveRoundSnapshot(rid, snapshotBlk, weighted);
        if(!snapshot) return;
        let seat =this.responsibleSetFor(rid, request, snapshot, snapshotBlk, latestBlock, redundancy, providerId, weighted);
        if(!seat) return;
        let responsible  = seat.responsible;
        let widen        = seat.widen;
        let leader       = this.electLeader(rid, responsible, latestBlock, snapshotBlk);
        let leaderIdx    = leader.index;
        let leaderPubkey = leader.pubkey;
        let amResponsible = responsible.some(v => v.pubkey === myPubkey);
        if(!amResponsible){
            // Not in the responsible set; log so operators can distinguish "saw and skipped" from "never polled".
            logger.info('AttestationRound: skipping ' + rid.substring(0,16) + '... not responsible at block ' + snapshotBlk +
                        ' (snapshot=' + snapshot.validators.length + ', leader=' + (leaderPubkey ? leaderPubkey.substring(0,16) + '...' : 'none') + ')');
            return;
        }
        let amLeader = (leaderPubkey === myPubkey);
        this.logRoundStart(rid, latestBlock, snapshotBlk, widen);

        let providerDef = this.providerRegistry.getDef(providerId);
        let pins = this.pinRoundRules(rid, providerId, snapshotBlk, latestBlock, request, providerDef);
        if(!pins) return;
        if(this.roundAlreadyServed(rid)) return;

        let proposal = await this.fetchOwnProposal(rid, request, providerId, providerModule, providerDef, pins);
        let roundState = this.recordRound(rid, Object.assign({ request: request, amLeader: amLeader, snapshot: snapshot,
            snapshotBlk: snapshotBlk, responsible: responsible, leaderPubkey: leaderPubkey, redundancy: redundancy,
            providerId: providerId, providerDef: providerDef }, pins, proposal), leaderIdx);

        // Hand to consensus so it can collect PROPOSEs from other validators
        // and drive PBFT. Consensus is responsible for the actual ATTEST_PROPOSE
        // broadcast (so it owns the canonical-bytes/signature shape).
        if(this.consensus){
            await this.consensus.propose(rid, roundState);
        }
    },

    // Snapshot of validators qualifying for `attestation` at the request's
    // block boundary. Each hub computes the same set (deterministic).
    // STAKE_WEIGHTED_QUORUM: at/above activation, resolve the SOURCE-keyed
    // weight snapshot so the responsible-set selection can dedupe by staking
    // source (one slot per source), closing the delegation slot-inflation
    // hole. The within-subset quorum stays count-based (attestation is an
    // independent-replication check, not a stake vote). Returns null when the
    // round cannot be served.
    async resolveRoundSnapshot(rid, snapshotBlk, weighted){
        let snapshot = this.hub.capabilitySnapshot
            ? (weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('attestation', snapshotBlk)
                : await this.hub.capabilitySnapshot.getSnapshot('attestation', snapshotBlk))
            : null;
        if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0){
            // Empty snapshot means no qualified validators exist at the request's
            // block; request can't be served. Will eventually expire on deadline.
            logger.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... empty capability snapshot at block ' + snapshotBlk);
            return null;
        }
        return snapshot;
    },

    // The round's opening line, one per started round on a responsible hub, and
    // the only place the EFFECTIVE confirmation count is visible: the boot line
    // reports the constructor's tunable, which has no request block to key on.
    // Format is pinned by the acceptance drill (spec §10 ZC1 greps for
    // `tip=<N> conf=0 widen=1`), so it is a contract, not a debug line.
    logRoundStart(rid, latestBlock, snapshotBlk, widen){
        logger.info('AttestationRound: starting ' + rid.substring(0,16) +
                    '... tip=' + latestBlock +
                    ' conf=' + this.confirmationsFor(snapshotBlk) +
                    ' widen=' + widen);
    },

    // Can this build serve the request at all? Returns the provider module, or
    // null when governance names a provider this hub has not deployed.
    servableProviderModule(rid, providerId){
        // Provider known? (governance might have ATTEST v0 (request) whose
        // provider is governance-defined but not deployed locally.)
        if(!this.providerRegistry.isKnown(providerId)){
            logger.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider ' + providerId + ' unknown');
            return null;
        }
        let providerModule = this.providerRegistry.getModule(providerId);
        if(!providerModule || typeof providerModule.fetch !== 'function'){
            logger.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider ' + providerId + ' module missing fetch()');
            return null;
        }
        return providerModule;
    },

    // Short-circuit the paid provider call if a consensus round for this rid
    // is already live. A re-poll of a still-running round would
    // otherwise pay for a fetch that consensus.propose() immediately discards
    // on its `pending.has(rid)` guard. Checking here moves that existing guard
    // ahead of the vendor call instead of after it. Worst blast radius is
    // providers/llm, where the wasted call burns vendor quota on precisely the
    // degraded rounds already running long.
    roundAlreadyServed(rid){
        if(this.consensus && typeof this.consensus.isRoundActive === 'function' && this.consensus.isRoundActive(rid)){
            logger.info('AttestationRound: skipping fetch for ' + rid.substring(0,16) + '... (consensus round already active)');
            return true;
        }
        // The same short-circuit for a round this hub already FINALIZED. The
        // request stays pending on the indexer until its callback binds, at
        // least one block later, which outlives both `seen` and the durable
        // cache (retryAfterMs), so a re-poll in that window must be refused
        // here rather than by propose()'s ring check after the provider is paid.
        if(this.consensus && typeof this.consensus.isFinalized === 'function' && this.consensus.isFinalized(rid)){
            this.finalizedSkipCount++;
            logger.info('AttestationRound: skipping fetch for ' + rid.substring(0,16) + '... (already finalized; awaiting bind)');
            return true;
        }
        return false;
    },

    // Fetch the payload via the provider module. Capped at provider's max
    // response bytes; timeout from config. A failed fetch no longer goes
    // silent: it becomes a status='provider_error' proposal (empty body,
    // empty meta) so the round can quorum-sign an explicit non-ok ATTEST v1
    // (Phase 4) instead of stalling every peer until deadline expiry.
    async fetchOwnProposal(rid, request, providerId, providerModule, providerDef, pins){
        let { pinnedFetchModel, pinnedVendors, modelIdx } = pins;
        // Durable, request_id-keyed twin of the in-memory `seen`
        // window. Both guards above die with the process (`seen` is cleared on
        // stop(), isRoundActive reads live consensus state), so a restart inside
        // the round window re-paid the provider for a request this hub had
        // already fetched, and on a non-deterministic provider (llm) re-signed a
        // DIFFERENT body under the same rid. Reusing the recorded result makes a
        // restart behave exactly like no restart. Cache rows age out on the same
        // retryAfterMs window as `seen`, so a genuinely timed-out round still
        // re-fetches rather than replaying a stale answer forever.
        let cached    = await this.readFetchCache(rid);
        let fetched   = null;
        let myStatus  = 'ok';
        if(cached){
            fetched  = { body: cached.body, meta: cached.meta };
            myStatus = cached.status;
            this.fetchCacheHitCount++;
            logger.info('AttestationRound: reusing recorded fetch for ' + rid.substring(0,16) +
                        '... (status=' + myStatus + '); no provider call issued');
        } else {
            // Counted BEFORE the call, not after it: a fetch that throws may still
            // have reached the provider and cost money, and the number this exposes
            // is "what did this hub spend", not "what came back".
            this.fetchCount++;
            try {
                fetched = await providerModule.fetch(request.payload, {
                    maxResponseBytes: providerDef.max_response_bytes,
                    timeoutMs:        this.fetchTimeoutMs,
                    pinnedModel:      pinnedFetchModel,
                    // Block-anchored model->vendor map for the pinned id.
                    pinnedVendors:    pinnedVendors,
                    // Rank of the pinned model on the fallback ladder; providers
                    // enforce request-level fallback policy on it (llm 'strict').
                    modelRank:        modelIdx,
                    // This hub's api.js-validated HUB_NETWORK. http_get gates its
                    // private-address escape hatch on it, and the e2e harness runs
                    // several hubs in one process, where process.env cannot tell
                    // them apart.
                    network:          this.hub.network
                });
            } catch (e) {
                logger.warn(nodeUtil.format('AttestationRound: fetch failed for ' + rid.substring(0,16) + '...: ', e));
                myStatus = 'provider_error';
            }
            // Record the COMPLETED outcome only. A claim written before the call
            // would let a crash mid-fetch skip a round this hub never finished,
            // trading bounded duplicate spend for a liveness hole.
            await this.writeFetchCache(rid, providerId, myStatus, fetched, pinnedFetchModel);
        }
        return { fetched: fetched, myStatus: myStatus };
    },

    // The round state consensus runs on, kept and announced. Every pinned value
    // in it was resolved at the request's own block, and nothing here is read
    // from a live registry again for the life of the round.
    recordRound(rid, ctx, leaderIdx){
        let roundState = this.buildRoundState(ctx);
        this.rounds.set(rid, roundState);
        this.logRoundProposal(rid, ctx, leaderIdx);
        return roundState;
    },

    buildRoundState(ctx){
        let { request, amLeader, snapshot, snapshotBlk, responsible, leaderPubkey, redundancy, providerId,
              providerDef, fetched, myStatus, pinnedJudgeModel, pinnedVendors, pinnedConsensusStrategy,
              approvedModels } = ctx;
        let roundState = {
            request:        request,
            role:           amLeader ? 'leader' : 'follower',
            snapshot:       snapshot,
            snapshotBlock:  snapshotBlk,
            responsible:    responsible,
            leaderPubkey:   leaderPubkey,
            redundancy:     redundancy,
            providerId:     providerId,
            // Error proposals carry an empty body and empty meta so every
            // failed fetcher signs the IDENTICAL canonical bytes (the non-ok
            // outcome converges without a judge; see AttestationConsensus).
            myProposal:     (myStatus === 'ok')
                ? { body: fetched.body, meta: fetched.meta, status: 'ok' }
                : { body: Buffer.alloc(0), meta: '', status: myStatus },
            pinnedJudgeModel: pinnedJudgeModel,
            pinnedVendors:    pinnedVendors,
            // The response cap this round's own fetch was bounded by, carried so
            // AttestationConsensus can size its inbound PROPOSE/PREPARE body gate
            // from the same number instead of re-reading the hot-reloadable
            // registry per message. A governance change landing mid-round would
            // otherwise leave this hub gating its peers' bodies at a cap its own
            // proposal never had to meet.
            pinnedMaxResponseBytes: (providerDef && Number(providerDef.max_response_bytes)) || null,
            // Block-anchored PBFT strategy for this round (see the resolution above).
            // AttestationConsensus reads ONLY this, never the live registry.
            pinnedConsensusStrategy: pinnedConsensusStrategy,
            // The allowlist that judges the winning proposal's meta has
            // to be the SAME block-anchored list this round pinned the fetch model
            // from. Judged against the live hotReloadable set instead, a governance
            // DELISTING of the pinned model made every honestly-served meta
            // unrecognized, mapping the round to no_quorum on every retry, so the
            // request could never finalize and expired despite successful provider
            // calls. A provider with no approved_models at this block travels as
            // null, leaving the live-set fallback exactly as it was.
            pinnedApprovedModels: approvedModels.length ? approvedModels.slice() : null,
            error:          (myStatus === 'ok') ? undefined : myStatus,
            proposedAt:     Date.now()
        };
        return roundState;
    },

    logRoundProposal(rid, ctx, leaderIdx){
        let { amLeader, providerId, myStatus, fetched, pinnedFetchModel, modelIdx } = ctx;
        logger.info('AttestationRound: ' + (amLeader ? '[LEADER]' : '[FOLLOWER]') +
                    ' proposing ' + rid.substring(0,16) + '... (provider=' + providerId +
                    ', status=' + myStatus +
                    (myStatus === 'ok' ? ', body=' + fetched.body.length + 'B, meta=' + fetched.meta : '') +
                    ', model=' + (pinnedFetchModel || 'default') + '[' + modelIdx + '], leaderSlot=' + leaderIdx + ')');
    }

};
