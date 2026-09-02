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
 * hub-credentials.js: Resolves Claude auth for the LLM attestation provider.
 *
 * Two transports are supported:
 *
 *   1. `claude_spawn`: shell out to the `claude` CLI binary with auth
 *      inherited from a CLAUDE_CONFIG_DIR populated by `claude login`,
 *      or from a CLAUDE_CODE_OAUTH_TOKEN env var. The CONFIG_DIR path is
 *      preferred because its `.credentials.json` carries a refresh token
 *      that the CLI auto-renews on every spawn, so it never needs rotation
 *      unless the operator logs out.
 *
 *   2. `anthropic_api`: direct HTTPS to api.anthropic.com using
 *      ANTHROPIC_API_KEY. The original path; kept for operators who
 *      prefer pay-per-token API billing over a Claude Code subscription.
 *
 * Resolution order (first match wins):
 *   1. HUB_CLAUDE_CONFIG_DIR    (hub-scoped, deliberately set for the hub)
 *   2. CLAUDE_CONFIG_DIR        (standard CLI env, fallback)
 *   3. HUB_CLAUDE_CODE_OAUTH_TOKEN  (hub-scoped token; paired with isolated dir)
 *   4. CLAUDE_CODE_OAUTH_TOKEN  (standard CLI env)
 *   5. HUB_ANTHROPIC_API_KEY   (hub-scoped API key; direct API mode)
 *   6. ANTHROPIC_API_KEY        (ambient API key; direct API mode)
 *   7. Default ~/.claude-xchain if it's been pre-populated by
 *      `CLAUDE_CONFIG_DIR=~/.claude-xchain claude login`
 *      (HUB_CLAUDE_DEFAULT_CONFIG_DIR overrides the default dir path;
 *      point it at a nonexistent dir to disable this fallback, e.g. for
 *      hermetic tests on a host that has a populated ~/.claude-xchain)
 *
 * The `_checkConfigDir` gate ensures empty, stale or logged-out dir values
 * fall through cleanly to the next candidate: it reads `.credentials.json`
 * and requires a non-empty access or refresh token, so a dir that merely
 * exists never masks a credential that would actually serve the round.
 * Token-only paths get paired with an isolated dir that is the hub's own,
 * so the spawned CLI writes its state there instead of into the host
 * operator's ambient `~/.claude`.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_HUB_CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-xchain');

function _trim(v) { return (v == null) ? '' : String(v).trim(); }

// A real `.credentials.json` is a few hundred bytes. Anything past this is not
// a credentials file, and reading it into memory to prove that is not worth it.
const MAX_CREDENTIALS_BYTES = 256 * 1024;

// The CLI writes its OAuth material under a `claudeAiOauth` envelope; older and
// hand-assembled files put the same fields at the top level, so both shapes count.
// A refresh token alone is enough: the CLI redeems it for an access token on the
// next spawn.
function _hasUsableToken(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;
    const envelopes = [parsed];
    if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === 'object') envelopes.push(parsed.claudeAiOauth);
    return envelopes.some((e) => _trim(e.accessToken) !== '' || _trim(e.refreshToken) !== '');
}

// A config dir counts as authenticated only when its `.credentials.json` actually
// carries a token. Existence alone is not authority: `claude logout` and a bare
// `claude` run both leave a dir (settings, logs, state, and a token-less
// credentials file) behind, and without this check that husk outranks the later
// OAuth-token and API-key candidates. healthCheck then reports the transport
// ready while paid calls spawn an unauthenticated CLI and map to provider_error,
// instead of falling through to the credential that would serve the round.
//
// Token values are never returned or logged from here; the answer is a boolean.
function _checkConfigDir(dirPath) {
    try {
        if (!fs.statSync(dirPath).isDirectory()) return false;
        const credPath = path.join(dirPath, '.credentials.json');
        const credStat = fs.statSync(credPath);
        if (!credStat.isFile() || credStat.size === 0 || credStat.size > MAX_CREDENTIALS_BYTES) return false;
        return _hasUsableToken(JSON.parse(fs.readFileSync(credPath, 'utf8')));
    } catch { return false; }
}

// The isolated dir is the hub's own CLAUDE_CONFIG_DIR for token-based spawns: it
// keeps the CLI's state writes out of the host operator's ambient `~/.claude`
// and gives the spawn a directory it is allowed to write. It is not a precedence
// trick; a spawn's CLAUDE_CODE_OAUTH_TOKEN is honoured whatever the dir holds.
function _ensureIsolatedDir(dirPath) {
    try { fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 }); }
    catch { /* non-fatal: CLI creates it if absent or fails cleanly */ }
}

