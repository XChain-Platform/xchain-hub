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
 * XChain Hub - Encoder Client
 *
 * Minimal JSON-RPC 2.0 client for talking to the xchain-encoder REST API.
 * Used by OraclePublisher to construct, broadcast, and look up UTXOs for
 * PRICE v0 transactions on the DOGE chain. Pure axios, no SDK dependency.
 *
 ********************************************************************/

const axios = require('axios');

// Outer HTTP budget for one hub -> encoder JSON-RPC round trip. It must stay STRICTLY
// GREATER than the encoder's worst-case INNER budget, and the previous 30000 was exactly
// equal to it, which is a real failure and not a rounding concern.
//
// The encoder's per-node-RPC budget is NODE_RPC_TIMEOUT (xchain-encoder
// BlockchainConnector.js, default 30000), and the encoder cannot answer before its own
// RPC finishes. The longest sequential chain one broadcast_tx can run is three of those:
// _sendRaw, then an uncached chainName() for the isRegtest gate on the fee-cap recovery
// path, then the retry _sendRaw. So the encoder's worst case is 90000 and this budget is
// 4x the single hop, leaving a hop of margin for the hub -> encoder network leg and the
// encoder's own work.
//
// Equality is what made this load-bearing rather than cosmetic: an axios abort carries no
// HTTP response and none of the never-sent error codes, so isAmbiguousSendError
// (lib/idempotent_broadcast.js) correctly reads it as a POSSIBLY-LANDED broadcast, and the
// publishers then commit the spend reservation and dead-letter the round for manual
// on-chain verification. A client that cannot outlast the server it calls converts a
// healthy broadcast into operator work.
//
// The cost of erring long is bounded and the cost of erring short is not: every publisher
// that awaits this call already carries a sweep re-entrancy guard (OraclePublisher and
// AttestationPublisher `_sweeping`, the FullNodeChallengeRound._tick house convention), so
// a slow pass skips ticks rather than stacking overlapping money-path passes, and the
// round deadlines these effectors honour are counted in BLOCKS, not in this many ms.
//
// An operator who raises NODE_RPC_TIMEOUT past 40000 re-inverts this. There is
// deliberately no env override here: an env-only read would be a dead knob in an api.js
// child, where the house pattern is `process.env.X || cfg.X` and every one of the eight
// construction sites passes only (url, key). Making it configurable means threading it
// from those call sites, which is its own change.
const DEFAULT_ENCODER_TIMEOUT_MS = 120000;

class EncoderClient {

    constructor(encoderUrl, apiKey, timeout) {
        this.encoderUrl = encoderUrl || '';
        this.apiKey     = apiKey || '';
        // Validated rather than bare-truthy, but a non-positive value deliberately falls
        // BACK rather than being honoured: axios reads timeout 0 as no timeout at all, so
        // an explicit 0 would disarm the budget entirely and wedge a publisher pass on a
        // hung encoder. This is the opposite call from a plain numeric knob, and for the
        // reason that only applies to timeouts.
        let requested = Number(timeout);
        this.timeout    = (Number.isFinite(requested) && requested > 0)
            ? requested : DEFAULT_ENCODER_TIMEOUT_MS;
        this._rpcId     = 0;
    }

    async _call(method, params) {
        if (!this.encoderUrl) throw new Error('EncoderClient: encoderUrl not configured');
        let body = {
            jsonrpc: '2.0',
            method:  method,
            params:  params || {},
            id:      ++this._rpcId
        };
        let headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        // The encoder answers several failures with a non-2xx status AND a JSON-RPC error
        // body carrying the actual reason (401 -32001 Unauthorized, 429 -32029 Too many
        // requests, 400 -32600 Batch too large). axios rejects on those before the
        // response.data.error check below ever runs, so every publisher surface logged the
        // bare 'Request failed with status code 429' and lost the one thing an operator
        // needs: whether the encoder is misconfigured, shedding load, or being handed an
        // oversized batch. Unwrap the body the way CapabilitySnapshot._onFetchError does.
        //
        // Two constraints, both load-bearing:
        //   - RETHROW THE SAME OBJECT, never a fresh Error. isAmbiguousSendError
        //     (lib/idempotent_broadcast.js) reads e.response.status, and so do the
        //     dead-letter records; a wrapper drops both.
        //   - Rewrite the message ONLY below status 500. That classifier reads an
        //     'Encoder RPC error' message as a definitive rejection that is safe to
        //     re-broadcast. A 5xx may already have reached the coin node, so prefixing one
        //     would turn an ambiguous send into a retry and risk a double spend. 5xx
        //     messages therefore pass through untouched.
        //
        // Both branches also mirror the encoder's STRUCTURED error onto the thrown
        // error as `rpcCode` and `rpcData`. create_tx and create_envelope_cancel_tx
        // answer their operational failures (no UTXOs, insufficient funds, missing
        // change address, tracker unavailable) with code -32010 and a stable
        // machine-readable `data.reason`, and that field exists precisely so a caller
        // can branch on the condition instead of matching substrings of a message that
        // is free to be reworded. Attached ADDITIVELY (own properties on the same
        // object, message and `response` untouched) so the classifier rules above are
        // unaffected, and named `rpcData` rather than `data` so it can never be
        // confused with an axios response body.
        let response;
        try {
            response = await axios.post(this.encoderUrl, body, { headers: headers, timeout: this.timeout });
        } catch (err) {
            let rpcErr = err && err.response && err.response.data && err.response.data.error;
            if (rpcErr && Number(err.response.status) < 500) {
                err.message = 'Encoder RPC error: ' + (rpcErr.message || JSON.stringify(rpcErr));
            }
            if (rpcErr) {
                err.rpcCode = rpcErr.code;
                err.rpcData = rpcErr.data;
            }
            throw err;
        }
        if (response.data && response.data.error) {
            let rpcErr = response.data.error;
            let e = new Error('Encoder RPC error: ' + (rpcErr.message || JSON.stringify(rpcErr)));
            e.rpcCode = rpcErr.code;
            e.rpcData = rpcErr.data;
            throw e;
        }
        return response.data ? response.data.result : null;
    }

    // Fetch UTXOs for an address (proxies to UTXO tracker via encoder).
    // The live encoder wraps the list as { utxos: [...] } (the tracker's
    // get_utxos shape); unwrap it so callers can feed the result straight
    // into create_tx, which requires a bare array. Tolerates an already-bare
    // array (test stubs / older encoders).
    async getUtxos(address) {
        let result = await this._call('get_utxos', { address: address });
        if (result && Array.isArray(result.utxos)) return result.utxos;
        return result;
    }

    // Create an unsigned PSBT transaction with embedded data payload
    // params: { utxos, pubkey, data, change, encoding, fee, ... }
    async createTx(params) {
        return this._call('create_tx', params);
    }

    async broadcastTx(txHex) {
        return this._call('broadcast_tx', { tx_hex: txHex });
    }
}

module.exports = EncoderClient;
