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
 * XChain Hub - JSON-RPC cross-chain family: XCALL relay rows, swaps and the
 * bridge escrow invariant.
 *
 ********************************************************************/

const { validateChain, validateLimit, strictInt } = require('../validate');

function buildCrossChainRpc(ctx) {
    return Object.assign({}, crossChainCallRpc(ctx), callListSwapReadsRpc(ctx), swapInitiateRpc(ctx), bridgeInvariantRpc(ctx));
}

function crossChainCallRpc(ctx) {
    const { hub } = ctx;
    return {
        // Get cross-chain call relay backlog depth and lifetime failure counter.
        // pending_relay_count is the number of dispatch rows without a result row
        // (per target chain and total); result_attempt_failures is a process-lifetime
        // count of per-call errors in the relay result poll. Mirrors getattestationstats.
        async getcrosschaincallstats(){
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                return await hub.crossChainCalls.getStats();
            } catch (err) {
                return {error: "error fetching cross-chain call stats"};
            }
        },

        // Surface individual XCALL relay rows (the hub's own cross_chain_calls
        // table), the read companion to getcrosschaincallstats' aggregate counters.
        // getcrosschaincall returns one call's full lifecycle by call_id as
        // {call_id, dispatch, result}; getxcall is a shorter alias (mirrors the
        // explorer's getXcall naming). Read-only, public read tier.
        async getcrosschaincall({call_id}){
            return readCrossChainCall(hub, call_id);
        },

        async getxcall({call_id}){
            return readCrossChainCall(hub, call_id);
        },
    };
}

// Resolve one XCALL lifecycle for both read aliases. A call_id is a 64-char hex
// sha256 (the dispatch path refuses any other shape), so refuse junk before the read.
async function readCrossChainCall(hub, call_id){
    if(!call_id) return {error: "call_id is required"};
    if(typeof call_id !== 'string') return {error: "call_id must be a 64-character hex string"};
    let callId = call_id.trim().toLowerCase();
    if(!/^[0-9a-f]{64}$/.test(callId)) return {error: "call_id must be a 64-character hex string"};
    if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
    try {
        let call = await hub.getCrossChainCall(callId);
        return call || {error: "cross-chain call not found"};
    } catch (err) {
        return {error: "error fetching cross-chain call"};
    }
}

function callListSwapReadsRpc(ctx) {
    const { hub } = ctx;
    return {
        // List XCALL relay rows, newest first, with optional source_chain/target_chain
        // (validated against BTC/LTC/DOGE), status, and phase (dispatch/result) filters.
        async listxcall({source_chain, target_chain, status, phase, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if(source_chain){ let e = validateChain(source_chain); if(e) return e; }
            if(target_chain){ let e = validateChain(target_chain); if(e) return e; }
            if(phase && phase !== 'dispatch' && phase !== 'result')
                return {error: "phase must be 'dispatch' or 'result'"};
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                return await hub.listCrossChainCalls({
                    sourceChain: source_chain, targetChain: target_chain,
                    status, phase, limit
                });
            } catch (err) {
                return {error: "error fetching cross-chain calls"};
            }
        },

        async getswap({source_chain, source_action_index}){
            if(!source_chain || !source_action_index)
                return {error: "source_chain and source_action_index are required"};
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            try {
                let swap = await hub.getSwap(source_chain, srcIdx);
                return swap || {error: "swap not found"};
            } catch (err) {
                return {error: "error fetching swap"};
            }
        },

        async getswaps({status, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getSwaps(status, limit);
            } catch (err) {
                return {error: "error fetching swaps"};
            }
        },
    };
}

