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
 *   5. ANTHROPIC_API_KEY        (direct API mode)
 *   6. Default ~/.claude-xchain-hub if it's been pre-populated by
 *      `CLAUDE_CONFIG_DIR=~/.claude-xchain-hub claude login`
 *
 * The `_checkConfigDir` gate ensures empty or stale dir values fall through
 * cleanly to the next candidate. Token-only paths get paired with an
 * isolated empty dir so the CLI's auth-file lookup misses and falls through
 * to the env-var token (the CLI prefers a populated credentials.json over
 * an env var).
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_HUB_CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-xchain-hub');

function _trim(v) { return (v == null) ? '' : String(v).trim(); }

function _checkConfigDir(dirPath) {
    try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) return false;
        return fs.readdirSync(dirPath).length > 0;
    } catch { return false; }
}

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
    const defaultDir = _trim(ctx && ctx.defaultConfigDir) || DEFAULT_HUB_CLAUDE_CONFIG_DIR;

    const hubDir   = _trim(envSource.HUB_CLAUDE_CONFIG_DIR);
    const cliDir   = _trim(envSource.CLAUDE_CONFIG_DIR);
    const hubToken = _trim(envSource.HUB_CLAUDE_CODE_OAUTH_TOKEN);
    const cliToken = _trim(envSource.CLAUDE_CODE_OAUTH_TOKEN);
    const apiKey   = _trim(envSource.ANTHROPIC_API_KEY);

    if (hubDir && _checkConfigDir(hubDir)) {
        return { ok: true, transport: 'claude_spawn', source: 'hub_config_dir', env: { CLAUDE_CONFIG_DIR: hubDir } };
    }
    if (cliDir && _checkConfigDir(cliDir)) {
        return { ok: true, transport: 'claude_spawn', source: 'cli_config_dir', env: { CLAUDE_CONFIG_DIR: cliDir } };
    }

    // Token paths pair with an isolated (empty) dir so the CLI's
    // credentials-file lookup misses and falls through to the env var.
    const isolatedDir = hubDir || cliDir || defaultDir;
    if (hubToken) {
        _ensureIsolatedDir(isolatedDir);
        return { ok: true, transport: 'claude_spawn', source: 'hub_token', env: { CLAUDE_CODE_OAUTH_TOKEN: hubToken, CLAUDE_CONFIG_DIR: isolatedDir } };
    }
    if (cliToken) {
        _ensureIsolatedDir(isolatedDir);
        return { ok: true, transport: 'claude_spawn', source: 'cli_token', env: { CLAUDE_CODE_OAUTH_TOKEN: cliToken, CLAUDE_CONFIG_DIR: isolatedDir } };
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
                'or HUB_CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, ~2-week TTL) ' +
                'or ANTHROPIC_API_KEY (direct API).'
    };
}

module.exports = {
    resolveHubLlmAuth,
    DEFAULT_HUB_CLAUDE_CONFIG_DIR
};
