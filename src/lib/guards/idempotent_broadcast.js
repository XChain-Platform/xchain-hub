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
 * XChain Hub - Shared idempotent-broadcast helper
 *
 * The four hub effectors that spend coin on-chain each grew the same two
 * money-path primitives independently. This module is the single shared copy:
 *
 *   isAmbiguousSendError(e)
 *     Classify a broadcast_tx failure: could the transaction still have reached
 *     the coin node despite the error? A definitive rejection (the node named a
 *     reject reason through the encoder's RPC error, or an HTTP 4xx refused the
 *     call before processing) and a never-connected transport error are SAFE to
 *     retry. Everything else (timeout, reset mid-flight, 5xx after the request
 *     left the wire, and the encoder's sanitized fallback for its OWN transport
 *     failure talking to the node) is AMBIGUOUS: a blind retry could double-spend
 *     the fee and double-anchor the work. Callers tag the error and defer instead
 *     of re-broadcasting. The RPC-error envelope alone is NOT proof of a
 *     rejection; see ENCODER_TRANSPORT_FALLBACK below. Nor is a definitive
 *     rejection proof that NO money moved: a multi-phase signer hook can be
 *     rejected on its reveal after its funding transaction is already on chain,
 *     so an error carrying `fundsCommitted` is AMBIGUOUS whatever its shape. So is
 *     the encoder's TX_ALREADY_IN_CHAIN reason: the node already holds this exact
 *     transaction, which is a landed send rather than a rejection.
 *     (Was duplicated verbatim as isAmbiguousSendError in
 *     Oracle/Attest/Anchor/FullNode.)
 *
 *   isNeverSentError(e)
 *     The strict half of the definitive class: not merely "retrying is safe" but
 *     "no byte of this transaction left the process". Three shapes prove it, and
 *     isAmbiguousSendError reads all three as definitive: a `neverSent` tag, which a
 *     pipeline sets on a failure raised before its send step (the encoder answers a
 *     refused create_tx, such as insufficient funds or an unconfirmed-change refusal,
 *     as an HTTP 200 JSON-RPC error, so only the pipeline knows nothing was sent); a
 *     sub-500 HTTP response (the encoder's auth, batch-size and rate-limit gates
 *     refusing the call before processing); and a never-connected transport code.
 *     A NAMED node rejection is definitive but NOT
 *     never-sent, because the transaction reached the node to be rejected; callers
 *     that need "nothing was spent and nothing is in flight" must not read it as
 *     such. Used by callers that hold a durable publish-intent marker and want to
 *     DROP it and rebuild rather than quarantine the work for an operator.
 *
 *   AtMostOnce
 *     In-process at-most-once key set: the primitive behind the publishers'
 *     _publishedRounds / broadcasted-request guards. A key marked the instant a
 *     broadcast succeeds; if the durable-queue rewrite then fails and leaves the
 *     work on disk, the next sweep sees the key and drops the stale entry instead
 *     of re-broadcasting (a duplicate on-chain spend).
 *
 *   revealFields(e)
 *     The funding txid, reveal txid and signed reveal hex a multi-phase signer hook
 *     attaches to a failure after money moved, for the caller's durable record.
 *
 *   broadcastOnce({ key, tracker, guard, balance, cost, ambiguousTag, send })
 *     Convenience wrapper composing the at-most-once guard, the shared SpendGuard
 *     pre-send gate (wallet floor via check(), then a budget RESERVATION, because
 *     the send is awaited and the check()/record() pair races), the actual send,
 *     and ambiguous-error tagging. Returns
 *     { skipped: true, reason } when a guard blocked the send (no money moved),
 *     otherwise the broadcast result. Higher-level durability (dead-letter files,
 *     on-chain existence checks) stays in the caller; this only owns the shared
 *     at-most-once + spend-gate + classify steps.
 *
 ********************************************************************/

'use strict';

