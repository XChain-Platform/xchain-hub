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
 * XChain Hub - JSON-RPC batch-size cap
 *
 * express-json-rpc-router dispatches EVERY element of a batch array
 * concurrently, while the per-IP express-rate-limit in front of it charges one
 * token per HTTP REQUEST regardless of array length. So one ~100 KB body of
 * ~1,400 seventy-byte call objects amplifies into ~1,400 concurrent handlers,
 * each drawing on the shared MariaDB pool, for the price of a single token -
 * and on a keyless deploy (no HUB_API_KEY) the amplified set includes the
 * push* write rails. Cap the CARDINALITY before dispatch.
 *
 * Lives in its own module rather than inline in api.js because the hub's whole
 * middleware stack is built inside async function startApi(), which exports
 * nothing, so an inline guard could not be unit-tested without booting the API.
 *
 * Mirrors the same guard already shipping in xchain-encoder (src/api.js),
 * xchain-decoder and xchain-utxo-tracker; the error shape is kept identical so
 * a client sees one response for this condition across every service.
 *
 ********************************************************************/

'use strict';

// Parse the cap from the environment. A missing or unparseable value keeps the
// caller's default (fail-safe: a typo must not silently remove the cap), and so
// does a non-positive one - unlike the concurrency gate, there is no legitimate
// reason to disable a batch ceiling, and 0 would otherwise reject every batch.
function resolveMaxBatch(rawValue, defaultMax){
    const parsed = parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMax;
}

/**
 * Build the batch-cap middleware.
 *
 * Only an ARRAY body is a JSON-RPC batch; a single call object, an absent body
 * and a non-JSON request all fall straight through to next().
 *
 * @param {number} maxBatch Maximum call objects in one batch array.
 * @returns {function} Express middleware.
 */
function makeRpcBatchGuard(maxBatch){
    return function rpcBatchGuard(req, res, next){
        if(Array.isArray(req.body) && req.body.length > maxBatch){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Batch too large (max ' + maxBatch + ' requests per call)' }
            });
        }
        next();
    };
}

module.exports = { resolveMaxBatch, makeRpcBatchGuard };
