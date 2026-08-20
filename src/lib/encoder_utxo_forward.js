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
 * XChain Hub - decide whether a fetched UTXO set may be forwarded to create_tx
 *
 * Every default-broadcast pipeline here fetches the spend address's UTXOs and
 * forwards them to the encoder's create_tx. The encoder validates a
 * CALLER-SUPPLIED utxos array against MAX_UTXO_COUNT (500) and throws a
 * RangeError -> JSON-RPC -32602 past it, BEFORE any transaction is built. It
 * deliberately does NOT apply that cap to a set it fetched itself: the
 * caller-facing cap "must NOT gate an internally-fetched set (an address
 * holding more than that many UTXOs would otherwise be unable to build any
 * transaction)", and the SELECTED input count is bounded after selection
 * instead (xchain-encoder/src/XChainEncoder.js).
 *
 * Because the fetch-then-forward shape always supplies a non-empty array, it
 * pins every publisher to the capped path and can never reach the exemption.
 * Once a spend address collects more than 500 outputs every PRICE / ANCHOR /
 * ATTEST / NODEPROOF build fails with the same deterministic -32602, which the
 * ambiguity classifier reads as safe-to-retry, so the round retries the
 * identical oversized array until it dead-letters.
 *
 * So: forward the array while it is within the cap (byte-identical request to
 * what ships today), and omit the param past it so the encoder self-fetches
 * the same address through its own uncapped path. The address is the same one
 * either way: create_tx resolves its scan address from `pubkey`, and every
 * call site here passes the base58check spend address in that field.
 *
 * Deliberately NOT a coin selection: trimming to an arbitrary 500 here would
 * reimplement the fee/change arithmetic the encoder already owns, and a subset
 * that does not cover the fee builds a transaction that cannot be funded.
 *
 **********************************************************************/

'use strict';

// xchain-encoder/src/validator.js MAX_UTXO_COUNT. Duplicated rather than
// imported: the encoder is a separate service reached over JSON-RPC, not a
// dependency of this package. A raise on the encoder side only makes this
// bound conservative (we hand over fewer arrays than it would accept), never
// wrong; a drop would surface as the same -32602 this guard exists to avoid.
const ENCODER_MAX_UTXO_COUNT = 500;

// Return the value to pass as create_tx's `utxos` param.
//   - within the cap: the array unchanged (today's behavior, unaltered)
//   - past the cap:   undefined, which JSON.stringify drops from the request
//                     body, so the encoder takes its own uncapped fetch branch
//   - not an array:   unchanged, so the encoder's own validation names the
//                     shape problem instead of this helper hiding it
// `label` names the caller in the operator warning; the warning is the signal
// that the wallet has drifted into input bloat, which still costs fee weight
// even though the publish now succeeds.
function forwardableUtxos(utxos, label){
    if (!Array.isArray(utxos)) return utxos;
    if (utxos.length <= ENCODER_MAX_UTXO_COUNT) return utxos;
    console.warn((label || 'publisher') + ': spend address holds ' + utxos.length +
        ' UTXOs, past the encoder\'s caller-supplied cap of ' + ENCODER_MAX_UTXO_COUNT +
        '; letting the encoder select from its own fetch instead. Consolidate the wallet: ' +
        'every extra input adds fee weight.');
    return undefined;
}

module.exports = { forwardableUtxos, ENCODER_MAX_UTXO_COUNT };
