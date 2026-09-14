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
 * XChain Hub - the x-api-key tier gate and the public-port method allowlist.
 *
 * Both run as express middleware ahead of every JSON-RPC and REST route
 * (src/api/middleware.js mounts them in that order). The tier SETS themselves
 * stay in src/api.js, where the boot reads them, and arrive here through the
 * context object.
 *
 ********************************************************************/

const crypto = require('crypto');
const configRedaction = require('../lib/config_redaction.js');

// The ONLY rpc methods reachable on the public P2P-port feed (PeerManager
// setFeedHandlers). This is the complete set an indexer sends to its hub
// (xchain-indexer src/hub/hub_client.js): what landed on its chain, and the
// retractions when a reorg takes it back. Every one is a WRITE_METHODS or
// REORG_WRITE_METHODS member, so the x-api-key tiers apply to them here exactly as
// on the private port; this set only narrows WHICH methods that port will consider.
// Adding to it widens a public attack surface: a method belongs here only if an
// indexer must call it and it is signature- or content-validated hub-side.
const FEED_RPC_METHODS = new Set([
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushattestbatch', 'pushoracleprice',
    'pushpricereorg', 'pushxcallreorg', 'pushdexreorg', 'pushbridgereorg', 'retractattestbatch'
]);

// CREDENTIAL TIER. Served verbatim, the configs table hands the coin node's rpc
// pass and every service's DB password in plaintext to any caller holding the
// bulk key. That is a much wider blast
// radius than the read itself needs: the callers who want the config TREE (the
// indexer's param overlay, the SDK's explorer discovery, the dashboard, every
// operational `curl | jq`) are not the callers who want the CREDENTIALS, and
// each of those ordinary reads copied plaintext passwords into logs, tickets
// and transcripts nobody rotates afterwards.
//
// So secret-bearing params (src/lib/config_redaction.js keys on the param name)
// are redacted by DEFAULT, and the real values require an explicit
// `include_secrets: true` on the call. That request is authorized on its own:
// with HUB_CONFIG_SECRETS_API_KEY set it answers to THAT key alone (the bulk
// key no longer unlocks credentials, mirroring the HUB_REORG_API_KEY split);
// unset, it falls back to the bulk HUB_API_KEY, which is the pre-existing
// posture minus the accidental copies. A fully keyless hub (declared
// HUB_ALLOW_UNAUTHENTICATED, i.e. regtest) serves them as before - nothing on
// that hub is authenticated in the first place.
//
// The two callers that genuinely need credentials and pass the flag are
// xchain-explorer (XChainHubConnector -> db.js builds its MariaDB pools from
// db_host/user/pass) and xchain-sync (HubClient._extractDbConfigs -> its
// replication sources). ROLLOUT ORDER: deploy those two before a hub carrying
// this change, since an older consumer does not send the flag and would receive
// a redacted password.

// True when a JSON-RPC call object is a getallconfigs asking for the
// unredacted tree. Shared by the auth middleware (which decides whether the
// request is authorized to ask) and the handler (which decides what to serve),
// so the two can never disagree about what "asking" means.
function callWantsConfigSecrets(call) {
    if (!call || typeof call.method !== 'string') return false;
    if (call.method.toLowerCase() !== 'getallconfigs') return false;
    return configRedaction.wantsSecrets(call.params && call.params.include_secrets);
}

