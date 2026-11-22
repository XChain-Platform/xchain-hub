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
 * XChain Hub - JSON-RPC 2.0 error envelope repair.
 *
 * Every JSON-RPC answer must carry jsonrpc "2.0" and the request's id, and 0
 * is a valid id. express-json-rpc-router builds its error envelopes as
 * `{ jsonrpc, error, id: id || null }`: it echoes the caller's jsonrpc member
 * (so a versionless request gets an answer with no jsonrpc at all) and turns a
 * falsy id into null, while its success path keeps id 0. A client numbering
 * from 0 could pair its successes but not its errors.
 *
 * The router is a third-party dependency, so the repair sits at the boundary:
 * withEnvelopeRepair wraps the router middleware and fixes every envelope it
 * sends. requestId is the one id rule the hub's own refusals (the key gate and
 * the public-port allowlist) share with it.
 *
 ********************************************************************/

'use strict';

const VERSION = '2.0';

// The id to echo for a single (non-batch) request body: a string or number id
// as sent, 0 included; null when there is none, when it is not a legal id
// type, or when the body is a batch (a batch-level refusal has no single id).
function requestId(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const id = body.id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function repairOne(call, envelope) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return envelope;
    if (!('error' in envelope) && !('result' in envelope)) return envelope;
    // jsonrpc stays the first member, as the router writes it.
    const repaired = { jsonrpc: VERSION };
    for (const key of Object.keys(envelope)) if (key !== 'jsonrpc') repaired[key] = envelope[key];
    if ('error' in envelope && envelope.id === null) repaired.id = requestId(call);
    return repaired;
}

// Repairs what the router sends for `reqBody`. A batch answer holds one entry
// per call whose id is not null or undefined, in request order (the router
// drops notifications), so entries pair with those calls by index. Strings and
// anything else (Express re-enters send with the serialized body) pass through.
function repairEnvelope(reqBody, payload) {
    if (Array.isArray(payload)) {
        if (!Array.isArray(reqBody)) return payload;
        const answered = reqBody.filter((call) => call !== null && call !== undefined &&
            typeof call === 'object' && call.id !== null && call.id !== undefined);
        if (answered.length !== payload.length) return payload.map((entry) => repairOne(null, entry));
        return payload.map((entry, i) => repairOne(answered[i], entry));
    }
    if (payload && typeof payload === 'object') return repairOne(reqBody, payload);
    return payload;
}

// Wraps the JSON-RPC router middleware so its envelopes leave repaired.
function withEnvelopeRepair(rpcMiddleware) {
    return function jsonRpcEnvelopeRepair(req, res, next) {
        const send = res.send;
        res.send = function sendRepaired(payload) {
            // Restore first: Express's send(object) re-enters send with the
            // serialized string, which must go straight out.
            res.send = send;
            return send.call(this, repairEnvelope(req.body, payload));
        };
        return rpcMiddleware(req, res, next);
    };
}

module.exports = { requestId, repairEnvelope, withEnvelopeRepair };
