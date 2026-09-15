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
 * claude-spawn.js: Single-shot non-interactive `claude` CLI invocation
 * for the LLM attestation provider.
 *
 * The provider's fetch() needs a stateless "send prompt, get text back"
 * primitive (no session resume, no tool use, no on-disk side effects).
 * `runClaudePrint` wraps `spawn` with the flags that achieve that:
 *
 *   claude --print --output-format json --model <m> \
 *          --tools "" --no-session-persistence \
 *          --setting-sources "" [--append-system-prompt <s> | --system-prompt <s>]
 *
 * The two system-prompt flags are not interchangeable: the appending one leaves the
 * CLI's own baked-in prompt in front of the caller's text, and only --system-prompt
 * replaces it. See opts.systemPromptOverride below.
 *
 * Prompt streams via stdin. The CLI emits a single JSON object on stdout
 * carrying { result: "<text>", ... }; the function returns that JSON
 * parsed plus the captured stderr for diagnostics.
 *
 * Credentials are resolved via hub-credentials.js; the returned `env` is
 * merged into the child process env so the CLI inherits the OAuth refresh
 * token (or env-var token) without touching the caller's shell env. The
 * competing credential vars the CLI reads on its own are scrubbed from that
 * copy first, so the ONE source the resolver selected is the only live one
 * (see CLI_CREDENTIAL_ENV_KEYS below).
 *
 ********************************************************************/

'use strict';

const { spawn } = require('child_process');
const os = require('os');
const { resolveHubLlmAuth } = require('./hub_credentials');
const hubConfig = require('../config');
const { closeOutcome } = require('../providers/llm/cli_outcome');

const CLAUDE_BIN = hubConfig.CLAUDE_BIN || 'claude';

// Credential env vars the CLI reads on its own. hub-credentials.js declares a
// resolution order and picks exactly ONE source, so any of these still inherited
// from the operator's shell is a credential the hub considered and REJECTED --
// and the CLI, not the resolver, then decides which one bills. That divergence is
// the resolver's contract broken silently: hub-credentials' own note ("a spawn's
// CLAUDE_CODE_OAUTH_TOKEN is honoured whatever the dir holds") says an ambient
// token outranks the selected config dir, so `source: hub_config_dir` could be
// reported while a stray shell export paid for the call.
//
// Scrubbed with `delete`, never assignment to '': an empty string is a value, and
// nothing here may depend on the CLI reading one as unset. The list must track the
// CLI's credential surface; ROUTING vars (ANTHROPIC_BASE_URL, CLAUDE_CODE_USE_BEDROCK,
// CLAUDE_CODE_USE_VERTEX) are deliberately left alone, since an operator pointing the
// binary at a gateway is a deployment choice this transport does not own.
const CLI_CREDENTIAL_ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR'
];

// Build the child env so the resolved source is the only live credential: copy the
// ambient env, drop every competing key, then apply auth.env LAST. Every claude_spawn
// branch of resolveHubLlmAuth sets CLAUDE_CONFIG_DIR, so scrubbing it changes nothing
// today; it is in the list so a future branch that omits it cannot inherit the
// operator's dir by accident.
function childEnv(authEnv) {
    const env = { ...hubConfig.env() };
    for (const key of CLI_CREDENTIAL_ENV_KEYS) delete env[key];
    return { ...env, ...(authEnv || {}) };
}

// Run claude --print, pipe prompt via stdin, capture parsed JSON result.
//
//   opts.prompt        (string, required)  user prompt body.
//   opts.model         (string, required)  model identifier (e.g. claude-sonnet-4-6).
//   opts.systemPrompt  (string, optional)  appended to the default system prompt.
//   opts.systemPromptOverride
//                      (string, optional)  REPLACES the default system prompt
//                                          (--system-prompt) instead of appending, so the
//                                          caller's text is the model's sole system
//                                          content. Only for a caller whose system block
//                                          is TRUSTED and whose contract depends on being
//                                          alone in that role (the judge's
//                                          data-vs-instruction framing); requester-supplied
//                                          system text must keep the appending form, which
//                                          leaves the CLI baseline in place. Mutually
//                                          exclusive with systemPrompt.
//   opts.timeoutMs     (number, optional)  kill after N ms. Default 60_000.
//   opts.maxBudgetUsd  (number, optional)  pass --max-budget-usd. Default unset.
//   opts.cwd           (string, optional)  working dir. Default os.tmpdir().
//   opts.authCtx       (object, optional)  seam for resolveHubLlmAuth (tests).
//
// Returns Promise<{ result: string, json: object, stderr: string }> on success.
// Rejects if the CLI exits non-zero, times out, or emits unparseable JSON.
async function runClaudePrint(opts) {
    const prompt       = opts && opts.prompt;
    const model        = opts && opts.model;
    const systemPrompt = opts && opts.systemPrompt;
    const systemPromptOverride = opts && opts.systemPromptOverride;
    const timeoutMs    = (opts && opts.timeoutMs) || 60000;
    const maxBudgetUsd = opts && opts.maxBudgetUsd;
    const cwd          = (opts && opts.cwd) || os.tmpdir();
    const authCtx      = opts && opts.authCtx;

    if (!prompt || typeof prompt !== 'string') throw new Error('claude-spawn: prompt (string) required');
    if (!model  || typeof model  !== 'string') throw new Error('claude-spawn: model (string) required');
    // Refuse rather than silently pick one. The two flags mean opposite things about
    // whether the CLI baseline survives, and a caller that set both has not decided.
    if (systemPrompt && systemPromptOverride)
        throw new Error('claude-spawn: systemPrompt and systemPromptOverride are mutually exclusive');

    const auth = resolveHubLlmAuth(authCtx);
    if (!auth.ok) throw new Error('claude-spawn: ' + (auth.detail || auth.reason || 'no credentials'));
    if (auth.transport !== 'claude_spawn') {
        throw new Error('claude-spawn: transport is ' + auth.transport + '; direct-API path should not call spawn');
    }

    const args = buildCliArgs(model, systemPrompt, systemPromptOverride, maxBudgetUsd);
    return await runCli(args, prompt, cwd, auth, timeoutMs);
}

