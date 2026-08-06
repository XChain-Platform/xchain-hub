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
//   opts.prompt        (string, required)  user prompt body.
//   opts.model         (string, required)  model identifier (e.g. claude-sonnet-4-6).
//   opts.systemPrompt  (string, optional)  appended to the default system prompt.
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
    const timeoutMs    = (opts && opts.timeoutMs) || 60000;
    const maxBudgetUsd = opts && opts.maxBudgetUsd;
    const cwd          = (opts && opts.cwd) || os.tmpdir();
    const authCtx      = opts && opts.authCtx;

    if (!prompt || typeof prompt !== 'string') throw new Error('claude-spawn: prompt (string) required');
    if (!model  || typeof model  !== 'string') throw new Error('claude-spawn: model (string) required');

    const auth = resolveHubLlmAuth(authCtx);
    if (!auth.ok) throw new Error('claude-spawn: ' + (auth.detail || auth.reason || 'no credentials'));
    if (auth.transport !== 'claude_spawn') {
        throw new Error('claude-spawn: transport is ' + auth.transport + '; direct-API path should not call spawn');
    }

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

        // Classification contract shared with the HTTP transports (providers/llm.js):
        // err.transient=true marks a TRANSPORT failure the judge fallback chain may
        // retry on a different model; err.transient=false marks a REACHED-CLI outcome
        // (the process ran and produced a verdict/error) that must NOT trigger
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

        child.on('error', (e) => {
            clearTimeout(timer);
            rejectTransient('claude-spawn: spawn error: ' + e.message);
        });

        // stdin write failures on a child that exits early (bad flag, late
        // binary-resolution failure, CLI startup crash) arrive asynchronously
        // as an 'error' event (EPIPE), not as a synchronous throw from the
        // write() below. Without a handler the unhandled stream error would
        // propagate to the process and can take down the whole hub; reject the
        // promise instead. The child.on('error') handler above covers spawn
        // failures only, not pipe errors.
        child.stdin.on('error', (e) => {
            clearTimeout(timer);
            rejectTransient('claude-spawn: stdin error: ' + e.message);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                // Non-zero exit is how a CLI-side API 4xx or model-level hard
                // failure surfaces: the process was reached, so this is not a
                // transport failure and must not advance the judge chain.
                rejectHard('claude-spawn: exit ' + code + (stderr ? ': ' + stderr.trim().slice(0, 400) : ''));
                return;
            }
            let json;
            try { json = JSON.parse(stdout); }
            catch (e) {
                rejectHard('claude-spawn: unparseable JSON from CLI: ' + stdout.slice(0, 200));
                return;
            }
            const result = (json && typeof json.result === 'string') ? json.result : '';
            if (!result) {
                // Empty result text on a clean exit is how a refusal-with-no-text
                // manifests on this path. Either way it is non-transient and must
                // not re-judge; only the recorded KIND differs.
                //
                // item 3484: the subtype test is anchored to refusal words only. It
                // used to also fire on is_error===true and on a bare 'error'
                // substring, which swallowed the CLI's own session-level failure
                // subtypes (error_max_turns, error_during_execution) -- both carry
                // is_error true AND the substring -- and reported an exhausted turn
                // budget as a model refusal. A session failure is a hard error; the
                // no-kind branch below is what says so.
                let subtype = String((json && json.subtype) || '');
                let isRefusal = /refus|declin|blocked/i.test(subtype);
                rejectHard('claude-spawn: CLI returned no result text' +
                    (subtype ? ' (subtype=' + subtype.slice(0, 60) + ')' : ''),
                    isRefusal ? 'refusal' : undefined);
                return;
            }
            safeResolve({ result, json, stderr });
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
