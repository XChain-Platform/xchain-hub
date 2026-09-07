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
 *     so an error carrying `fundsCommitted` is AMBIGUOUS whatever its shape.
 *     (Was duplicated verbatim as _isAmbiguousSendError in
 *     Oracle/Attest/Anchor/FullNode.)
 *
 *   AtMostOnce
 *     In-process at-most-once key set: the primitive behind the publishers'
 *     _publishedRounds / broadcasted-request guards. A key marked the instant a
 *     broadcast succeeds; if the durable-queue rewrite then fails and leaves the
 *     work on disk, the next sweep sees the key and drops the stale entry instead
 *     of re-broadcasting (a duplicate on-chain spend).
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

// The encoder's SANITIZED fallback for a broadcast_tx whose own call to the coin node
// failed at the TRANSPORT layer (xchain-encoder/src/api.js broadcast_tx hands this string
// to upstreamErrorMessage; errorSanitize.isTransportError covers ECONNRESET / ETIMEDOUT /
// ERR_BAD_RESPONSE, which is every case where the tx MAY ALREADY have reached the node).
// The sanitizer deliberately strips err.code and err.response so the internal host:port
// never leaks, and the encoder returns the result as an ordinary JSON-RPC error body (HTTP
// 200, code -32603). Without this constant it is textually indistinguishable from a
// genuine node rejection like 'bad-txns-inputs-missingorspent', so the prefix rule below
// read it as definitive and the publishers re-broadcast a tx that may have landed.
// Matching the literal is a deliberate cross-repo coupling and the only discriminator the
// wire carries today; the durable fix is a distinct RPC code for transport failures on the
// encoder side, which is a change in that repo.
const ENCODER_TRANSPORT_FALLBACK = 'Transaction broadcast failed';

function isAmbiguousSendError(e){
    if (!e) return false;
    // Read BEFORE every message and status rule, because it outranks all of them. A
    // multi-phase signer hook (HUB_SIGNER_MODULE broadcast(), the P2SH fund-then-reveal
    // pipeline in examples/doge-signer.example.js) puts its funding transaction on chain
    // and can then be rejected DEFINITIVELY on the reveal. The rules below would read
    // that rejection as a clean pre-send failure and hand the caller back to its
    // attempts-and-requeue path, which re-enters the hook, funds fresh UTXOs and pays for
    // the same payload twice. Money has already moved, so the send is ambiguous by
    // definition and the caller must dead-letter rather than rebuild. The hook sets the
    // flag; nothing else in the hub does.
    if (e.fundsCommitted) return true;
    let message = String(e.message || '');
    // A definitive rejection and an ambiguous transport failure share the SAME
    // 'Encoder RPC error' envelope, so this case is read before the prefix is trusted.
    // Guarded on the absence of a sub-500 HTTP response, the one shape that does prove
    // the encoder refused the call before it ever reached the node.
    if (message === 'Encoder RPC error: ' + ENCODER_TRANSPORT_FALLBACK &&
        !(e.response && Number(e.response.status) < 500)) return true;
    if (/^Encoder RPC error/.test(message)) return false;                             // node/encoder rejected the tx
    if (e.response && Number(e.response.status) < 500) return false;                   // refused before processing
    let code = String(e.code || '');
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return false; // never sent
    return true;
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

module.exports = { isAmbiguousSendError, AtMostOnce, broadcastOnce };
