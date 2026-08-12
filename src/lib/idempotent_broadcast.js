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
 *     the coin node despite the error? A definitive rejection (the node/encoder
 *     answered with an RPC error, or an HTTP 4xx refusal) and a never-connected
 *     transport error are SAFE to retry. Everything else (timeout, reset
 *     mid-flight, 5xx after the request left the wire) is AMBIGUOUS: a blind
 *     retry could double-spend the fee and double-anchor the work. Callers tag
 *     the error and defer instead of re-broadcasting. (Was duplicated verbatim
 *     as _isAmbiguousSendError in Oracle/Attest/Anchor/FullNode.)
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
 *     pre-send gate, the actual send, and ambiguous-error tagging. Returns
 *     { skipped: true, reason } when a guard blocked the send (no money moved),
 *     otherwise the broadcast result. Higher-level durability (dead-letter files,
 *     on-chain existence checks) stays in the caller; this only owns the shared
 *     at-most-once + spend-gate + classify steps.
 *
 ********************************************************************/

'use strict';

function isAmbiguousSendError(e){
    if (!e) return false;
    if (/^Encoder RPC error/.test(String(e.message || ''))) return false;             // node/encoder rejected the tx
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
    // The live key list, so a caller that bounds this set ('s deadline-anchored
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

    if (guard){
        let g = guard.check({ balance: balance, cost: cost });
        if (!g.ok) return { skipped: true, reason: g.reason };
    }

    let result;
    try {
        result = await send();
    } catch (e){
        if (ambiguousTag && isAmbiguousSendError(e)) e[ambiguousTag] = true;
        throw e;
    }

    if (tracker && key != null) tracker.mark(key);
    if (guard) guard.record(cost);
    return result || {};
}

module.exports = { isAmbiguousSendError, AtMostOnce, broadcastOnce };
