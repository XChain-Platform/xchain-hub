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

class EncoderClient {

    constructor(encoderUrl, apiKey, timeout) {
        this.encoderUrl = encoderUrl || '';
        this.apiKey     = apiKey || '';
        this.timeout    = timeout || 30000;
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
        let response;
        try {
            response = await axios.post(this.encoderUrl, body, { headers: headers, timeout: this.timeout });
        } catch (err) {
            let rpcErr = err && err.response && err.response.data && err.response.data.error;
            if (rpcErr && Number(err.response.status) < 500) {
                err.message = 'Encoder RPC error: ' + (rpcErr.message || JSON.stringify(rpcErr));
            }
            throw err;
        }
        if (response.data && response.data.error) {
            throw new Error('Encoder RPC error: ' + (response.data.error.message || JSON.stringify(response.data.error)));
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
