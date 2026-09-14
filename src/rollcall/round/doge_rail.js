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
 * XChain Hub - ROLLCALL round: the DOGE rail
 *
 * The borrowed signer, whether this hub can publish at all, and the broadcast
 * that refuses a two-phase encoding before anything is signed.
 *
 * src/rollcall/round.js installs every method below on RollcallRound.prototype,
 * non-enumerable like the class's own methods, so callers and tests keep
 * reaching them as round.<method>().
 *
 ********************************************************************/

'use strict';

const { forwardableUtxos }       = require('../../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../../lib/two_phase_guard.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ── the DOGE rail ────────────────────────────────────────────────────────

    // Borrow the shared DOGE signer exactly as StateAnchorPublisher borrows the
    // price publisher's: HUB_SIGNER_MODULE's contract is unchanged and there is
    // one wiring point for all on-chain DOGE publishing.
    resolveSigner(){
        let op = (this.hub && this.hub.oraclePublisher) || {};
        return {
            broadcastFn:  this.broadcastFn  || op.broadcastFn  || null,
            walletSignFn: this.walletSignFn || op.walletSignFn || null,
            getBalanceFn: this.getBalanceFn || op.getBalanceFn || null,
            encoder:      this.encoder      || op.encoder      || null
        };
    },

    // Can this hub actually land a roll call? Every ROLLCALL is a two-phase P2SH
    // publish and the built-in pipeline can only broadcast the funding tx, so a
    // signer module without `broadcast(payload)` can sign roll calls all day and
    // never publish one. Reported by getrollcallstatus so that gap is visible
    // rather than showing up as a federation that mysteriously never rolls.
    broadcastCapable(){
        return typeof this.resolveSigner().broadcastFn === 'function';
    },

    // Gate every publish path on it, and say so exactly once: this is a standing
    // deployment condition, not an event, and it is re-evaluated every tick.
    requireBroadcast(){
        if(this.broadcastCapable()) return true;
        if(!this._loggedNoBroadcast){
            this._loggedNoBroadcast = true;
            logger.warn('RollcallRound: this hub signs and gossips roll calls but cannot PUBLISH one: ' +
                         'HUB_SIGNER_MODULE exports no broadcast(payload), and every ROLLCALL is a two-phase ' +
                         'P2SH action the built-in encoder pipeline fails closed on. Its own presence still ' +
                         'reaches the chain through the sweepers. See examples/doge-signer.example.js.');
        }
        return false;
    },

    async broadcast(payload){
        let signer = this.resolveSigner();
        if(typeof signer.broadcastFn === 'function') return await signer.broadcastFn(payload);
        // Reached only if the capability check above was bypassed. Build far
        // enough to hit the two-phase guard, which refuses BEFORE the wallet hook
        // runs, so nothing is signed and no fee is spent.
        if(!signer.encoder)      throw new Error('no encoder configured (set DOGE_ENCODER_URL)');
        if(!signer.walletSignFn) throw new Error('no wallet sign hook configured');
        if(!this.dogeAddress)    throw new Error('no DOGE_ADDRESS configured');
        let utxos = await signer.encoder.getUtxos(this.dogeAddress);
        if(!utxos || (Array.isArray(utxos) && utxos.length === 0))
            throw new Error('no UTXOs available for ' + this.dogeAddress);
        let built = await signer.encoder.createTx({
            utxos: forwardableUtxos(utxos, 'RollcallRound'), pubkey: this.dogeAddress,
            data: payload, change: this.dogeAddress, encoding: 'P2SH'
        });
        if(!built || !built.psbt) throw new Error('encoder returned no PSBT');
        assertSingleTxEncoding(built, 'RollcallRound');
        let txHex = await signer.walletSignFn(built.psbt);
        if(!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return await signer.encoder.broadcastTx(txHex);
    }
};