// The encoder's sanitized broadcast_tx text for a node TRANSPORT failure (code -32603, the tx
// MAY have landed) and for a node rejection whose text tripped its leak patterns; only a
// structured NODE_REJECTED reason tells them apart, so the bare literal reads AMBIGUOUS.
const ENCODER_TRANSPORT_FALLBACK = 'Transaction broadcast failed';

// The encoder's broadcast_tx reason for a node that already holds this exact
// transaction (mempool or chain), carried on EncoderClient's err.rpcData.
const TX_ALREADY_IN_CHAIN = 'TX_ALREADY_IN_CHAIN';

// The encoder's broadcast_tx code and reason for the coin node's own refusal of a
// transaction it received. Set only when the node answered with a JSON-RPC error body,
// so it never names a transport fault.
const NODE_REJECTED_CODE = -32010;
const NODE_REJECTED = 'NODE_REJECTED';

const SDK_REFUSED_CODE = /^ENCODER_HTTP_4\d\d$/;
const SDK_HTTP_CODE = /^ENCODER_HTTP_(\d{3})$/;
const SDK_RATE_LIMITED = 'RATE_LIMITED';
const SDK_PRE_SEND_METHODS = new Set(['create_tx', 'get_utxos']);

function safeGet(obj, key){
    try { return obj[key]; } catch(_e){ return undefined; }
}

function isObjectLike(value){
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}

// xchain-sdk keeps JSON-RPC fields under details.rpcError and represents HTTP
// status in its code. Lift both into the hub-client view used by the rules below.
function classifierView(e){
    const details = safeGet(e, 'details');
    const rpcError = isObjectLike(details) ? safeGet(details, 'rpcError') : undefined;
    const code = safeGet(e, 'code');
    const statusMatch = typeof code === 'string' ? SDK_HTTP_CODE.exec(code) : null;
    let response = safeGet(e, 'response');
    if(response === undefined && statusMatch) response = { status: Number(statusMatch[1]) };
    const directCode = safeGet(e, 'rpcCode');
    const directData = safeGet(e, 'rpcData');
    return {
        message: safeGet(e, 'message'), code, response,
        neverSent: safeGet(e, 'neverSent'), fundsCommitted: safeGet(e, 'fundsCommitted'),
        rpcCode: directCode !== undefined ? directCode : safeGet(rpcError, 'code'),
        rpcData: directData !== undefined ? directData : safeGet(rpcError, 'data')
    };
}

function isSdkNeverSent(e){
    const code = safeGet(e, 'code');
    if(typeof code !== 'string') return false;
    if(code === SDK_RATE_LIMITED || SDK_REFUSED_CODE.test(code)) return true;
    if(code.indexOf('ENCODER_') !== 0) return false;
    const details = safeGet(e, 'details');
    return isObjectLike(details) && SDK_PRE_SEND_METHODS.has(safeGet(details, 'method'));
}

// True when the node answered that it already holds the transaction just sent.
function isAlreadyKnownTx(e){
    const view = classifierView(e);
    const data = safeGet(view, 'rpcData');
    return !!(isObjectLike(data) && safeGet(data, 'reason') === TX_ALREADY_IN_CHAIN);
}

// True when the encoder relayed the node's own rejection over an answered (non-5xx) call.
function isNodeRejectedTx(e){
    const view = classifierView(e);
    const data = safeGet(view, 'rpcData');
    const response = safeGet(view, 'response');
    if (Number(safeGet(view, 'rpcCode')) !== NODE_REJECTED_CODE) return false;
    if (!isObjectLike(data) || safeGet(data, 'reason') !== NODE_REJECTED) return false;
    return !(response && Number(safeGet(response, 'status')) >= 500);
}

