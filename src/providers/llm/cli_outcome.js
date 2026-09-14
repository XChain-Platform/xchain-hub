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
 * XChain Hub - llm provider: how a finished `claude --print` run settles
 *
 * The classification lib/claude_spawn.js applies once the CLI exits: a sound
 * answer, a vendor-availability failure the judge chain may retry on another
 * model, or a reached-model outcome (refusal, truncation, hard error) that must
 * not be re-asked. Pure functions over the exit code and the captured streams,
 * so the spawn itself stays the only thing lib/claude_spawn.js owns.
 *
 ********************************************************************/

// A VENDOR-AVAILABILITY failure the caller may retry on another model, as opposed to
// an outcome the model actually produced. The boundary is the one providers/llm/http.js
// `isTransientStatus` draws for the HTTP transports (429 plus any 5xx, 529 included);
// it is restated here rather than imported because it was written in lib/claude_spawn.js,
// which llm.js requires, where a back-import would be circular. The two definitions are
// a pair: move one, move the other.
const AVAILABILITY_STATUS_RE = /\b(429|500|502|503|504|529)\b/;
const AVAILABILITY_TEXT_RE   = /overloaded|rate.?limit|too many requests|service unavailable|bad gateway|gateway time-?out|upstream connect error|usage limit reached|session limit/i;
const AVAILABILITY_ERROR_TYPES = ['overloaded_error', 'rate_limit_error'];

// A DETERMINISTIC refusal never heals, so it must outrank an availability match: the
// refusal wording can carry a status token of its own, and re-asking a different model
// would be shopping for an answer the first judge already gave. Same precedence the
// resolved fallback contract needs, and the same one the sibling classifier in
// prometheus-guardrails learned from live payloads.
const REFUSAL_TEXT_RE = /safeguards flagged|flagged by (?:our|the) safeguards|content[ _-]?(?:policy|filter)\s*(?:violation|refusal)|blocked by (?:our|the) (?:content|safety) (?:policy|filter|system)/i;

function statusOf(value) {
    let n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Decide whether a CLI failure reports the VENDOR being unavailable. Reads the
// structured stdout envelope first (--output-format json carries the vendor's own
// status and error type on an error run), then the free-form error text, because which
// stream carries the detail is a CLI implementation detail this module does not own.
//
// Field set read: api_error_status (envelope and error, the documented carrier of the
// vendor's HTTP status on the success-shaped result), status / error.status /
// error.code, error.type / type / subtype, and the message text plus the string
// entries of the errors[] array. The 429-plus-any-5xx boundary itself is unchanged, so
// the paired isTransientStatus in providers/llm/http.js does not move with this.
//
// The text scan is deliberately fed stderr plus the envelope's MESSAGE fields, never
// the whole stdout blob: a bare status token is matched by word boundary, and a usage
// or cost figure ("input_tokens":500) would otherwise read as a 500. A miss keeps
// today's answer, so the worst case of too tight a scan is the behaviour that shipped.
function cliFailureIsTransient(stdout, stderr) {
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* free-form output; text scan below */ }
    const envelope = (json && typeof json === 'object') ? json : {};
    const err = (envelope.error && typeof envelope.error === 'object') ? envelope.error : {};

    // envelope.errors is the CLI's own diagnostic array on an execution-error result
    // (item 7756). Only its STRING entries join the scan, and they join it here rather
    // than as a blob: an object entry stringifies to '[object Object]' and a nested
    // usage figure would come back as a bare number the status regex could read as a 5xx.
    const errorsText = Array.isArray(envelope.errors)
        ? envelope.errors.filter((v) => typeof v === 'string').join('\n')
        : '';

    const text = [
        stderr,
        err.message,
        envelope.message,
        envelope.subtype,
        errorsText
    ].map((v) => (typeof v === 'string' ? v : '')).join('\n');
    if (REFUSAL_TEXT_RE.test(text)) return false;

    // api_error_status is the field the CLI's result envelope actually carries the
    // vendor's HTTP status on, and it rides on the SUCCESS-shaped result, so it is read
    // alongside the error-shaped status fields rather than instead of them (item 7756).
    for (const status of [statusOf(envelope.api_error_status), statusOf(err.api_error_status),
                          statusOf(envelope.status), statusOf(err.status), statusOf(err.code)]) {
        if (status === 429 || (status >= 500 && status <= 599)) return true;
    }
    const type = String(err.type || envelope.type || envelope.subtype || '').toLowerCase();
    if (AVAILABILITY_ERROR_TYPES.includes(type)) return true;

    return AVAILABILITY_STATUS_RE.test(text) || AVAILABILITY_TEXT_RE.test(text);
}

// An availability failure: the judge chain may retry it on a different model.
const transient = (message) => ({ transient: true, message });
// A reached-model outcome: never re-judged, optionally typed 'refusal' or 'truncation'.
const hard = (message, kind) => ({ transient: false, message, kind });

