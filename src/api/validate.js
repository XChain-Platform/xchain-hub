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
 * XChain Hub - API argument validators.
 *
 * The chain, limit, integer and cursor checks every JSON-RPC family under
 * src/api/rpc/ and the REST snapshot routes share, so one tightening repairs
 * every call site at once.
 *
 ********************************************************************/

const coins = require('../coins');

const ALLOWED_CHAINS = new Set(coins.ALLOWED_COINS);

function validateChain(chain) {
    if (!ALLOWED_CHAINS.has(chain))
        return { error: 'chain must be one of: BTC, LTC, DOGE' };
    return null;
}

// Turn a refusal into a JSON-RPC TRANSPORT error rather than a method result.
//
// express-json-rpc-router puts whatever a handler RETURNS into the envelope's
// `result` slot and only what it THROWS into the `error` slot. So a refusal
// returned as `{ error: '...' }` arrives as `{ result: { error: '...' } }`, and a
// caller that checks the envelope's `error` field alone reads a refused call as an
// accepted one. Throwing this puts the refusal where such a caller looks.
//
// -32602 (Invalid params) is the correct code: every use here rejects the CALL's
// arguments, not the hub's ability to serve it.
//
// Adding a call site is WIRE-VISIBLE for external callers, and for the queueing
// callers in this mesh it also changes the retry verdict: an in-envelope refusal is
// classified terminal and drops the queued row, while a thrown error reads as a
// transport failure and is retried. Convert a handler only after checking what its
// callers do with the two shapes.
function rpcParamError(message) {
    let err = new Error(message);
    err.code = -32602;
    return err;
}

// Strict, because parseInt admits anything with an integer PREFIX: '50junk' passed as
// 50, '1e3' as 1 and '50.5' as 50, and several of the ~16 call sites forward the
// ORIGINAL value into a `LIMIT ?` bind rather than the parsed one. The queries stayed
// bounded and parameterized, but the public limit contract differed per caller. One
// helper guards every call site, so tightening it here repairs all of them.
function validateLimit(limit) {
    if (limit !== undefined && limit !== null) {
        let err = { error: 'limit must be a positive integer no greater than 10000' };
        let n;
        if (typeof limit === 'number')                                 n = limit;
        else if (typeof limit === 'string' && /^[0-9]+$/.test(limit))  n = Number(limit);
        else                                                           return err;
        if (!Number.isInteger(n) || n <= 0 || n > 10000)
            return err;
    }
    return null;
}

// Same digit-only shape validateLimit enforces, for the other external integer
// fields. Returns the exact integer, or null when the value is not a bare integer:
// callers still own the sign/range check, since the legal band differs per field.
function strictInt(value) {
    let n;
    if (typeof value === 'number')                                 n = value;
    else if (typeof value === 'string' && /^[0-9]+$/.test(value))  n = Number(value);
    else                                                           return null;
    return Number.isInteger(n) ? n : null;
}

function validateSince(since) {
    if (since !== undefined && since !== null && since !== '') {
        // Empty string stays "unset" here (unlike limit), so the guard sits inside
        // the presence check rather than replacing it.
        let n = strictInt(since);
        if (n === null || n < 0)
            return { error: 'since_id must be a non-negative integer' };
    }
    return null;
}

module.exports = { validateChain, rpcParamError, validateLimit, strictInt, validateSince };
