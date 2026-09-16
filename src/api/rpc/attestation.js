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
 * XChain Hub - JSON-RPC attestation family: stats, requests, lookups and the
 * responsible-set mirror of a live attestation round.
 *
 ********************************************************************/

const swq = require('../../stake_weighted_quorum.js');
const wid = require('../../attest_responsible_widening_activation.js');
const { validateChain, validateLimit, strictInt } = require('../validate');

// Bounded page walk over the BTC indexer's pending-attestation queue, oldest
// first: getpendingattestation_requests exposes no lookup by request_id, only a
// keyset cursor over the backlog (xchain-indexer/src/api.js), so finding one
// request costs a scan. Capped rather than unbounded, matching every other
// hub->indexer poll's failure posture: an exhausted scan reads as "not found",
// same as a request that was never admitted.
const RESPONSIBLE_SET_LOOKUP_LIMIT = 500;
const RESPONSIBLE_SET_LOOKUP_PAGES = 20;
async function findPendingRequestOnIndexer(hub, axios, rid){
    let url = await hub.resolveBtcIndexerUrl();
    if(!url) return null;
    let cursor = null;
    let latestBlock = 0;
    for(let page = 0; page < RESPONSIBLE_SET_LOOKUP_PAGES; page++){
        let params = { limit: RESPONSIBLE_SET_LOOKUP_LIMIT };
        if(cursor){ params.after_block_index = cursor.block_index; params.after_action_index = cursor.action_index; }
        let res;
        try {
            res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method:  'getpendingattestation_requests',
                params:  params
            }, { headers: hub.btcIndexerHeaders(), timeout: 5000 });
        } catch (e){ return null; }
        let result = res && res.data && res.data.result;
        if(!result || result.error) return null;
        latestBlock = Number(result.latest_block_index) || 0;
        let requests = Array.isArray(result.requests) ? result.requests : [];
        let found = requests.find(r => String((r && r.request_id) || '').toLowerCase() === rid);
        if(found) return { request: found, latestBlock: latestBlock };
        if(requests.length < RESPONSIBLE_SET_LOOKUP_LIMIT) return null;   // tail of the queue reached
        let last = requests[requests.length - 1];
        cursor = { block_index: last.block_index, action_index: last.action_index };
    }
    return null;
}

function buildAttestationRpc(ctx) {
    return Object.assign({}, attestationRequestRpc(ctx), attestationLookupRpc(ctx), responsibleSetRpc(ctx));
}

function attestationRequestRpc(ctx) {
    const { hub } = ctx;
    return {
        async getattestationstats(){
            if(!hub.attestationRound) return {error: "attestation subsystem not active"};
            return hub.attestationRound.getStats();
        },

        async requestattestation({source_chain, source_action_index, dest_chain}){
            if(!source_chain || !source_action_index || !dest_chain)
                return {error: "source_chain, source_action_index, and dest_chain are required"};
            let scErr = validateChain(source_chain);
            if (scErr) return scErr;
            let dcErr = validateChain(dest_chain);
            if (dcErr) return dcErr;
            // strictInt, not the engine's parseInt: parseInt takes an integer PREFIX, so
            // '1e3' became 1 and '1000.9' became 1000, and the coerced value is what the
            // attestation id, the stored row and the PROPOSE payload are built from. A
            // caller that named action 1000 got a quorum round opened over action 1
            // instead of an error. Same band initiateswap/getswap enforce for this field;
            // the CrossChainEngine guard stays as the defence-in-depth backstop.
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            try {
                let attestation = await hub.requestAttestation(source_chain, srcIdx, dest_chain);
                return attestation;
            } catch (err) {
                return {error: err.message || "error requesting attestation"};
            }
        },

        async getattestations({status, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                let cc = hub.getCrossChain();
                if(!cc) return {error: "cross-chain engine not active"};
                return await cc.getAttestations(status, limit);
            } catch (err) {
                return {error: "error fetching attestations"};
            }
        },
    };
}

