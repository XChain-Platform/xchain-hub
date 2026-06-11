/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Reference HUB_SIGNER_MODULE — DOGE publisher pipeline via xchain-sdk.
 *
 * The hub's on-chain publishers (PRICE v0 / ANCHOR) hand this module a raw
 * wire payload via the `broadcast` hook. XChain payloads exceed OP_RETURN
 * size, so they ride the TWO-PHASE P2SH encoding: a phase-1 transaction
 * funds P2SH outputs whose redeem scripts embed the data, and a phase-2
 * transaction spends them, revealing the data on-chain — only phase 2 is
 * decodable. The hub's built-in walletSign-only pipeline covers just
 * phase 1, so a production signer module should export `broadcast` (this
 * full pipeline, mirroring sdk lifecycleManager.submitAction) rather than
 * rely on `walletSign` alone.
 *
 * Install (host running the hub container via xchain-node):
 *
 *   1. mkdir ~/hub-signer && cd ~/hub-signer
 *      cp <this file> signer.js
 *      npm install github:XChain-Platform/xchain-sdk dotenv
 *   2. Put the publisher key + pipeline config in ~/hub-signer/.env (chmod 600):
 *        DOGE_WIF=<WIF for the funded publisher address>
 *        DOGE_NETWORK=dogecoin-mainnet
 *        DOGE_ADDRESS=<publisher p2pkh address>
 *        DOGE_ENCODER_URL=<encoder JSON-RPC endpoint for this network>
 *        DOGE_FEE_PER_KB=0.01            # optional, coin/kB; omit → node estimate
 *      The key never leaves this directory — it is NOT part of the hub's
 *      container env or xchain-node config.
 *   3. Set on the host (xchain-node's .env):
 *        XCHAIN_NODE_HUB_SIGNER_DIR=/home/<user>/hub-signer
 *      and re-run `xchain-node update xchain-hub`. xchain-node mounts the
 *      directory read-only at /XChainHub/operator-signer and sets
 *        HUB_SIGNER_MODULE=/XChainHub/operator-signer/signer.js
 *   4. Also set DOGE_ADDRESS / DOGE_PUBKEY_HEX / DOGE_ENCODER_URL in the
 *      hub's own env (host .env passthrough) — the publishers use them for
 *      election, balance checks, and low-balance warnings.
 *
 ********************************************************************/

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { XChainSDK } = require('xchain-sdk');

const NETWORK    = process.env.DOGE_NETWORK || 'dogecoin-mainnet';
const WIF        = process.env.DOGE_WIF || '';
const ADDRESS    = process.env.DOGE_ADDRESS || '';
const ENCODER    = process.env.DOGE_ENCODER_URL || '';
const FEE_PER_KB = process.env.DOGE_FEE_PER_KB ? Number(process.env.DOGE_FEE_PER_KB) : undefined;

// Fail at load time (the hub treats a configured-but-broken signer as fatal):
// a signer module that cannot fulfill its contract must not boot quietly.
for (const [name, value] of [['DOGE_WIF', WIF], ['DOGE_ADDRESS', ADDRESS], ['DOGE_ENCODER_URL', ENCODER]]) {
    if (!value) throw new Error('doge-signer: ' + name + ' is not set in ' + path.join(__dirname, '.env'));
}

const sdk = new XChainSDK({ network: NETWORK, encoderUrl: ENCODER });

module.exports = {
    // Full publish pipeline for a raw wire payload string → { txid }.
    // Mirrors sdk lifecycleManager.submitAction's encode/sign/broadcast +
    // P2SH phase-2 reveal, minus the action-composition step (the hub hands
    // a ready payload). The returned txid is the PHASE-2 (reveal) txid when
    // two-phase encoding is used — that is the transaction indexers decode.
    async broadcast(payload) {
        const encoder = sdk._requireEncoder();

        const txParams = { data: payload, pubkey: ADDRESS, change: ADDRESS, encoding: 'P2SH' };
        if (FEE_PER_KB !== undefined) txParams.feePerKb = FEE_PER_KB;

        // Phase 1: fund the data-carrying P2SH outputs.
        const encoded = await encoder.createTx(txParams);
        const signed  = sdk.wallet.signPsbt(encoded.psbt, WIF);
        await encoder.broadcastTx(signed.txHex);
        if (encoded.encoding !== 'P2SH' && encoded.encoding !== 'P2WSH')
            return { txid: signed.txid };

        // Phase 2: spend them, revealing the payload on-chain.
        const spendParams = {
            pubkey:   ADDRESS,
            p2shHash: signed.txid,
            p2shHex:  signed.txHex,
            data:     payload,
            encoding: encoded.encoding,
            change:   ADDRESS
        };
        if (FEE_PER_KB !== undefined) spendParams.feePerKb = FEE_PER_KB;
        const spendResult = await encoder.spendP2sh(spendParams);
        const spendSigned = sdk.wallet.signRevealPsbt(spendResult.psbt, WIF);
        await encoder.broadcastTx(spendSigned.txHex);

        return { txid: spendSigned.txid, phase1_txid: signed.txid };
    },

    // Sign an encoder-built PSBT → signed raw tx hex. Kept for the hub's
    // built-in (phase-1-only) pipeline and balance plumbing; `broadcast`
    // above takes precedence when both are exported.
    async walletSign(psbtHex) {
        return sdk.wallet.signPsbt(psbtHex, WIF).txHex;
    }
};