// A clean exit with no result text.
function emptyResultOutcome(json, stdout) {
    // Empty result text on a clean exit is how a refusal-with-no-text
    // manifests on this path. Either way it is non-transient and must
    // not re-judge; only the recorded KIND differs.
    //
    // The subtype test is anchored to refusal words only. It
    // once also fired on is_error===true and on a bare 'error'
    // substring, which swallowed the CLI's own session-level failure
    // subtypes (error_max_turns, error_during_execution) -- both carry
    // is_error true AND the substring -- and reported an exhausted turn
    // budget as a model refusal. A session failure is a hard error; the
    // no-kind branch below is what says so.
    let subtype = String((json && json.subtype) || '');
    let isRefusal = /refus|declin|blocked/i.test(subtype);
    // A vendor 429/5xx can exit 0 (item 7756): api_error_status rides on the
    // success-shaped result, so the outage lands here with empty result text
    // rather than on the non-zero branch above. Consult the same classifier,
    // refusal first, so it fails over to the next judge instead of burning the
    // round. Everything it does not recognize keeps today's hard rejection.
    if (!isRefusal && cliFailureIsTransient(stdout, '')) {
        return transient('claude-spawn: CLI returned no result text' +
            (subtype ? ' (subtype=' + subtype.slice(0, 60) + ')' : ''));
    }
    return hard('claude-spawn: CLI returned no result text' +
        (subtype ? ' (subtype=' + subtype.slice(0, 60) + ')' : ''),
        isRefusal ? 'refusal' : undefined);
}

// Result text that arrived beside the CLI's own is_error flag.
function errorFlagOutcome(json, stdout) {
    let subtype = String((json && json.subtype) || '');
    let isRefusal = /refus|declin|blocked/i.test(subtype);
    // Same availability route as the empty-result branch (item 7756). The
    // classifier is NOT fed the result text here: a judge verdict that happens
    // to mention a status token would otherwise re-ask a model that already
    // answered, which is the verdict-shopping the refusal precedence exists to
    // prevent. Only the envelope's own status and diagnostic fields decide.
    if (!isRefusal && cliFailureIsTransient(stdout, '')) {
        return transient('claude-spawn: CLI reported a non-success outcome (is_error) with result text' +
            (subtype ? ' (subtype=' + subtype.slice(0, 60) + ')' : ''));
    }
    return hard('claude-spawn: CLI reported a non-success outcome (is_error) with result text' +
        (subtype ? ' (subtype=' + subtype.slice(0, 60) + ')' : ''),
        isRefusal ? 'refusal' : undefined);
}

// Settle a finished CLI run. Returns { transient: true, message } for an availability
// failure, { transient: false, message, kind } for a reached-model outcome, or
// { result, json } for a sound answer.
function closeOutcome(code, stdout, stderr) {
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
        if (cliFailureIsTransient(stdout, stderr)) return transient(msg);
        else                                        return hard(msg);
    }
    let json;
    try { json = JSON.parse(stdout); }
    catch (e) {
        return hard('claude-spawn: unparseable JSON from CLI: ' + stdout.slice(0, 200));
    }
    const result = (json && typeof json.result === 'string') ? json.result : '';
    if (!result) return emptyResultOutcome(json, stdout);
    // Fail closed when the CLI reports its own failure alongside result text.
    // The empty-result branch above fires only when the text is empty, so without
    // this branch a reached-CLI failure that emits partial text resolves as a
    // sound verdict: the same fail-open providers/llm.js closes on its HTTP
    // transports.
    //
    // is_error + subtype is the CLI's own documented failure contract and stays
    // the primary gate; the stop_reason net below is a second, narrower one.
    //
    // The CLI does emit a stop_reason, so a check on it here is live code, not
    // dead: the `type:"result"` envelope carries a top-level stop_reason (observed
    // as `stop_reason:null` on the CLI's own error result, alongside end_turn /
    // tool_use / stop_sequence / refusal). Unchecked, a refusal or a truncation
    // arriving with is_error false and non-empty text resolves as a sound verdict.
    // This transport signs its text into on-chain attestation answers and parses
    // judge verdicts out of it, and the two direct HTTP transports reject exactly
    // these outcomes even when text is emitted (the anthropic_api refusal and
    // truncation branches in providers/llm.js), so the CLI must not be the one lane that accepts them.
    if (json && json.is_error === true) return errorFlagOutcome(json, stdout);
    // Presence-conditional, TOP-LEVEL only, reject-known-bad. Reading nested
    // per-turn messages would falsely reject a complete answer whose intermediate
    // turn hit max_tokens; an absent field, an empty string, and every other value
    // (end_turn, tool_use, stop_sequence, tool_deferred, anything new) fall through
    // to resolve, which is the same allow-by-default posture the HTTP branches take.
    const stop = (json && typeof json.stop_reason === 'string') ? json.stop_reason : '';
    if (stop === 'refusal') {
        return hard('claude-spawn: CLI reported a model refusal (stop_reason=refusal) with result text',
            'refusal');
    }
    if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') {
        return hard('claude-spawn: CLI response truncated (stop_reason=' + stop + ')', 'truncation');
    }
    return { result, json };
}

module.exports = { closeOutcome };