function isAmbiguousSendError(e){
    if (!e) return false;
    const view = classifierView(e);
    // Read BEFORE every message and status rule, because it outranks all of them. A
    // multi-phase signer hook (HUB_SIGNER_MODULE broadcast(), the P2SH fund-then-reveal
    // pipeline in docs/examples/doge-signer.example.js) puts its funding transaction on chain
    // and can then be rejected DEFINITIVELY on the reveal. The rules below would read
    // that rejection as a clean pre-send failure and hand the caller back to its
    // attempts-and-requeue path, which re-enters the hook, funds fresh UTXOs and pays for
    // the same payload twice. Money has already moved, so the send is ambiguous by
    // definition and the caller must dead-letter rather than rebuild. The hook sets the
    // flag; nothing else in the hub does.
    if (safeGet(view, 'fundsCommitted')) return true;
    // The node already holds this transaction, so its fee may be paid: take the
    // possibly-landed path, never a rebuild, whatever the message or status says.
    if (isAlreadyKnownTx(view)) return true;
    // A pipeline tags neverSent only on a failure before its send step, so a retry cannot double-spend.
    if (safeGet(view, 'neverSent') === true) return false;
    if (isSdkNeverSent(e)) return false;
    // The node's own refusal is definitive whatever the sanitized message reads.
    if (isNodeRejectedTx(view)) return false;
    const message = String(safeGet(view, 'message') || '');
    const response = safeGet(view, 'response');
    // A definitive rejection and an ambiguous transport failure share the SAME
    // 'Encoder RPC error' envelope, so this case is read before the prefix is trusted.
    // Guarded on the absence of a sub-500 HTTP response, the one shape that does prove
    // the encoder refused the call before it ever reached the node.
    if (message === 'Encoder RPC error: ' + ENCODER_TRANSPORT_FALLBACK &&
        !(response && Number(safeGet(response, 'status')) < 500)) return true;
    if (/^Encoder RPC error/.test(message)) return false;                             // node/encoder rejected the tx
    if (response && Number(safeGet(response, 'status')) < 500) return false;           // refused before processing
    const code = String(safeGet(view, 'code') || '');
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return false; // never sent
    return true;
}

// True only when the send is PROVEN not to have left this process. Deliberately a
// strict subset of !isAmbiguousSendError(e): that predicate answers "is a retry safe",
// which a node rejection also satisfies, while this one answers "is there nothing on
// any wire and nothing spent". The RPC-error envelope is therefore excluded, because a
// named rejection is the node's own verdict on a transaction it received.
function isNeverSentError(e){
    if (!e) return false;
    const view = classifierView(e);
    // Outranks every shape below for the same reason it outranks every rule in
    // isAmbiguousSendError: a multi-phase signer hook can carry a funded phase-one
    // transaction on chain and still surface a 4xx or an ECONNREFUSED on its reveal.
    if (safeGet(view, 'fundsCommitted')) return false;
    if (isAlreadyKnownTx(view)) return false;                           // the node holds it
    if (safeGet(view, 'neverSent') === true) return true;               // failed before the send step
    if (isSdkNeverSent(e)) return true;
    const response = safeGet(view, 'response');
    if (response && Number(safeGet(response, 'status')) < 500) return true; // refused before processing
    const code = String(safeGet(view, 'code') || '');
    return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';   // never connected
}

class AtMostOnce {
    constructor(){ this._seen = new Set(); }
    has(key){ return this._seen.has(String(key)); }
    mark(key){ this._seen.add(String(key)); return this; }
    delete(key){ return this._seen.delete(String(key)); }
    clear(){ this._seen.clear(); }
    get size(){ return this._seen.size; }
    // The live key list, so a caller that bounds this set (the deadline-anchored
    // eviction in AttestationRelay) can enumerate what it holds and rewrite its own
    // durable record from it. A copy, not the backing set: a caller iterating while it
    // deletes must not mutate what it is walking.
    keys(){ return Array.from(this._seen); }
}