function attestationLookupRpc(ctx) {
    const { hub } = ctx;
    return {
        async getattestation({source_chain, source_action_index}){
            if(!source_chain || !source_action_index)
                return {error: "source_chain and source_action_index are required"};
            let scErr = validateChain(source_chain);
            if (scErr) return scErr;
            // source_action_index reaches a BIGINT bind in CrossChainEngine.getAttestation,
            // and MariaDB COERCES a non-integer string on comparison instead of erroring:
            // '1e3' reads as action 1000 and garbage reads as 0, so the caller is answered
            // with a DIFFERENT attestation than it named. Same band getswap enforces.
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            try {
                let cc = hub.getCrossChain();
                if(!cc) return {error: "cross-chain engine not active"};
                let att = await cc.getAttestation(source_chain, srcIdx);
                return att || {error: "attestation not found"};
            } catch (err) {
                return {error: "error fetching attestation"};
            }
        },
    };
}

// Read-only mirror of the ranking AttestationRound.computeResponsibleSet applies
// when it decides whether THIS hub must serve a request. Exists so a caller (the
// e2e venue, an operator) can ask who is responsible without re-deriving the rule:
// every input below is resolved through the hub's own engines, never recomputed
// here, so a change to the ranking cannot drift between this answer and a live round.
//
// No state changes and no signing; this differs from a live round only in that it
// runs for ANY request id, not only ones this hub happens to be responsible for.
function responsibleSetRpc(ctx) {
    const { hub, axios } = ctx;
    const findPendingAttestationRequest = (rid) => findPendingRequestOnIndexer(hub, axios, rid);
    return {
        async getattestationresponsibleset({request_id}){
            if(!request_id || typeof request_id !== 'string')
                return {error: "request_id is required"};
            let rid = request_id.trim().toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(rid))
                return {error: "request_id must be a 64-character hex string"};
            let round = hub.getAttestationRound();
            if(!round || typeof round.computeResponsibleSet !== 'function')
                return {error: "attestation round engine not active"};
            try {
                let found = await findPendingAttestationRequest(rid);
                if(!found) return {error: "attestation request not found"};
                let request       = found.request;
                let declaredBlock = Number(request.block_index);
                let redundancy    = Math.max(1, Number(request.redundancy) || 1);
                let weighted      = swq.isStakeWeightedQuorumActive(declaredBlock, hub.network);

                // Buried inside CapabilitySnapshot itself (buriedBlockIndex), same as the
                // gossip verifier at AttestationResponseMirror.js: pass the DECLARED height,
                // never bury it again here.
                let cs = hub.capabilitySnapshot;
                let snapshot = cs
                    ? (weighted ? await cs.getWeightSnapshot('attestation', declaredBlock)
                                : await cs.getSnapshot('attestation', declaredBlock))
                    : null;
                if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)
                    return {error: "no capability snapshot at block " + declaredBlock};

                let reg = hub.getProviderRegistry();
                let providerFloor = (reg && typeof reg.getMinStake === 'function')
                    ? reg.getMinStake(String(request.provider_id), declaredBlock) : null;
                if(weighted && providerFloor === null)
                    return {error: "provider \"" + request.provider_id + "\" has no min_stake floor at block " + declaredBlock};

                let widen = (Number.isFinite(found.latestBlock) && found.latestBlock > 0)
                    ? wid.widenSlots(found.latestBlock, declaredBlock, Number(request.deadline_block), hub.network)
                    : 0;
                let responsible = round.computeResponsibleSet(
                    snapshot.validators, rid, redundancy, weighted, providerFloor, widen
                ).map(v => v.pubkey);

                return {
                    request_id:  rid,
                    block_index: declaredBlock,
                    redundancy:  redundancy,
                    widen:       widen,
                    responsible: responsible
                };
            } catch (err) {
                return {error: "error resolving attestation responsible set"};
            }
        }
    };
}

module.exports = { buildAttestationRpc };
