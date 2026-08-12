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
 * XChain Hub - Capability Self-Test: attestation
 *
 * Determines whether this hub is operationally ready to serve attestation
 * requests. Probes the built-in provider modules' healthCheck() to verify
 * the hub can actually reach the upstream services each provider relies on.
 *
 * Config shape:
 *   { attestation: { providers: { http_get: false } } }
 *     - omit a key to enable the provider (the common case)
 *     - set a key to `false` to opt out of a provider on this hub
 *
 ********************************************************************/

// Providers this self-test knows how to probe. Each module must export
// `healthCheck() -> { ok, error? }`. http_get is always probed; llm is
// only probed when ANY supported credential path resolves for ANY vendor
// (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY,
// OPENAI_API_KEY, or the default isolated dir), so a stack that hasn't opted
// in to LLM doesn't flag the capability as unhealthy. Whether the resolved
// credentials actually cover the approved model chain (primary vendor
// required; ALL vendors when governance sets require_all_vendors) is the llm
// module's healthCheck verdict, probed below.
const { resolveHubLlmAuth, resolveOpenAiAuth } = require('../lib/hub-credentials');

const PROVIDER_PROBES = {
    http_get: require('../providers/http_get.js')
};
if (resolveHubLlmAuth().ok || resolveOpenAiAuth().ok){
    PROVIDER_PROBES.llm = require('../providers/llm.js');
}

exports.selfTest = async (config) => {
    let entry     = (config && config.attestation) || {};
    let optouts   = entry.providers || {};
    let active    = [];
    let failed    = [];

    for (let id of Object.keys(PROVIDER_PROBES)) {
        if (optouts[id] === false) continue;
        let mod = PROVIDER_PROBES[id];
        if (!mod || typeof mod.healthCheck !== 'function') {
            failed.push(id + ': no healthCheck()');
            continue;
        }
        try {
            let r = await mod.healthCheck();
            if (r && r.ok) active.push(id);
            else            failed.push(id + ': ' + (r && r.error ? r.error : 'unknown'));
        } catch (e) {
            failed.push(id + ': probe threw ' + (e && e.message ? e.message : String(e)));
        }
    }

    if (active.length === 0) {
        return { ok: false, reason: 'no attestation providers healthy: ' + failed.join('; ') };
    }
    let res = { ok: true, providers: active };
    if (failed.length > 0) res.failed = failed;
    return res;
};