// Compose the shared money-path steps around a caller-provided send().
//   key         stable idempotency key for this unit of work (round id, request id, ...)
//   tracker     an AtMostOnce (optional); when the key is already marked, returns skipped
//   guard       a SpendGuard (optional); check({balance,cost}) gates the send
//   balance     current wallet balance (or null when unreadable) for the floor gate
//   cost        per-broadcast cost in USD cents for the spend budget (optional)
//   ambiguousTag when set, an ambiguous send error is tagged e[ambiguousTag]=true
//   send        async () => broadcastResult; the ONLY step with an on-chain side effect
async function broadcastOnce({ key, tracker, guard, balance, cost, ambiguousTag, send }){
    if (typeof send !== 'function') throw new Error('broadcastOnce: send() is required');

    if (tracker && key != null && tracker.has(key)){
        return { skipped: true, duplicate: true, reason: 'already broadcast this process lifetime' };
    }

    // check() first for the WALLET FLOOR only: reserve() runs the pause, count-ceiling
    // and USD-budget gates but has no balance argument, so dropping check() here would
    // silently retire <PREFIX>_MIN_BALANCE for every caller of this wrapper.
    let token = null;
    if (guard){
        let g = guard.check({ balance: balance, cost: cost });
        if (!g.ok) return { skipped: true, reason: g.reason };
        // RESERVE, never check()/record(), because send() is AWAITED. The pure
        // predicate pair leaves a window in which every concurrent caller reads the
        // same pre-send budget and all of them spend past the ceiling; spend_guard's
        // own contract forbids that composition for an awaited send. reserve()
        // consumes the budget in this synchronous turn, so the window cannot open.
        token = guard.reserve(cost);
        if (!token) return { skipped: true, reason: guard.noteBlocked() };
    }

    let result;
    try {
        result = await send();
    } catch (e){
        // Settle by whether the send WENT OUT, not by whether it threw. An ambiguous
        // error means the transaction may already be on the wire with its fee paid, so
        // its reservation is COMMITTED: releasing hands the ceiling back an allowance a
        // real spend consumed, and the next caller spends past it. Only a definitive
        // failure (nothing left this process) gives the budget back. Same rule
        // AttestationRelay and AttestationPublisher state at their own ambiguous
        // branches; the older wording classified an UNKNOWN outcome as a failure.
        let ambiguous = isAmbiguousSendError(e);
        if (guard){
            if (ambiguous) guard.commit(token);
            else guard.release(token);
        }
        if (ambiguousTag && ambiguous) e[ambiguousTag] = true;
        throw e;
    }

    if (tracker && key != null) tracker.mark(key);
    if (guard) guard.commit(token);   // the reservation IS the recorded spend; never also record()
    return result || {};
}

// Return a broadcast result as { txid } with a non-empty txid, accepting a bare txid string.
// A send that answered without one has an unknown outcome, so it throws an error the
// classifier above reads as AMBIGUOUS: the caller dead-letters or latches, never re-sends.
function requireBroadcastTxid(result, who){
    if (typeof result === 'string' && result.trim() !== '') return { txid: result.trim() };
    if (result && typeof result.txid === 'string' && result.txid.trim() !== '') return result;
    let e = new Error((who || 'broadcast') + ': broadcast reported success but returned no txid, ' +
                      'so whether the transaction reached the node is unknown');
    e.missingTxid = true;
    throw e;
}

// What a multi-phase signer hook reported about the money it already moved: the
// funding txid, the reveal's txid and the signed reveal itself. These are the only
// record of where the fee went and the only way to finish the publish by hand
// (rebroadcasting the reveal spends the funded output), so every rail copies them
// onto its durable failure record. Each field is read on its own, so one whose
// accessor throws is left out and the others are still recorded; only non-empty
// strings are kept, so a placeholder never passes for a real txid. An empty object
// when the error carries none.
const REVEAL_FIELDS = Object.freeze(['phase1Txid', 'revealTxid', 'revealTxHex']);
function revealFields(e){
    let out = {};
    if (e === null || (typeof e !== 'object' && typeof e !== 'function')) return out;
    for (let k of REVEAL_FIELDS){
        let v;
        try { v = e[k]; } catch (_e){ v = undefined; }
        if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
}

module.exports = { isAmbiguousSendError, isNeverSentError, isAlreadyKnownTx, AtMostOnce, broadcastOnce,
                   requireBroadcastTxid, revealFields, REVEAL_FIELDS };
