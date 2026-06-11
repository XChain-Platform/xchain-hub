/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Reference HUB_SIGNER_MODULE — DOGE publisher signing via xchain-sdk.
 *
 * The hub's on-chain publishers (PRICE v0 / ANCHOR) build PSBTs through the
 * encoder and call walletSign(psbtHex) to have the operator sign them. This
 * module is the reference implementation of that contract.
 *
 * Install (host running the hub container via xchain-node):
 *
 *   1. mkdir ~/hub-signer && cd ~/hub-signer
 *      cp <this file> signer.js
 *      npm install xchain-sdk dotenv
 *   2. Put the publisher key in ~/hub-signer/.env (chmod 600):
 *        DOGE_WIF=<WIF for the funded DOGE_ADDRESS>
 *        DOGE_NETWORK=dogecoin-mainnet
 *      The key never leaves this directory — it is NOT part of the hub's
 *      container env or xchain-node config.
 *   3. Set on the host (xchain-node's .env):
 *        XCHAIN_NODE_HUB_SIGNER_DIR=/home/<user>/hub-signer
 *      and re-run `xchain-node update xchain-hub` (or install). xchain-node
 *      mounts the directory read-only at /XChainHub/operator-signer and sets
 *        HUB_SIGNER_MODULE=/XChainHub/operator-signer/signer.js
 *   4. Configure the publisher pipeline env (already passthrough-supported):
 *        DOGE_ENCODER_URL, DOGE_ADDRESS, DOGE_PUBKEY_HEX
 *
 * Contract: walletSign is REQUIRED; broadcast/getBalance are optional (the
 * hub's default pipeline handles UTXO fetch → PSBT build → broadcast through
 * the encoder, so this reference only signs).
 *
 ********************************************************************/

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { XChainSDK } = require('xchain-sdk');

const NETWORK = process.env.DOGE_NETWORK || 'dogecoin-mainnet';
const WIF     = process.env.DOGE_WIF || '';

if (!WIF) {
    // Fail at load time (the hub treats a configured-but-broken signer as fatal):
    // a signer module without its key cannot fulfill the contract.
    throw new Error('doge-signer: DOGE_WIF is not set in ' + path.join(__dirname, '.env'));
}

const sdk = new XChainSDK({ network: NETWORK });

module.exports = {
    // Sign an encoder-built PSBT with the publisher's DOGE key.
    // psbtHex → signed raw transaction hex.
    async walletSign(psbtHex) {
        return sdk.wallet.signPsbt(psbtHex, WIF);
    }
};