// Resolve credentials for the LLM provider. Returns one of:
//   { ok: true,  transport: 'claude_spawn',  source, env: {...} }
//   { ok: true,  transport: 'anthropic_api', source: 'api_key', apiKey }
//   { ok: false, reason, detail }
//
// `ctx` (optional) seams in test overrides:
//   ctx.env              : env source (defaults to process.env)
//   ctx.defaultConfigDir : pin the "default isolated dir" (hermetic tests)
function resolveHubLlmAuth(ctx) {
    const envSource = (ctx && ctx.env) || process.env;
    const defaultDir = _trim(envSource.HUB_CLAUDE_DEFAULT_CONFIG_DIR)
        || _trim(ctx && ctx.defaultConfigDir) || DEFAULT_HUB_CLAUDE_CONFIG_DIR;

    const hubDir   = _trim(envSource.HUB_CLAUDE_CONFIG_DIR);
    const cliDir   = _trim(envSource.CLAUDE_CONFIG_DIR);
    const hubToken = _trim(envSource.HUB_CLAUDE_CODE_OAUTH_TOKEN);
    const cliToken = _trim(envSource.CLAUDE_CODE_OAUTH_TOKEN);
    const hubApiKey = _trim(envSource.HUB_ANTHROPIC_API_KEY);
    const apiKey   = _trim(envSource.ANTHROPIC_API_KEY);

    if (hubDir && _checkConfigDir(hubDir)) {
        return { ok: true, transport: 'claude_spawn', source: 'hub_config_dir', env: { CLAUDE_CONFIG_DIR: hubDir } };
    }
    if (cliDir && _checkConfigDir(cliDir)) {
        return { ok: true, transport: 'claude_spawn', source: 'cli_config_dir', env: { CLAUDE_CONFIG_DIR: cliDir } };
    }

    // Token paths pair with an isolated dir so the spawned CLI keeps its state
    // under the hub's own directory rather than the host operator's.
    const isolatedDir = hubDir || cliDir || defaultDir;
    if (hubToken) {
        _ensureIsolatedDir(isolatedDir);
        return { ok: true, transport: 'claude_spawn', source: 'hub_token', env: { CLAUDE_CODE_OAUTH_TOKEN: hubToken, CLAUDE_CONFIG_DIR: isolatedDir } };
    }
    if (cliToken) {
        _ensureIsolatedDir(isolatedDir);
        return { ok: true, transport: 'claude_spawn', source: 'cli_token', env: { CLAUDE_CODE_OAUTH_TOKEN: cliToken, CLAUDE_CONFIG_DIR: isolatedDir } };
    }

    // HUB_ANTHROPIC_API_KEY (hub-scoped) wins over ANTHROPIC_API_KEY (ambient),
    // mirroring the HUB_-prefix convention used for the config-dir/token paths
    // above and for resolveOpenAiAuth's HUB_OPENAI_API_KEY.
    if (hubApiKey) {
        return { ok: true, transport: 'anthropic_api', source: 'hub_api_key', apiKey: hubApiKey };
    }
    if (apiKey) {
        return { ok: true, transport: 'anthropic_api', source: 'api_key', apiKey };
    }

    if (_checkConfigDir(defaultDir)) {
        return { ok: true, transport: 'claude_spawn', source: 'default_config_dir', env: { CLAUDE_CONFIG_DIR: defaultDir } };
    }

    return {
        ok: false,
        transport: null,
        source: null,
        reason: 'no_credential_configured',
        detail: 'Set HUB_CLAUDE_CONFIG_DIR (preferred: run `CLAUDE_CONFIG_DIR=<dir> claude login` first; ' +
                'the resulting credentials.json carries a refresh token and self-renews) ' +
                'or HUB_CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, one-year TTL, no self-renewal) ' +
                'or HUB_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY (direct API).'
    };
}

// Resolve OpenAI credentials for the LLM provider's fallback-vendor models.
// Returns { ok: true, transport: 'openai_api', source, apiKey } or
// { ok: false, reason, detail }. HUB_OPENAI_API_KEY (hub-scoped) wins over
// OPENAI_API_KEY (ambient), mirroring the HUB_-prefix convention above.
function resolveOpenAiAuth(ctx) {
    const envSource = (ctx && ctx.env) || process.env;
    const hubKey = _trim(envSource.HUB_OPENAI_API_KEY);
    const key    = _trim(envSource.OPENAI_API_KEY);
    if (hubKey) return { ok: true, transport: 'openai_api', source: 'hub_api_key', apiKey: hubKey };
    if (key)    return { ok: true, transport: 'openai_api', source: 'api_key',     apiKey: key };
    return {
        ok: false,
        transport: null,
        source: null,
        reason: 'no_credential_configured',
        detail: 'Set HUB_OPENAI_API_KEY (preferred, hub-scoped) or OPENAI_API_KEY to serve ' +
                'OpenAI-vendor models on the llm attestation fallback chain.'
    };
}

// Vendor-keyed dispatch used by providers/llm.js. `vendor` is the value
// inferred from the model id (see llm.js vendorOfModel).
function resolveLlmVendorAuth(vendor, ctx) {
    switch (String(vendor || '')) {
        case 'anthropic': return resolveHubLlmAuth(ctx);
        case 'openai':    return resolveOpenAiAuth(ctx);
        default:
            return { ok: false, transport: null, source: null,
                     reason: 'unknown_vendor', detail: 'No credential resolver for vendor "' + vendor + '"' };
    }
}

module.exports = {
    resolveHubLlmAuth,
    resolveOpenAiAuth,
    resolveLlmVendorAuth,
    DEFAULT_HUB_CLAUDE_CONFIG_DIR
};