// The argv for one stateless, tool-less `claude --print` turn.
function buildCliArgs(model, systemPrompt, systemPromptOverride, maxBudgetUsd) {
    const args = [
        '--print',
        '--output-format', 'json',
        '--model', model,
        // Empty string disables ALL built-in tools. Attestation must not
        // execute side effects (Bash/Edit/Read/etc.) on the validator box.
        '--tools', '',
        '--no-session-persistence',
        // Don't load user/project/local settings; this keeps responses
        // independent of the operator's Claude Code configuration.
        '--setting-sources', ''
    ];
    // --append-system-prompt ADDS to the CLI's own baked-in system prompt; only
    // --system-prompt replaces it. A caller whose system block claims to be the model's
    // sole instruction (the judge framing) is therefore wrong on this transport unless
    // it takes the override, which is why the two are separate options rather than one.
    if (systemPromptOverride) args.push('--system-prompt', systemPromptOverride);
    else if (systemPrompt)    args.push('--append-system-prompt', systemPrompt);
    if (typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0) {
        args.push('--max-budget-usd', String(maxBudgetUsd));
    }
    return args;
}

// Reject on the child failures that arrive as events rather than as an exit code.
function rejectOnChildErrors(child, timer, rejectTransient) {
    child.on('error', (e) => {
        clearTimeout(timer);
        rejectTransient('claude-spawn: spawn error: ' + e.message);
    });

    // stdin write failures on a child that exits early (bad flag, late
    // binary-resolution failure, CLI startup crash) arrive asynchronously
    // as an 'error' event (EPIPE), not as a synchronous throw from the
    // write() in runCli. Without a handler the unhandled stream error would
    // propagate to the process and can take down the whole hub; reject the
    // promise instead. The child.on('error') handler above covers spawn
    // failures only, not pipe errors.
    child.stdin.on('error', (e) => {
        clearTimeout(timer);
        rejectTransient('claude-spawn: stdin error: ' + e.message);
    });
}

// Spawn the CLI once, stream `prompt` on stdin, and settle on its exit.
function runCli(args, prompt, cwd, auth, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        const safeReject  = (e) => { if (!settled) { settled = true; reject(e); } };

        const child = spawn(CLAUDE_BIN, args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnv(auth.env)
        });

        // Classification contract shared with the HTTP transports (providers/llm.js):
        // err.transient=true marks a TRANSPORT-or-VENDOR-availability failure the judge
        // fallback chain may retry on a different model; err.transient=false marks a
        // REACHED-MODEL outcome (a verdict, a refusal, a hard vendor error) that must NOT trigger
        // re-judging, and err.kind='refusal' marks a model refusal, mirroring the
        // anthropic_api/openai_api paths so refusal reporting is symmetric across
        // vendors. Without this every bare-Error rejection fell through agree()'s
        // gate and wrongly advanced the chain past a reached-judge outcome.
        const rejectTransient = (msg) => { let err = new Error(msg); err.transient = true; safeReject(err); };
        const rejectHard = (msg, kind) => { let err = new Error(msg); err.transient = false; if (kind) err.kind = kind; safeReject(err); };

        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
            rejectTransient('claude-spawn: timeout after ' + timeoutMs + 'ms');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

        rejectOnChildErrors(child, timer, rejectTransient);

        child.on('close', (code) => {
            clearTimeout(timer);
            const outcome = closeOutcome(code, stdout, stderr);
            if (outcome.transient === true)       rejectTransient(outcome.message);
            else if (outcome.transient === false) rejectHard(outcome.message, outcome.kind);
            else                                  safeResolve({ result: outcome.result, json: outcome.json, stderr });
        });

        try {
            child.stdin.write(prompt);
            child.stdin.end();
        } catch (e) {
            clearTimeout(timer);
            rejectTransient('claude-spawn: stdin write failed: ' + e.message);
        }
    });
}

module.exports = { runClaudePrint, CLAUDE_BIN };
