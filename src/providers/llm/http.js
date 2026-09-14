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
 * XChain Hub - llm provider: HTTPS plumbing shared by the vendor APIs
 *
 * How a vendor HTTP response is classified (status first, transient or
 * hard), the total wall-clock budget every request runs under, and the
 * OpenAI chat-completions call. The Claude Messages call in llm.js is built
 * from the same pieces.
 *
 ********************************************************************/

const https = require('https');

// Classify an HTTP status / transport failure as transient (429 rate-limit,
// 5xx overloaded/gateway, network timeout/reset) vs hard (4xx config/auth/bad
// request). Two consumers read the verdict, and only one ignores it. On the
// fetch() path it is observability only: AttestationRound maps ANY fetch failure
// to provider_error and there is NO in-round retry, so round timing and verdict
// derivation are unchanged. On the agree() path it is LOAD-BEARING: the judge
// fallback chain branches on it, where transient=false stops the chain and defers
// to no_quorum while transient/undefined advances to the next judge model (see
// the transport-only invariant in agree()). Moving the 429/5xx boundary here
// therefore changes which vendor errors earn a same-round judge fallback.
function isTransientStatus(status) {
    let s = Number(status);
    return s === 429 || (s >= 500 && s <= 599);
}

// The HTTP status decides whether a response is a completion at all; the body's
// SHAPE only says which vendor wrote the error. Both transports must ask the status
// question, because asking the shape question alone (`json.type === 'error' ||
// json.error`, or `json.error`) lets a non-2xx carrying neither key through: a
// gateway's `{"message":"Service unavailable"}` or an infrastructure JSON error page
// parses clean, resolves as SUCCESS, and degrades downstream to empty text. That is
// worse than a loud failure on the agree() path, where an empty judge verdict records
// as `empty_verdict`, which AttestationSpotChecker's TRANSIENT_INCONCLUSIVE does not
// hold: the outage discards the spot-check with no evidence and never re-judges, while
// the SAME 503 carrying a vendor error envelope correctly fails over.
//
// Returns an error to reject with, or null when the status is a real 2xx. 3xx counts
// as failure too: https.request does not follow redirects, so a 3xx body is not a
// completion either.
function _httpStatusError(res, vendorLabel, json, str) {
    if (res.statusCode >= 200 && res.statusCode < 300) return null;
    let detail = (json && json.error && json.error.message) ? json.error.message
               : (json && typeof json.message === 'string') ? json.message
               : 'HTTP ' + res.statusCode + ': ' + String(str).substring(0, 200);
    let err = new Error('llm: ' + vendorLabel + ': ' + detail);
    err.httpStatus = res.statusCode;
    err.transient  = isTransientStatus(res.statusCode);
    return err;
}

// Node's https `timeout` option arms an IDLE-socket timer only: it resets on
// every byte received, so a vendor endpoint (or proxy) that drips bytes
// slower than the idle window can hold a request open far past the caller's
// intended budget. This arms a hard wall-clock deadline alongside it so
// `timeoutMs` is honored as a TOTAL request budget on every transport,
// mirroring the claude_spawn transport's kill-on-deadline behavior.
function armWallClockDeadline(req, timeoutMs, onDeadline) {
    let timer = setTimeout(() => {
        req.destroy();
        onDeadline();
    }, timeoutMs);
    if (timer.unref) timer.unref();
    req.once('close', () => clearTimeout(timer));
    return timer;
}

// A resolve/reject pair that settles its promise once: whichever of a response,
// a socket error, the idle timeout or the wall-clock deadline comes first wins.
function settleOnce(resolve, reject) {
    let settled = false;
    let safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
    let safeReject  = (e) => { if (!settled) { settled = true; reject(e); } };
    return { safeResolve, safeReject };
}

// The request-side failures every vendor call treats the same way: a socket error,
// the idle timeout and the wall-clock deadline, each a transient rejection.
function armRequestFailures(req, timeoutMs, safeReject) {
    req.on('error',   (e) => { let err = new Error('llm: request error: ' + e.message); err.transient = true; safeReject(err); });
    req.on('timeout', ()  => { req.destroy(); let err = new Error('llm: timeout after ' + timeoutMs + 'ms'); err.transient = true; safeReject(err); });
    armWallClockDeadline(req, timeoutMs, () => {
        let err = new Error('llm: timeout after ' + timeoutMs + 'ms (wall-clock deadline)');
        err.transient = true;
        safeReject(err);
    });
}

// Add one response's token counts to the provider instance's tally, the counter
// healthCheck reports.
function tallyTokens(_tokenUsage, inputTokens, outputTokens) {
    _tokenUsage.inputTokens  += inputTokens  ?? 0;
    _tokenUsage.outputTokens += outputTokens ?? 0;
    _tokenUsage.calls        += 1;
}

// POST one chat-completions request; resolves the parsed body of a 2xx response.
async function callOpenAi(apiPath, body, apiKey, options, _tokenUsage) {
    let timeoutMs = Number(options && options.timeoutMs) || 30000;
    let data = JSON.stringify(body);

    return await new Promise((resolve, reject) => {
        let { safeResolve, safeReject } = settleOnce(resolve, reject);

        let req = https.request({
            method:   'POST',
            hostname: 'api.openai.com',
            path:     apiPath,
            headers: {
                'Content-Type':   'application/json',
                'Authorization':  'Bearer ' + apiKey,
                'Content-Length': Buffer.byteLength(data)
            },
            timeout: timeoutMs
        }, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end',  () => {
                let str = Buffer.concat(chunks).toString('utf8');
                try {
                    let json = JSON.parse(str);
                    // Status first, body shape second: see _httpStatusError. Same
                    // rule as the Claude API branch, since this was the same mistake
                    // written twice.
                    let statusErr = _httpStatusError(res, 'OpenAI API', json, str);
                    if (statusErr) { safeReject(statusErr); return; }
                    if (json.error) {
                        let msg = (json.error && json.error.message) ? json.error.message : JSON.stringify(json);
                        let err = new Error('llm: OpenAI API: ' + msg);
                        err.httpStatus = res.statusCode;
                        err.transient  = isTransientStatus(res.statusCode);
                        safeReject(err);
                        return;
                    }
                    if (json.usage) tallyTokens(_tokenUsage, json.usage.prompt_tokens, json.usage.completion_tokens);
                    safeResolve(json);
                } catch (e) {
                    // A 429/5xx from a gateway/proxy often carries a non-JSON (HTML)
                    // body and lands here; classify by status so it is not misrecorded
                    // as a hard malformed-response error.
                    let err = new Error('llm: OpenAI API: malformed response (' + str.substring(0, 200) + ')');
                    err.httpStatus = res.statusCode;
                    err.transient  = isTransientStatus(res.statusCode);
                    safeReject(err);
                }
            });
            res.on('error', (e) => { let err = new Error('llm: response error: ' + e.message); err.transient = true; safeReject(err); });
        });
        armRequestFailures(req, timeoutMs, safeReject);
        req.write(data);
        req.end();
    });
}

module.exports = { isTransientStatus, _httpStatusError, settleOnce, armRequestFailures, tallyTokens, callOpenAi };