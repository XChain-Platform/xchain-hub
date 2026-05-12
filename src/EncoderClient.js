/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Hub - Encoder Client
 *
 * Minimal JSON-RPC 2.0 client for talking to the xchain-encoder REST API.
 * Used by OraclePublisher to construct, broadcast, and look up UTXOs for
 * PRICE v0 transactions on the DOGE chain. Pure axios — no SDK dependency.
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

    // Make a JSON-RPC 2.0 call to the encoder
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

    // Fetch UTXOs for an address (proxies to UTXO tracker via encoder)
    async getUtxos(address) {
        return this._call('get_utxos', { address: address });
    }

    // Create an unsigned PSBT transaction with embedded data payload
    // params: { utxos, pubkey, data, change, encoding, fee, ... }
    async createTx(params) {
        return this._call('create_tx', params);
    }

    // Broadcast a signed transaction hex to the coin network
    async broadcastTx(txHex) {
        return this._call('broadcast_tx', { tx_hex: txHex });
    }
}

module.exports = EncoderClient;
