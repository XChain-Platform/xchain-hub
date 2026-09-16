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
 * XChain Hub - JSON-RPC reorg retraction family: the rails an indexer calls when
 * a reorg takes back what it pushed. Every method is a REORG_WRITE_METHODS and
 * FEED_RPC_METHODS member.
 *
 ********************************************************************/

const { validateChain } = require('../validate');

function buildFeedReorgRpc(ctx) {
    return Object.assign({}, attestRetractRpc(ctx), priceCallReorgRpc(ctx), dexBridgeReorgRpc(ctx));
}

function attestRetractRpc(ctx) {
    const { hub } = ctx;
    return {
        // Retract the batch LINK after a reorg un-landed an ATTEST v5/v6 batch on the
        // pushing indexer's chain (spec section 6.3, frontier row 55). The indexer names
        // the batch by its key, the window bounds that key is derived from, and the
        // action index the landing push carried; the hub clears `batch_action_index` on
        // the rows that link names and re-broadcasts them. NOTHING IS DELETED here: a
        // signed mirror row is legitimate whichever batch carried it, so the reorg
        // invalidates the link and not the response (AttestationResponseMirror
        // .retractBatchLink says why at length).
        //
        // The parameter list IS the interface, and the indexer's HubClient pins exactly
        // these names.
        async retractattestbatch({source_chain, network, batch_key, window_start, window_end, action_index}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(!batch_key) return {error: "batch_key is required"};
            if(action_index === undefined || action_index === null)
                return {error: "action_index is required"};
            if(!hub.attestationResponseMirror) return {error: "attestation response mirror not ready"};
            try {
                return await hub.attestationResponseMirror.retractBatchLink(source_chain, {
                    network:      network,
                    batch_key:    batch_key,
                    window_start: window_start,
                    window_end:   window_end,
                    action_index: action_index
                });
            } catch (err) {
                return {error: err.message || "error retracting the attestation batch link"};
            }
        },
    };
}

function priceCallReorgRpc(ctx) {
    const { hub } = ctx;
    return {
        // Retract price rows after an indexer rolled back PRICE actions in a reorg.
        // The indexer pushes the source chain plus the lowest rolled-back action_index;
        // the hub prunes every price_snapshots / oracle_prices row for that chain whose
        // source action_index is >= that value, then broadcasts the deletions so
        // distributed indexers prune their local copies too.
        // to_action_index (optional) bounds the retraction to a CLOSED range [from, to] for a
        // DEFERRED (queued) retraction, so a row re-published inside the original open-ended range
        // is not wiped (item 5296). Absent => open-ended, the original behavior for live retractions.
        // retraction_generation (optional, item 5308) fences the delete to rows with
        // push_generation <= it; an older indexer omits it and the hub falls back to no-fence.
        async pushpricereorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                return await hub.priceAggregator.retractFromActionIndex(source_chain, from_action_index, to_action_index, retraction_generation);
            } catch (err) {
                return {error: err.message || "error retracting prices"};
            }
        },

        // Retract cross_chain_calls relay rows after an indexer rolled back XCALL request
        // actions in a reorg. The indexer pushes its source chain plus the lowest rolled-back
        // action_index; the hub marks the matching relay rows 'retracted' (both phases) and
        // broadcasts deletions so distributed indexers prune their mirrored copies too.
        async pushxcallreorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.crossChainCalls) return {error: "cross-chain call engine not active"};
            try {
                await hub.crossChainCalls.retractCallsForReorg(source_chain, from_action_index, to_action_index, retraction_generation);
                return {status: "ok", source_chain, from_action_index};
            } catch (err) {
                return {error: err.message || "error retracting cross-chain calls"};
            }
        },
    };
}

function dexBridgeReorgRpc(ctx) {
    const { hub } = ctx;
    return {
        // Retract cross_chain_matches rows after an indexer rolled back DEX ORDER actions in a
        // reorg. The indexer pushes its source chain plus the lowest rolled-back action_index; the
        // hub marks every match whose retracted leg (a_chain/b_chain) is on that source chain at or
        // above that index 'retracted', restores both legs' remaining capacity, and broadcasts
        // deletions so distributed indexers prune their mirrored cross_chain_matches copies too.
        async pushdexreorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.crossChainDex) return {error: "cross-chain dex engine not active"};
            try {
                await hub.crossChainDex.retractMatchesForReorg(source_chain, from_action_index, to_action_index, retraction_generation);
                return {status: "ok", source_chain, from_action_index};
            } catch (err) {
                return {error: err.message || "error retracting cross-chain matches"};
            }
        },

        // Retract bridge_transfers records after an indexer rolled back XBRIDGE lock/burn
        // actions in a reorg. The indexer pushes its source chain plus the lowest rolled-back
        // action_index; the hub marks every record whose SOURCE leg sits at or above that
        // index 'retracted' and broadcasts deletions so mirrors drop the row.
        //
        // A record the destination has NOT applied is then never applied. One already
        // applied stays applied (base spec D16: milestone 1 ships no destination-side
        // unwind, because the destination chain did not reorg and a forward un-mint would
        // change its hashes forward, never back); getbridgeinvariant then reports the
        // deficit and the watch item raises CRIT. policy_snapshots has no retraction path:
        // it is append-only and a later policy_seq supersedes.
        async pushbridgereorg({source_chain, from_action_index, to_action_index, retraction_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            let chainErr = validateChain(source_chain);
            if (chainErr) return chainErr;
            if(from_action_index === undefined || from_action_index === null)
                return {error: "from_action_index is required"};
            if(!hub.crossChainBridge) return {error: "cross-chain bridge engine not active"};
            try {
                let retracted = await hub.crossChainBridge.retractTransfersForReorg(
                    source_chain, from_action_index, to_action_index, retraction_generation);
                return {status: "ok", source_chain, from_action_index, retracted};
            } catch (err) {
                return {error: err.message || "error retracting bridge transfers"};
            }
        },
    };
}

module.exports = { buildFeedReorgRpc };