function swapInitiateRpc(ctx) {
    const { hub } = ctx;
    return {
        async initiateswap({source_chain, source_action_index, dest_chain, dest_action_index}){
            if(!source_chain || !source_action_index || !dest_chain)
                return {error: "source_chain, source_action_index, and dest_chain are required"};
            let scErr = validateChain(source_chain);
            if (scErr) return scErr;
            let dcErr = validateChain(dest_chain);
            if (dcErr) return dcErr;
            // The index reaches an INSERT into swap_records unvalidated, so a parseInt
            // prefix ('7junk', '1e3') recorded the swap against a different action than
            // the caller named. Same positive-integer band requestAttestation enforces.
            let srcIdx = strictInt(source_action_index);
            if (srcIdx === null || srcIdx <= 0)
                return {error: "source_action_index must be a positive integer"};
            let destIdx = null;
            if (dest_action_index) {
                destIdx = strictInt(dest_action_index);
                if (destIdx === null || destIdx <= 0)
                    return {error: "dest_action_index must be a positive integer"};
            }
            try {
                await hub.initiateSwap(source_chain, srcIdx, dest_chain, destIdx);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error initiating swap"};
            }
        },
    };
}

/**
 * The response shape, frozen up front because three lanes read it:
 * the explorer token page, the wallet move flow and the platform watch script.
 *
 * Open read (aggregate totals are already visible in the explorer). Keyed by tick,
 * then by chain, with XCHAIN always present; an optional `tick` argument narrows it
 * to one entry.
 *
 * THE INVARIANT IS AN INEQUALITY, NOT AN EQUALITY: escrow >= supply per chain,
 * modulo in-flight. Nothing refuses a user credit to a protocol role address today,
 * so a plain SEND can land value on an escrow with no transfer row. That is a
 * SURPLUS, the sender's own loss, like a send to the burn address, and no other
 * holder is unbacked by it: the watch raises WARN. A DEFICIT (supply > escrow) is
 * the only direction in which someone else's units have nothing behind them, and is
 * a forgery or a reorg: the watch raises CRIT. A strict equality any stranger can
 * break with one SEND is an alarm that cries wolf.
 *
 * @typedef {Object} BridgeInvariantEntry
 * @property {string} escrow    - balance of this tick at ADDRESS.BRIDGE_<chain> on
 *   the tick's ORIGIN chain, decimal string
 * @property {string} supply    - this tick's SUPPLY on `chain`, decimal string
 * @property {string} in_flight - total amount of transfers whose source leg has
 *   applied and whose destination leg has NOT. The window includes the confirmation
 *   wait and the attestation round, not only "finalized but unapplied"
 * @property {string} delta     - signed escrow - (supply + in_flight); positive is a
 *   surplus (WARN), negative a deficit (CRIT)
 * @property {number|null} finalized_policy_seq - highest FINALIZED policy_seq the
 *   hub holds for this tick, or null when the tick carries no policy snapshot. The
 *   hub knows only what it finalized; the APPLIED seq is read per destination
 *   through the indexer's getappliedpolicy
 *
 * @typedef {Object.<string, Object.<string, BridgeInvariantEntry>>} BridgeInvariant
 *   tick -> chain -> entry
 */
function bridgeInvariantRpc(ctx) {
    const { hub } = ctx;
    return {
        // OPEN READ TIER on purpose (not in WRITE_METHODS, not in SENSITIVE_READ_METHODS):
        // the aggregate totals are already visible in the explorer, and the explorer token
        // page, the wallet move flow and the platform watch script all read it without
        // a federation key. `tick` narrows the map to one entry; without it XCHAIN is always
        // present so the base asset can be read on a chain that has carried no token leg.
        // Body: { tick?: string }
        async getbridgeinvariant({tick}){
            if(!hub.crossChainBridge) return {error: "cross-chain bridge engine not active"};
            if(tick !== undefined && tick !== null && typeof tick !== 'string')
                return {error: "tick must be a string"};
            // The tick is used as an object key and a SQL parameter, never interpolated, but
            // bound its length to the column so a megabyte of junk cannot be echoed back.
            if(typeof tick === 'string' && tick.length > 250)
                return {error: "tick must be at most 250 characters"};
            try {
                return await hub.crossChainBridge.getBridgeInvariant(tick || null);
            } catch (err) {
                return {error: "error reading the bridge invariant"};
            }
        },
    };
}

module.exports = { buildCrossChainRpc };