function timingEqual(provided, expected) {
    let a = Buffer.from(provided), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// With HUB_REORG_API_KEY set, the retraction rails answer ONLY to
// it (a batch mixing reorg and non-reorg gated methods can never satisfy
// both tiers with the single x-api-key header a request carries; callers
// do not mix tiers). Unset, they stay in the bulk tier below.
function reorgTierRefuses(calls, provided, { HUB_REORG_API_KEY, REORG_WRITE_METHODS }) {
    if (HUB_REORG_API_KEY) {
        let reorgGated = calls.some(call => {
            let method = call && call.method;
            return method && REORG_WRITE_METHODS.has(method.toLowerCase());
        });
        if (reorgGated && !timingEqual(provided, HUB_REORG_API_KEY)) return true;
    }
    return false;
}

// The bulk tier: every write, plus the sensitive reads while HUB_SENSITIVE_READ_AUTH
// is on, answers to HUB_API_KEY.
function bulkTierRefuses(calls, provided, ctx) {
    const { HUB_API_KEY, HUB_REORG_API_KEY, HUB_CONFIG_SECRETS_API_KEY,
            REORG_WRITE_METHODS, WRITE_METHODS, SENSITIVE_READ_METHODS, SENSITIVE_READ_AUTH } = ctx;
    if (HUB_API_KEY) {
        let gated = calls.some(call => {
            let method = call && call.method;
            if (!method) return false;
            let m = method.toLowerCase();
            // Reorg methods moved to their own tier above; the reorg key
            // must not authorize anything else, and the bulk key must no
            // longer authorize retractions.
            if (HUB_REORG_API_KEY && REORG_WRITE_METHODS.has(m)) return false;
            // Same split for the credential tier: with a dedicated
            // config-secrets key, a getallconfigs asking for secrets was
            // already checked against THAT key above and must not also be
            // required to carry the bulk key, since one request carries one
            // x-api-key header (xchain-explorer and xchain-sync send the
            // secrets key and nothing else).
            if (HUB_CONFIG_SECRETS_API_KEY && callWantsConfigSecrets(call)) return false;
            return WRITE_METHODS.has(m) ||
                (SENSITIVE_READ_AUTH && SENSITIVE_READ_METHODS.has(m));
        });
        if (gated && !timingEqual(provided, HUB_API_KEY)) return true;
    }
    return false;
}

// API key enforcement for write methods and sensitive reads (only when a
// key is configured; see the HUB_API_KEY and SENSITIVE_READ_METHODS notes
// in src/api.js). Everything not in either set is the public read tier, protected
// only by the per-IP rate limit.
function authGate(ctx) {
    const { HUB_API_KEY, HUB_REORG_API_KEY, HUB_CONFIG_SECRETS_API_KEY } = ctx;
    return (req, res, next) => {
        if (!HUB_API_KEY && !HUB_REORG_API_KEY && !HUB_CONFIG_SECRETS_API_KEY) return next();
        // A JSON-RPC batch arrives as an array of call objects; a single call as
        // one object. express-json-rpc-router dispatches every element of an
        // array body, so the gate must inspect ALL of them: require a key if ANY
        // element invokes a write or sensitive-read method. Reading req.body.method
        // off an array leaves it undefined, which would let a batch smuggle gated
        // methods past the check unauthenticated.
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let provided = req.headers['x-api-key'] || '';
        let unauthorized = () => res.status(401).json({
            jsonrpc: '2.0', id: (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null,
            error: { code: -32001, message: 'Unauthorized' }
        });
        if (reorgTierRefuses(calls, provided, ctx)) return unauthorized();
        // Credential tier (see the CREDENTIAL TIER note above). A getallconfigs
        // that asks for the unredacted tree must satisfy the config-secrets key
        // when one is set, and the bulk key otherwise. Enforced here rather than
        // in the handler so a refusal is the same 401 every other tier gives, and
        // deliberately OUTSIDE the SENSITIVE_READ_AUTH switch: the escape hatch
        // exists to un-key service discovery during a rollout, never to hand out
        // passwords keylessly, which is a much larger decision.
        let secretsRequested = calls.some(callWantsConfigSecrets);
        if (secretsRequested) {
            let expected = HUB_CONFIG_SECRETS_API_KEY || HUB_API_KEY;
            if (expected && !timingEqual(provided, expected)) return unauthorized();
        }
        if (bulkTierRefuses(calls, provided, ctx)) return unauthorized();
        next();
    };
}

// Public-port method allowlist. A request stamped by PeerManager arrived on the
// PUBLIC P2P port (see setFeedHandlers), where the only callers are indexers
// mirroring this validator and reporting what landed on their chain. Hold those
// to FEED_RPC_METHODS: every other method (config and validator administration,
// governance, slashing, swaps, anchor flush, effector spend, and every read)
// stays reachable only on the private API port.
//
// These are the whole indexer->hub vocabulary (xchain-indexer src/hub/hub_client.js),
// and they are not a back door: each is a WRITE_METHODS/REORG_WRITE_METHODS
// member that has just cleared the x-api-key gate above exactly as it would on
// the private port, and each payload is validated and signature-checked before
// anything is stored. Refusing them would leave a validator unable to learn that
// its own published batch landed, which is what stops its publisher pruning and
// keeps the takeover rail disarmed.
//
// Runs AFTER the key gate deliberately: an unauthenticated caller gets the same
// 401 it would get anywhere, so this port answers "not available" only to a
// caller already holding the key, and does not become an oracle for which
// methods a hub implements.
function feedPortAllowlist() {
    return (req, res, next) => {
        if (!req.xchainFeedOrigin) return next();
        if (req.method === 'GET') return next();     // snapshot reads, already path-scoped
        let calls = Array.isArray(req.body) ? req.body : [req.body];
        let allowed = calls.length > 0 && calls.every((call) => {
            let method = call && call.method;
            return typeof method === 'string' && FEED_RPC_METHODS.has(method.toLowerCase());
        });
        if (!allowed) {
            return res.status(404).json({
                jsonrpc: '2.0', id: (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null,
                error: { code: -32601, message: 'Method not available on this port' }
            });
        }
        next();
    };
}

module.exports = { authGate, feedPortAllowlist };
