/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * claude-spawn.js — Single-shot non-interactive `claude` CLI invocation
 * for the LLM attestation provider.
 *
 * The provider's fetch() needs a stateless "send prompt, get text back"
 * primitive — no session resume, no tool use, no on-disk side effects.
 * `runClaudePrint` wraps `spawn` with the flags that achieve that:
 *
 *   claude --print --output-format json --model <m> \
 *          --tools "" --no-session-persistence \
 *          --setting-sources "" [--append-system-prompt <s>]
 *
 * Prompt streams via stdin. The CLI emits a single JSON object on stdout
 * carrying { result: "<text>", ... }; the function returns that JSON
 * parsed plus the captured stderr for diagnostics.
 *
 * Credentials are resolved via hub-credentials.js; the returned `env` is
 * merged into the child process env so the CLI inherits the OAuth refresh
 * token (or env-var token) without touching the caller's shell env.
 *
 ********************************************************************/

'use strict';

const { spawn } = require('child_process');
const os = require('os');
const { resolveHubLlmAuth } = require('./hub-credentials');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Run claude --print, pipe prompt via stdin, capture parsed JSON result.
//
//   opts.prompt        (string, required) — user prompt body.
//   opts.model         (string, required) — model identifier (e.g. claude-sonnet-4-6).
//   opts.systemPrompt  (string, optional) — appended to the default system prompt.
//   opts.timeoutMs     (number, optional) — kill after N ms. Default 60_000.
//   opts.maxBudgetUsd  (number, optional) — pass --max-budget-usd. Default unset.
//   opts.cwd           (string, optional) — working dir. Default os.tmpdir().
//   opts.authCtx       (object, optional) — seam for resolveHubLlmAuth (tests).
//
// Returns Promise<{ result: string, json: object, stderr: string }> on success.
// Rejects if the CLI exits non-zero, times out, or emits unparseable JSON.
async function runClaudePrint(opts) {
    const prompt       = opts && opts.prompt;
    const model        = opts && opts.model;
    const systemPrompt = opts && opts.systemPrompt;
    const timeoutMs    = (opts && opts.timeoutMs) || 60000;
    const maxBudgetUsd = opts && opts.maxBudgetUsd;
    const cwd          = (opts && opts.cwd) || os.tmpdir();
    const authCtx      = opts && opts.authCtx;

    if (!prompt || typeof prompt !== 'string') throw new Error('claude-spawn: prompt (string) required');
    if (!model  || typeof model  !== 'string') throw new Error('claude-spawn: model (string) required');

    const auth = resolveHubLlmAuth(authCtx);
    if (!auth.ok) throw new Error('claude-spawn: ' + (auth.detail || auth.reason || 'no credentials'));
    if (auth.transport !== 'claude_spawn') {
        throw new Error('claude-spawn: transport is ' + auth.transport + ' — direct-API path should not call spawn');
    }

    const args = [
        '--print',
        '--output-format', 'json',
        '--model', model,
        // Empty string disables ALL built-in tools — attestation must not
        // execute side effects (Bash/Edit/Read/etc.) on the validator box.
        '--tools', '',
        '--no-session-persistence',
        // Don't load user/project/local settings — keeps responses
        // independent of the operator's Claude Code configuration.
        '--setting-sources', ''
    ];
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
    if (typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0) {
        args.push('--max-budget-usd', String(maxBudgetUsd));
    }

    return await new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        const safeReject  = (e) => { if (!settled) { settled = true; reject(e); } };

        const child = spawn(CLAUDE_BIN, args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...auth.env }
        });

        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
            safeReject(new Error('claude-spawn: timeout after ' + timeoutMs + 'ms'));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

        child.on('error', (e) => {
            clearTimeout(timer);
            safeReject(new Error('claude-spawn: spawn error: ' + e.message));
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                safeReject(new Error('claude-spawn: exit ' + code + (stderr ? ': ' + stderr.trim().slice(0, 400) : '')));
                return;
            }
            let json;
            try { json = JSON.parse(stdout); }
            catch (e) {
                safeReject(new Error('claude-spawn: unparseable JSON from CLI: ' + stdout.slice(0, 200)));
                return;
            }
            const result = (json && typeof json.result === 'string') ? json.result : '';
            if (!result) {
                safeReject(new Error('claude-spawn: CLI returned no result text'));
                return;
            }
            safeResolve({ result, json, stderr });
        });

        try {
            child.stdin.write(prompt);
            child.stdin.end();
        } catch (e) {
            clearTimeout(timer);
            safeReject(new Error('claude-spawn: stdin write failed: ' + e.message));
        }
    });
}

module.exports = { runClaudePrint, CLAUDE_BIN };
