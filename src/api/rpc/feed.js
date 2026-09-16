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
 * XChain Hub - JSON-RPC forward feed family: what an indexer reports landed on
 * its chain (chain tips, price rounds and batches, attest batches, oracle
 * prices). Every method is a WRITE_METHODS and FEED_RPC_METHODS member.
 *
 ********************************************************************/

const { validateChain, strictInt, rpcParamError } = require('../validate');

function buildFeedRpc(ctx) {
    return Object.assign({}, chainTipFeedRpc(ctx), priceRoundFeedRpc(ctx), priceBatchFeedRpc(ctx), attestBatchFeedRpc(ctx), oraclePriceFeedRpc(ctx));
}

function chainTipFeedRpc(ctx) {
    const { hub } = ctx;
    return {
        // Network is optional for back-compat with older indexers; defaults to 'mainnet'.
        // chain_id is optional too: only a Bitcoin indexer sends it (the hash of ITS block 1),
        // and it is what lets a mirror refuse cross-chain rows written by a hub that followed a
        // different chain instance. Absent leaves the stored identity untouched.
        async pushchaintip({coin, network, block_height, block_time, chain_id}){
            if(!coin) return {error: "coin is required"};
            // THROWN, not returned: an unknown coin is a refusal, and returned it landed
            // in the envelope's result slot where a caller checking only `error` read it
            // as a stored tip. The chain tip gates staleness checks fleet-wide, so a
            // silently-refused push is worse here than a noisy one. Its only mesh caller is
            // fire-and-forget (the indexer's hub client logs and moves on), and the four
            // durable push handlers below now throw the same code, which their client
            // classifies terminal off the code rather than off an in-envelope message. Same
            // wording either way, so logs and operator runbooks are unchanged.
            let chainErr = validateChain(coin);
            if (chainErr) throw rpcParamError(chainErr.error);
            if(block_height === undefined || block_height === null)
                return {error: "block_height is required"};
            if(block_time === undefined || block_time === null)
                return {error: "block_time is required"};
            // strictInt, not parseInt: '850000junk' and '850000.9' truncated to a
            // plausible 850000 and were written as the tip the staleness gates read.
            let height = strictInt(block_height);
            if (height === null || height < 0)
                return {error: "invalid block_height"};
            let time = strictInt(block_time);
            if (time === null || time < 0)
                return {error: "invalid block_time"};
            // Reject before the write, not after: a malformed identity stored on the tip
            // would be stamped onto every later match and call row and would make every
            // mirror refuse rows this hub is authoritative for.
            let chainId = undefined;
            if (chain_id !== undefined && chain_id !== null) {
                if (typeof chain_id !== 'string' || !/^[0-9a-f]{64}$/.test(chain_id))
                    return {error: "invalid chain_id"};
                chainId = chain_id;
            }
            try {
                await hub.db.setChainTip(coin, network, height, time, chainId);
                return {status: "success"};
            } catch (err) {
                return {error: err.message || "error pushing chain tip"};
            }
        },
    };
}

