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
 * XChain Hub - refuse to broadcast phase 1 of a two-transaction encoding
 *
 * The encoder's P2SH / P2WSH lane is a TWO-transaction contract. The funding tx
 * creates outputs whose redeem scripts embed the payload chunks; a later REVEAL
 * tx spends them, and only the reveal exposes the payload the decoder reads
 * (XChainDecoder reads the chunks out of a reveal tx's INPUT redeem scripts, and
 * a funding tx has none). The TAPROOT envelope lane is the same shape, answered
 * as a commit PSBT plus a `revealPsbt`.
 *
 * Every built-in `_defaultBroadcast` here does exactly one create_tx, one
 * walletSign and one broadcastTx, so on those lanes it publishes the FUNDING tx,
 * returns its txid as success, and discards `carrierScripts` - the only material
 * from which the reveal (or a sweep of the funding outputs) could be
 * reconstructed. The payload never becomes readable and the carrier value is
 * stranded, while the round records a successful publish.
 *
 * The built-in pipeline cannot finish the job: the reveal PSBT needs the SDK's
 * signRevealPsbt finalizer, which the operator's `walletSign(psbtHex)` hook is
 * not. So it fails CLOSED here instead of pretending, BEFORE the wallet hook
 * runs - nothing is signed, no fee is spent and no value moves. The working
 * production path is an operator signer module that exports `broadcast(payload)`
 * and runs both phases; examples/doge-signer.example.js is that reference
 * implementation, and its own header already documents the built-in pipeline as
 * phase-1-only.
 *
 * The verdict is read off the encoder's ANSWER, never off the encoding the
 * caller asked for. create_tx always reports the encoding it actually built
 * (result.encoding), and it downgrades to a single-tx OP_RETURN when there is no
 * action payload to chunk, so gating on the REQUESTED encoding would fail a
 * perfectly good single-transaction build closed.
 *
 ********************************************************************/

'use strict';

// Encodings whose create_tx answer is phase 1 of two transactions.
const TWO_PHASE_ENCODINGS = new Set(['P2SH', 'P2WSH']);

// Throw when `psbtResult` is phase 1 of a two-transaction encoding.
//
// `who` names the calling effector in the error so an operator reading a failed
// round knows which publish rail stopped. Returns nothing on the single-tx
// lanes, so a pipeline whose encoding is later changed to OP_RETURN or MULTISIGN
// keeps working untouched.
function assertSingleTxEncoding(psbtResult, who){
    if(!psbtResult || typeof psbtResult !== 'object') return;
    let encoding = String(psbtResult.encoding || '').toUpperCase();
    // `revealPsbt` is the taproot-envelope two-tx answer; `carrierScripts` rides
    // along on every chunked lane and is the belt-and-braces signal for an
    // encoder answer that omits `encoding` entirely.
    let twoPhase = TWO_PHASE_ENCODINGS.has(encoding) ||
                   !!psbtResult.revealPsbt ||
                   (Array.isArray(psbtResult.carrierScripts) && psbtResult.carrierScripts.length > 0);
    if(!twoPhase) return;
    throw new Error((who || 'publisher') + ': encoder returned phase 1 of a two-transaction ' +
        (encoding || 'chunked') + ' encoding; the built-in pipeline can only broadcast the funding ' +
        'transaction, whose payload no indexer can decode, and cannot sign the reveal. Refusing to ' +
        'broadcast. Configure HUB_SIGNER_MODULE with a module exporting broadcast(payload) that runs ' +
        'both phases (see examples/doge-signer.example.js).');
}

module.exports = { assertSingleTxEncoding, TWO_PHASE_ENCODINGS };
