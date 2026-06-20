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
        let response = await axios.post(this.encoderUrl, body, { headers: headers, timeout: this.timeout });
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
