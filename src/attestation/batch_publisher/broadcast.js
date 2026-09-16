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
 * AttestationBatchPublisher: sending a window
 *
 * One window's wires under one durable intent, the bounded retry of a head refused
 * before it was sent, the balance gate and the default encoder pipeline. Installed on
 * AttestationBatchPublisher.prototype by src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const { forwardableUtxos }  = require('../../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../../lib/two_phase_guard.js');
const { isAmbiguousSendError, isNeverSentError } = require('../../lib/idempotent_broadcast.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ------------------------------------------------------------ the broadcast

    // Send one window's wires, in order, under one durable intent. The head goes first
    // because a continuation without its head is unattributable; a node that sees the
    // head before the chunks holds a structurally sound action that has delivered
    // nothing, which is the ANCHOR archive head's behaviour and is recoverable.
    async broadcastWindow(window, batchKey, encoded){
        let canBroadcast = this.broadcastFn || (this.encoder && this.walletSignFn);
        if(!canBroadcast){
            logger.warn('AttestationBatchPublisher: no broadcast pipeline configured ' +
                '(set DOGE_ENCODER_URL + setWalletSignHook, or setBroadcastHook); window ' +
                window.window_start + ' stays unpublished');
            this.stats.windowsDeferred++;
            return false;
        }
        if(!(await this.balanceAllows())){
            this.stats.windowsDeferred++;
            return false;
        }

        let tokens = this.reserveWindowSpend(window, encoded);
        if(!tokens) return false;

        // Durable intent BEFORE the first send and AFTER the reservation, so a window the
        // ceiling declined leaves no crash marker behind and a crash mid-send leaves one.
        try {
            await this.recordIntent(window, batchKey);
        } catch(e){
            for(let t of tokens) this.spendGuard.release(t);
            logger.error('AttestationBatchPublisher: cannot record publish intent for window ' +
                window.window_start + '; deferring (fail closed to avoid an unrecorded spend): ' + (e && e.message));
            this.stats.windowsDeferred++;
            return false;
        }

        this.bufferWindow(window, batchKey, encoded);

        let broadcaster = this.broadcastFn || ((p) => this.defaultBroadcast(p));
        let headTxid = null;
        for(let i = 0; i < encoded.wires.length; i++){
            let result;
            try {
                result = await broadcaster(encoded.wires[i]);
            } catch(e){
                let ambiguous = isAmbiguousSendError(e);
                // THE HEAD IS THE ONLY WIRE WHOSE FAILURE CAN PROVE THE WINDOW IS UNTOUCHED.
                // Wire 1 is the first send, so a provably-unsent failure there means no byte
                // of this window reached the encoder, no fee was paid, and nothing sits in a
                // mempool: the intent marker is a record of an attempt that did not happen,
                // and keeping it costs the window its chain coverage for good (an hourly
                // testnet window dropped by one transient encoder refusal). A failure on a LATER wire leaves the head on chain and is
                // handled by the latch below unchanged, as is every ambiguous failure.
                if(i === 0 && !ambiguous && isNeverSentError(e) &&
                   await this.retryRefusedHead(window, e, tokens)) return false;
                this.latchWireFailure(window, encoded, tokens, i, e, ambiguous);
                return false;
            }
            this.spendGuard.commit(tokens[i]);
            this.stats.wiresBroadcast++;
            if(i === 0) headTxid = (result && result.txid) ? String(result.txid) : null;
        }

        await this.markSent(window.window_start, headTxid, window.row_count);
        this.notePublishedWindow(window, encoded, headTxid);
        return true;
    },

    // One reservation per wire, because one wire is one transaction and one fee.
    // RESERVE, never allow()/record(): the sends are awaited, and a pure pre-send check
    // would let two passes each read the same budget and both spend past the ceiling.
    // Returns null, having released whatever it took, when the window cannot be paid for.
    reserveWindowSpend(window, encoded){
        let tokens = [];
        for(let i = 0; i < encoded.wires.length; i++){
            let token = this.spendGuard.reserve();
            if(!token){
                for(let t of tokens) this.spendGuard.release(t);
                logger.warn(this.spendGuard.noteBlocked() + ' (attestation batch window ' +
                             window.window_start + ', ' + encoded.wires.length + ' wire(s))');
                this.stats.windowsDeferred++;
                return null;
            }
            tokens.push(token);
        }
        return tokens;
    },

    // A wire that failed with the window already committed to: the wire that threw is
    // charged for (it may have left the process), every later reservation goes back, and
    // the window keeps its intent marker so nothing re-publishes it automatically.
    latchWireFailure(window, encoded, tokens, i, e, ambiguous){
        this.spendGuard.commit(tokens[i]);   // a send that may have left the process is a spend
        for(let j = i + 1; j < tokens.length; j++) this.spendGuard.release(tokens[j]);
        logger.error('AttestationBatchPublisher: CRITICAL - wire ' + (i + 1) + '/' +
            encoded.wires.length + ' of window ' + window.window_start + '-' + window.window_end +
            ' failed to broadcast' + (ambiguous ? ' AMBIGUOUSLY (it may still have landed)' : '') +
            ': ' + (e && e.message) + '. The window keeps its intent marker and will NOT be ' +
            're-published automatically; operator reconciliation required.');
    },

    // The published window's own bookkeeping, in the order it ran inline.
    notePublishedWindow(window, encoded, headTxid){
        this._refusalAttempts.delete(window.window_start);   // the window is paid for; its attempt history is spent
        this.stats.windowsPublished++;
        this.stats.rowsPublished += window.row_count;
        if(window.row_count === 0) this.stats.windowsEmpty++;
        this.stats.lastPublishedWindow = window.window_start;
        this.stats.lastPublishedTxid   = headTxid;
        logger.info('AttestationBatchPublisher: published window ' + window.window_start + '-' +
            window.window_end + ' (' + window.row_count + ' row(s), ' + encoded.wires.length +
            ' wire(s), anchor ' + window.btc_block_height + ', txid ' + (headTxid || '<none>') + ')');
    },

    // Hand a window whose HEAD was provably never sent back to the sweep, or decline to
    // and let the caller latch it. True means "released, unmarked, retry next cycle".
    //
    // WHY DELETING THE INTENT ROW IS SAFE HERE, AND ONLY HERE. The marker's whole job is
    // to stop a SECOND fee being paid for a window that may already carry a transaction.
    // On this branch the head is wire 1, it threw, and the error shape proves it never
    // left the process, so there is no transaction, no fee and no mempool entry the
    // marker could be protecting: it records an attempt that did not happen. The DELETE
    // is guarded on status = 'intent', so a `sent`, `landed` or `deadletter` row written
    // by the landing path or by another hub's batch arriving between the send and this
    // line is never touched, and a delete that removes no row leaves the window exactly
    // as the latch below expects it. Rebuilt content is byte-identical (the rows are
    // unchanged in the mirror), which is the same property the no-quorum retry relies on.
    async retryRefusedHead(window, e, tokens){
        let attempt = (this._refusalAttempts.get(window.window_start) || 0) + 1;
        this._refusalAttempts.set(window.window_start, attempt);
        // At the bound the window latches like any other failure, exactly once: the
        // intent marker it keeps is what makes the next sweep quarantine it instead of
        // proposing it again.
        if(attempt >= this.maxRefusalAttempts) return false;

        try {
            await this.clearIntent(window.window_start);
        } catch(err){
            // The marker survives, so the window quarantines on the next sweep. Latching
            // now is the honest outcome, and the caller's CRITICAL line is the one an
            // operator should see.
            logger.error('AttestationBatchPublisher: window ' + window.window_start +
                ' was refused before sending but its publish-intent marker could not be ' +
                'removed (' + (err && err.message) + '); it will quarantine rather than retry.');
            return false;
        }

        // Nothing was spent, so every reservation goes back, the head's included: this is
        // the one broadcast failure where committing the head's token would charge the
        // window's ceiling for a transaction that does not exist.
        for(let t of tokens) this.spendGuard.release(t);
        this.stats.windowsRefusalRetried++;
        logger.warn('AttestationBatchPublisher: window ' + window.window_start + '-' +
            window.window_end + ' was refused before its head could be sent (' + (e && e.message) +
            '); nothing left this process, so its publish-intent marker is withdrawn and the ' +
            'window is rebuilt on the next sweep (attempt ' + attempt + ' of ' +
            this.maxRefusalAttempts + ').');
        return true;
    },

    // Balance gates, fail-closed in the same order OraclePublisher applies them: an
    // unreadable balance is not a licence to spend.
    async balanceAllows(){
        let hasSource = !!(this.getBalanceFn || (this.encoder && this.dogeAddress));
        if(!hasSource) return true;
        let balance = null;
        try {
            balance = this.getBalanceFn ? Number(await this.getBalanceFn()) : null;
        } catch(e){
            balance = null;
        }
        if(balance === null || !Number.isFinite(balance)){
            if(this.getBalanceFn){
                logger.warn('AttestationBatchPublisher: DOGE balance unreadable; skipping this window ' +
                             '(fail closed)');
                return false;
            }
            return true;   // no balance hook wired: nothing to enforce, as on the PRICE rail
        }
        if(balance < this.lowBalanceThreshold){
            logger.warn('AttestationBatchPublisher: DOGE balance ' + balance.toFixed(4) + ' below floor ' +
                         this.lowBalanceThreshold + '; skipping this window (fail closed)');
            return false;
        }
        return true;
    },

    // The default pipeline: the same encoder, address and wallet hook the PRICE rail
    // uses, because there is one operator wallet. Only the payload differs.
    async defaultBroadcast(payload){
        if(!this.encoder)       throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!this.walletSignFn)  throw new Error('no wallet sign hook configured (call setWalletSignHook)');
        if(!this.dogeAddress)   throw new Error('no DOGE_ADDRESS configured');

        let utxos = await this.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0))
            throw new Error('no UTXOs available for ' + this.dogeAddress);

        let psbtResult = await this.encoder.createTx({
            utxos:       forwardableUtxos(utxos, 'AttestationBatchPublisher'),
            pubkey:      this.dogeAddress,
            data:        payload,
            change:      this.dogeAddress,
            encoding:    'P2SH',
            // Confirmed inputs only by default: spending our own unconfirmed change
            // chains every batch onto the one before it, and miners score a package by
            // its ancestors, so one underpaid batch would hold down every later window.
            unconfirmed: this.allowUnconfirmedInputs
        });
        if(!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        // Refuse phase one of a two-transaction encoding: this pipeline has no reveal,
        // so broadcasting it would publish an undecodable batch and strand the value.
        assertSingleTxEncoding(psbtResult, 'AttestationBatchPublisher');

        let txHex = await this.walletSignFn(psbtResult.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return (await this.encoder.broadcastTx(txHex)) || { txid: null };
    }

};
