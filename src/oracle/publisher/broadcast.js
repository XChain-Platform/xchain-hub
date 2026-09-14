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
 * XChain Hub - Oracle Publisher: the broadcast hooks and the default pipeline
 *
 * The operator-wired hooks, the default encoder pipeline around the shell's
 * buildSignedTx, the shared ambiguity classifier and the DOGE balance read.
 *
 ********************************************************************/

'use strict';

const { isAmbiguousSendError } = require('../../lib/idempotent_broadcast.js');
const { sumUtxosCoins } = require('../../lib/utxo_balance.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Set a custom broadcast hook (overrides the default encoder-based pipeline)
    // The function receives the PRICE v0 wire payload string and should return { txid }
    setBroadcastHook(fn) {
        this.broadcastFn = fn;
    },

    // Set the wallet signing hook (required for the default broadcast pipeline)
    // The function receives a PSBT hex string and should return a signed transaction hex string
    // Operators wire this to xchain-sdk's wallet.signPsbt() or any equivalent signer
    setWalletSignHook(fn) {
        this.walletSignFn = fn;
    },

    // Set the balance query hook
    setBalanceHook(fn) {
        this.getBalanceFn = fn;
    },

    // Default broadcast pipeline: uses the EncoderClient + walletSignFn to construct, sign, and broadcast
    // a PRICE v0 transaction to the DOGE chain. Returns { txid } on success.
    // This is used automatically when no custom broadcastFn is set but encoder + walletSignFn are configured.
    async defaultBroadcast(payload) {
        // Everything down to step 4 builds and signs: no money has moved and nothing has
        // left this process, so every failure here is DEFINITIVELY never-sent whatever it
        // looks like on the socket. Tag them, because the shared classifier answers
        // "ambiguous" for any error it does not recognise (isAmbiguousSendError's final
        // `return true`), which is the right default for a broadcaster this module knows
        // nothing about and the wrong one for a stage it knows cannot send. Untagged, a
        // get_utxos timeout dead-lettered a round that was never broadcast, permanently
        // removing it from automatic retry. Same convention and same reason as
        // AttestationRelay's _relayPreSend.
        return await this.runDefaultBroadcast(payload);
    },

    async runDefaultBroadcast(payload) {
        let txHex;
        try {
            txHex = await this.buildSignedTx(payload);
        } catch (e) {
            if (e) e.oraclePreSend = true;
            throw e;
        }

        // 4. Broadcast the signed transaction. Only this call has a side effect, so only
        // ITS failures are classified for ambiguity (item 2675): a timeout / mid-flight
        // reset / 5xx AFTER the request left the wire may mean the DOGE node actually
        // accepted the tx, so a blind retry would spend a second fee and double-anchor
        // the round.
        try {
            let broadcastResult = await this.encoder.broadcastTx(txHex);
            return broadcastResult || { txid: null };
        } catch (e) {
            if (this.isAmbiguousSendError(e)) e.oracleAmbiguousSend = true;
            throw e;
        }
    },

    // Classify a broadcast failure (delegates to the shared classifier so
    // all four hub effectors answer "could this send have landed?" identically).
    isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    },

    // Check DOGE balance and log warnings if below threshold
    // Uses the operator's getBalanceFn if set, otherwise falls back to summing UTXOs from the encoder.
    // Returns the balance (in DOGE) or null if no source is available.
    async checkBalance() {
        let balance = null;
        if (this.getBalanceFn) {
            try {
                balance = await this.getBalanceFn();
            } catch (err) {
                logger.warn(nodeUtil.format('OraclePublisher: custom balance check failed:', err));
                return null;
            }
        } else if (this.encoder && this.dogeAddress) {
            // Default: sum the configured address's UTXOs into a DOGE balance.
            // get_utxos reports each output in satoshis (`value`), and every
            // consumer of this figure is whole-DOGE (lowBalanceThreshold, the
            // fail-closed gate in _processQueue, spendGuard.minBalance, the
            // monitor's dogeBalance alert), so the conversion is not optional.
            // Units and the fallback order: lib/utxo_balance.js.
            try {
                let utxos = await this.encoder.getUtxos(this.dogeAddress);
                if (Array.isArray(utxos)) balance = sumUtxosCoins(utxos);
            } catch (err) {
                logger.warn(nodeUtil.format('OraclePublisher: encoder balance check failed:', err));
                return null;
            }
        }

        this.lastObservedBalance = balance;
        if (balance !== null && balance !== undefined) {
            if (balance < this.lowBalanceThreshold) {
                // Estimate rounds remaining at typical fee rate (~0.003 DOGE per tx)
                let est = Math.floor(balance / 0.003);
                logger.warn('OraclePublisher: DOGE balance LOW (' + balance.toFixed(4) + ' DOGE, ~' + est + ' rounds remaining)');
            }
        }
        return balance;
    },

};
