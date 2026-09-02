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
 * XChain Hub - getallconfigs credential redaction
 *
 * The hub's configs table is service discovery for the whole mesh, and
 * xchain-node writes real credentials into it: the coin node's rpc
 * user/pass, and the indexer/decoder/checkpoint DB user/pass
 * (xchain-node src/config/constants.js SERVICE_REGISTRY hubConfig
 * fields). getallconfigs used to serve that tree verbatim to every
 * caller that cleared the sensitive-read key, so ANY operational read
 * against the hub - a health probe, a `curl | jq`, a support paste, an
 * assistant transcript - copied plaintext DB passwords out of the
 * database and into somewhere nobody is rotating.
 *
 * Auth alone could not fix that: the callers who legitimately need the
 * config tree (the indexer's param overlay, the SDK's explorer
 * discovery, the dashboard) hold the same key as the two that
 * legitimately need the CREDENTIALS (xchain-explorer's DB pools,
 * xchain-sync's replication sources). So the response is redacted by
 * default and the credentials become an explicit, separately
 * authorized request: `include_secrets: true`, gated in api.js.
 *
 * Redaction keys on the PARAM NAME, the same discipline
 * observability/logShipper.js applies to log fields (its SECRET_KEY_RE
 * is the canonical pattern this mirrors). Names are matched as
 * substrings because the platform's config params are env-shaped
 * (`pass`, `db_password`, `rpc_pass`) and an anchored pattern misses
 * every one of them.
 *
 ********************************************************************/

'use strict';

// The value substituted for a redacted param. A visible sentinel rather than a
// dropped key: a consumer that needed the credential and did not ask for it
// fails on an obviously-fake password (and can log WHY), where a missing key
// would surface as an undefined connection option several layers away.
const REDACTED = '[redacted]';

// Param names whose values never leave the hub in an unprivileged response.
// Mirrors observability/logShipper.js SECRET_KEY_RE; kept as its own copy
// because that module is vendored out to the sibling services by
// bin/sync-observability.sh and must not grow hub-only importers.
const SECRET_PARAM_RE = /(pass(word|phrase|wd)?|secret|token|api[_-]?key|apikey|auth|credential|wif|priv(ate)?[_-]?key|mnemonic|seed|cookie|session)/i;

// Depth cap for the recursive walk. The config tree is four levels
// (coin/network/module/param) and a JSON blob param adds a few more; anything
// deeper is malformed (or cyclic) and is replaced rather than walked forever.
// Fail CLOSED at the cap: returning the node itself would hand back the
// original object graph, credentials and all, which is the one outcome this
// module exists to prevent.
const MAX_DEPTH = 8;
const TRUNCATED = '[truncated]';

function isSecretParamName(name) {
    return SECRET_PARAM_RE.test(String(name === undefined || name === null ? '' : name));
}

// True when a caller explicitly asked for the unredacted tree. Accepts the
// JSON boolean and the string/number forms an HTTP client or a shell-built
// payload produces; everything else (including the absent param) is false, so
// redaction is what a caller gets by omission or by typo.
function wantsSecrets(value) {
    return value === true || value === 1 || value === '1' ||
        (typeof value === 'string' && value.toLowerCase() === 'true');
}

// Some config params carry a whole JSON document as their value (the
// ATTESTATION_PROVIDER registry blobs, for instance), so a name-keyed sweep of
// the outer tree alone would serve a credential nested one level inside a
// string. Parse those, redact by the same rule, and re-serialize - but ONLY
// when something was actually redacted, so an untouched blob keeps its exact
// bytes and a consumer diffing config values sees no spurious change.
function redactStringValue(value, counter) {
    let trimmed = value.trim();
    if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return value;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (_) { return value; }
    if (parsed === null || typeof parsed !== 'object') return value;
    let before = counter.n;
    let redacted = redactNode(parsed, 1, counter);
    if (counter.n === before) return value;
    return JSON.stringify(redacted);
}

function redactNode(node, depth, counter) {
    if (node === null || typeof node !== 'object') return node;
    if (depth > MAX_DEPTH) return TRUNCATED;
    if (Array.isArray(node)) return node.map((v) => redactNode(v, depth + 1, counter));
    let out = {};
    for (let key of Object.keys(node)) {
        let value = node[key];
        if (isSecretParamName(key)) {
            out[key] = REDACTED;
            counter.n++;
            continue;
        }
        if (typeof value === 'string') { out[key] = redactStringValue(value, counter); continue; }
        out[key] = redactNode(value, depth + 1, counter);
    }
    return out;
}

/**
 * Redact every secret-bearing param out of a getallconfigs tree.
 *
 * Returns a NEW tree; the input is never mutated, because the hub's own
 * internal readers (XChainHub's indexer-URL resolution) call the same
 * db.getAllConfigs() and must keep seeing real values.
 *
 * @param   {object} configs  { coin: { network: { module: { param: value } } } }
 * @returns {{configs: object, redacted: number}} the redacted tree and how many
 *          params were replaced (0 means the tree carried no credential at all).
 */
function redactConfigTree(configs) {
    if (configs === null || typeof configs !== 'object') return { configs: configs, redacted: 0 };
    let counter = { n: 0 };
    return { configs: redactNode(configs, 0, counter), redacted: counter.n };
}

module.exports = {
    REDACTED,
    TRUNCATED,
    SECRET_PARAM_RE,
    isSecretParamName,
    wantsSecrets,
    redactConfigTree
};
