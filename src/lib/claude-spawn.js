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
const { resolveHubLlmAuth } = require('./hub-credentials');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

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
function _childEnv(authEnv) {
    const env = { ...process.env };
    for (const key of CLI_CREDENTIAL_ENV_KEYS) delete env[key];
    return { ...env, ...(authEnv || {}) };
}

// A VENDOR-AVAILABILITY failure the caller may retry on another model, as opposed to
// an outcome the model actually produced. The boundary is the one providers/llm.js
// `_isTransientStatus` draws for the HTTP transports (429 plus any 5xx, 529 included);
// it is restated here rather than imported because llm.js already requires this module
// and a back-import would be circular. The two definitions are a pair: move one, move
// the other.
const AVAILABILITY_STATUS_RE = /\b(429|500|502|503|504|529)\b/;
const AVAILABILITY_TEXT_RE   = /overloaded|rate.?limit|too many requests|service unavailable|bad gateway|gateway time-?out|upstream connect error|usage limit reached|session limit/i;
const AVAILABILITY_ERROR_TYPES = ['overloaded_error', 'rate_limit_error'];

// A DETERMINISTIC refusal never heals, so it must outrank an availability match: the
// refusal wording can carry a status token of its own, and re-asking a different model
// would be shopping for an answer the first judge already gave. Same precedence the
// resolved fallback contract needs, and the same one the sibling classifier in
// prometheus-guardrails learned from live payloads.
const REFUSAL_TEXT_RE = /safeguards flagged|flagged by (?:our|the) safeguards|content[ _-]?(?:policy|filter)\s*(?:violation|refusal)|blocked by (?:our|the) (?:content|safety) (?:policy|filter|system)/i;

function _statusOf(value) {
    let n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Decide whether a non-zero CLI exit reports the VENDOR being unavailable. Reads the
// structured stdout envelope first (--output-format json carries the vendor's own
// status and error type on an error run), then the free-form error text, because which
// stream carries the detail is a CLI implementation detail this module does not own.
//
// The text scan is deliberately fed stderr plus the envelope's MESSAGE fields, never
// the whole stdout blob: a bare status token is matched by word boundary, and a usage
// or cost figure ("input_tokens":500) would otherwise read as a 500. A miss keeps
// today's answer, so the worst case of too tight a scan is the behaviour that shipped.
function _cliFailureIsTransient(stdout, stderr) {
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* free-form output; text scan below */ }
    const envelope = (json && typeof json === 'object') ? json : {};
    const err = (envelope.error && typeof envelope.error === 'object') ? envelope.error : {};

    const text = [
        stderr,
        err.message,
        envelope.message,
        envelope.subtype
    ].map((v) => (typeof v === 'string' ? v : '')).join('\n');
    if (REFUSAL_TEXT_RE.test(text)) return false;

    for (const status of [_statusOf(envelope.status), _statusOf(err.status), _statusOf(err.code)]) {
        if (status === 429 || (status >= 500 && status <= 599)) return true;
    }
    const type = String(err.type || envelope.type || envelope.subtype || '').toLowerCase();
    if (AVAILABILITY_ERROR_TYPES.includes(type)) return true;

    return AVAILABILITY_STATUS_RE.test(text) || AVAILABILITY_TEXT_RE.test(text);
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

    return await new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        const safeReject  = (e) => { if (!settled) { settled = true; reject(e); } };

        const child = spawn(CLAUDE_BIN, args, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: _childEnv(auth.env)
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
                //
                // Reaching the CLI is not the same as reaching the MODEL, though, and
                // the exit code alone cannot tell them apart. A vendor 429/5xx (529
                // included) surfaces here too, and it is an availability failure with
                // no verdict behind it: the HTTP transports classify exactly that as
                // transient and fall over to the next judge, so a hub whose transport
                // happens to be the CLI must not lose the round to the same outage.
                // Everything unrecognized -- auth, 4xx, an exhausted --max-budget-usd,
                // a refusal -- keeps the hard classification.
                const msg = 'claude-spawn: exit ' + code + (stderr ? ': ' + stderr.trim().slice(0, 400) : '');
                if (_cliFailureIsTransient(stdout, stderr)) rejectTransient(msg);
                else                                        rejectHard(msg);
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
                // The subtype test is anchored to refusal words only. It
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
            // Fail closed when the CLI reports its own failure alongside result text.
            // The empty-result branch above only fires when the text is empty, so a
            // reached-CLI failure that emitted partial text resolved as a sound
            // verdict -- the same fail-open the HTTP transports had in
            // providers/llm.js.
            //
            // Gate on is_error/subtype, NOT stop_reason: that field looks like the
            // obvious signal, but `claude --print --output-format json` emits no
            // such field (it is on the direct Anthropic Messages API, a different
            // transport); is_error + subtype is this CLI's whole failure contract, so
            // a stop_reason check here would be dead code.
            if (json && json.is_error === true) {
                let subtype = String((json && json.subtype) || '');
                let isRefusal = /refus|declin|blocked/i.test(subtype);
                rejectHard('claude-spawn: CLI reported a non-success outcome (is_error) with result text' +
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