function priceRoundFeedRpc(ctx) {
    const { hub } = ctx;
    return {
        // Indexer has already verified PBFT signatures locally; hub deduplicates by round_number.
        async pushpriceround({source_chain, round, timestamp, btc_block_height, pairs, sigs, action_index, block_index, push_generation, admit_blocks}){
            if(!source_chain) return {error: "source_chain is required"};
            // THROWN, not returned, on this handler and the three durable push siblings below
            // (pushpricebatch, pushattestbatch, pushoracleprice). Returned, the refusal landed
            // in the envelope's result slot, where a caller that checks only the envelope's
            // `error` field read a refused push as an accepted one. An unknown chain is a
            // property of the payload, so it is the one refusal a replay can never clear: the
            // queued row carries the same source_chain into the same verdict forever.
            //
            // Only the remaining in-envelope guards below stay returned. They describe the
            // HUB's state (an aggregator still booting, a DB error), which a later attempt can
            // clear, and the push client must go on reading those as retryable.
            //
            // The refusal is only bounded on the caller's side once its push client treats
            // -32602 as terminal, which is why that change ships in the same release as this
            // one; on its own, this half turns every unknown-chain push into a row that
            // retries forever. The message text is unchanged in both directions.
            let chainErr = validateChain(source_chain);
            if (chainErr) throw rpcParamError(chainErr.error);
            if(round === undefined || round === null) return {error: "round is required"};
            if(!Array.isArray(pairs)) return {error: "pairs must be an array"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveValidatedRound(source_chain, {
                    round:            round,
                    timestamp:        timestamp,
                    btc_block_height: btc_block_height,
                    pairs:            pairs,
                    sigs:         sigs,
                    action_index: action_index,
                    block_index:  block_index,
                    // HUB-RETRACT-4: forward the source rollback generation (was dropped here, so
                    // every row was stamped generation 0 and the reorg fence was inert).
                    push_generation: push_generation,
                    // THE ADMISSION MAP'S WIRE CARRIER on this rail. receiveValidatedRound has
                    // read roundData.admit_blocks since the canonical gained the field, but this
                    // destructure dropped it, so every pushed round arrived with the map absent
                    // and read as a LEGACY round however it was signed: above the activation the
                    // canonical builder then refuses it. Forwarded, never rebuilt here: the
                    // producer signed THIS map and one re-resolved from the hub's own tips would
                    // rebuild bytes no signature covers. Absent stays absent, which is exactly
                    // what a legacy round is.
                    admit_blocks: admit_blocks
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing price round"};
            }
        },
    };
}

function priceBatchFeedRpc(ctx) {
    const { hub } = ctx;
    return {
        // PRICE batch counterpart to pushpriceround (spec section 5.7): one signed
        // action carries every finalized round in an hourly window as rounds[], keyed
        // by the batch's own first_round/last_round/btc_block_height rather than a
        // single round. block_time is new (not on pushpriceround): the hub's
        // pair-name flag day keys per round on that round's TIMESTAMP, and batching
        // widens the hub/chain clock skew from ~10 min to ~70 min, so the push must
        // carry the landing chain's own clock for that gate to resolve correctly.
        // Indexer has already verified the batch's PBFT signatures locally; the hub
        // re-verifies once via receiveValidatedBatch, then dedupes per round.
        async pushpricebatch({source_chain, first_round, last_round, btc_block_height, rounds, block_time, sigs, action_index, block_index, push_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            // Thrown for the reason spelled out on pushpriceround above.
            let chainErr = validateChain(source_chain);
            if (chainErr) throw rpcParamError(chainErr.error);
            if(first_round === undefined || first_round === null) return {error: "first_round is required"};
            if(last_round === undefined || last_round === null) return {error: "last_round is required"};
            if(!Array.isArray(rounds)) return {error: "rounds must be an array"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveValidatedBatch(source_chain, {
                    first_round:      first_round,
                    last_round:       last_round,
                    btc_block_height: btc_block_height,
                    rounds:           rounds,
                    block_time:       block_time,
                    sigs:         sigs,
                    action_index: action_index,
                    block_index:  block_index,
                    // HUB-RETRACT-4 precedent (pushpriceround above): forward the
                    // source rollback generation so the reorg fence is not inert.
                    push_generation: push_generation
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing price batch"};
            }
        },
    };
}

function attestBatchFeedRpc(ctx) {
    const { hub } = ctx;
    return {
        // The ATTEST response batch counterpart to pushpricebatch (the ATTEST
        // response-mirror design, §6.3 / decisions D72 and D78). One signed ATTEST v5
        // action carries every terminal response of a window; the DOGE indexer that
        // parsed it pushes the reassembled body here, and this hub turns it back into
        // mirror rows every BTC indexer then verifies for itself. That is the whole
        // chain-only rebuild road: without it a node with no mirror connection could
        // never reach the rows the chain already carries.
        //
        // The parameter list IS the interface, and the indexer's own push builder pins
        // exactly these names. `rows` and `sigs` are the reassembled body verbatim, so
        // the hub re-verifies the same bytes the indexer verified rather than a
        // re-serialization of them; `block_time` rides along for the reason the price
        // batch carries it (batching widens the hub/chain clock skew).
        async pushattestbatch({source_chain, network, window_start, window_end, row_count, btc_block_height, rows, sigs, action_index, block_index, block_time, push_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            // Thrown for the reason spelled out on pushpriceround above.
            let chainErr = validateChain(source_chain);
            if (chainErr) throw rpcParamError(chainErr.error);
            if(!Array.isArray(rows)) return {error: "rows must be an array"};
            if(!hub.attestationResponseMirror) return {error: "attestation response mirror not ready"};
            try {
                return await hub.attestationResponseMirror.receiveValidatedBatch(source_chain, {
                    network:          network,
                    window_start:     window_start,
                    window_end:       window_end,
                    row_count:        row_count,
                    btc_block_height: btc_block_height,
                    rows:             rows,
                    sigs:             sigs,
                    action_index:     action_index,
                    block_index:      block_index,
                    block_time:       block_time,
                    // Forwarded for parity with the price pushes even though nothing on
                    // this path deletes: every effect here is idempotent, so a stale
                    // generation is absorbed rather than fenced.
                    push_generation:  push_generation
                });
            } catch (err) {
                return {error: err.message || "error processing attestation batch"};
            }
        },
    };
}

function oraclePriceFeedRpc(ctx) {
    const { hub } = ctx;
    return {
        async pushoracleprice({source_chain, source_address, coin, tick, fiat, value, fee, memo, block_time, action_index, push_generation}){
            if(!source_chain) return {error: "source_chain is required"};
            // Thrown for the reason spelled out on pushpriceround above.
            let chainErr = validateChain(source_chain);
            if (chainErr) throw rpcParamError(chainErr.error);
            if(!source_address) return {error: "source_address is required"};
            if(!coin || !tick || !fiat || !value)
                return {error: "coin, tick, fiat, value are required"};
            if(!hub.priceAggregator) return {error: "price aggregator not ready"};
            try {
                let result = await hub.priceAggregator.receiveOraclePrice(source_chain, {
                    source_address: source_address,
                    coin:           coin,
                    tick:           tick,
                    fiat:           fiat,
                    value:          value,
                    fee:            fee,
                    memo:           memo,
                    block_time:     block_time,
                    action_index:   action_index,
                    // HUB-RETRACT-4: forward the source rollback generation (was dropped here, so
                    // every row was stamped generation 0 and the reorg fence was inert).
                    push_generation: push_generation
                });
                return result;
            } catch (err) {
                return {error: err.message || "error processing oracle price"};
            }
        },
    };
}

module.exports = { buildFeedRpc };
