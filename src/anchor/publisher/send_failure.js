/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - classifying and recording a failed send
 *
 * One rule for every anchor broadcaster, the built-in pipeline and an
 * operator signer hook alike: a failure that may have moved money (a
 * funds-committed reveal failure, a timeout, an untagged error from an opaque
 * hook) is never retried by calling the broadcaster again. A failure that
 * carries a signer hook's reveal fields is appended to the anchor dead-letter
 * file, so an operator can rebroadcast the exact signed reveal.
 *
 * Signer hooks built on xchain-sdk throw the SDK's EncoderClient errors. The shared
 * idempotent-broadcast classifier reads those shapes for every rail, so an SDK
 * refusal or build failure stays retryable here too.
 *
 * A thrown value that cannot carry a tag (a string, undefined, null, a frozen
 * or otherwise non-extensible object) is replaced by an Error that names it as
 * `cause` and carries a copy of its classification fields, so tagging can
 * never throw and lose the original failure.
 *
 * Plain functions rather than prototype methods, so broadcastWithRetry
 * reaches them from any object its methods are installed on.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const { isAmbiguousSendError, revealFields, REVEAL_FIELDS } = require('../../lib/guards/idempotent_broadcast.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// REVEAL_FIELDS and revealFields (the fields a signer hook sets on a post-funding
// failure: the funding txid and the signed reveal that spends it) are the shared copy
// in lib/guards/idempotent_broadcast.js, which every DOGE rail records from.

// Everything the classifiers below and broadcastWithRetry read off a failure, copied
// onto a replacement Error so it classifies exactly as the original would have.
const CARRIED_FIELDS = REVEAL_FIELDS.concat(['fundsCommitted', 'neverSent', 'anchorAmbiguousSend',
    'anchorNoConfirmedUtxo', 'code', 'rpcCode', 'rpcData', 'response', 'status', 'details',
    'retryAfterSeconds']);

// The SDK's code for an HTTP 429 (SDKRateLimitedError), refused before processing too.
const SDK_RATE_LIMITED = 'RATE_LIMITED';

// One property read that never throws: an accessor that throws reads as absent.
function safeGet(obj, key){
    try { return obj[key]; } catch(_e){ return undefined; }
}

function isObjectLike(v){
    return v !== null && (typeof v === 'object' || typeof v === 'function');
}

// True when `v` can take a new property without throwing.
function isTaggable(v){
    if(!isObjectLike(v)) return false;
    try { return Object.isExtensible(v); } catch(_e){ return false; }
}

function describeThrown(v){
    try { return String(v); } catch(_e){ return 'an unprintable value'; }
}

// A plain, extensible Error standing in for `v`, with `v` as its cause and a copy of
// every classification field `v` exposes. A non-object always reads as an unknown
// failure from the broadcaster, which the shared classifier treats as ambiguous.
function wrapThrown(v){
    let message = isObjectLike(v) ? safeGet(v, 'message') : undefined;
    if(typeof message !== 'string' || message === '')
        message = 'anchor broadcaster threw a non-error value: ' + describeThrown(v);
    const err = new Error(message, { cause: v });
    if(isObjectLike(v)){
        for(const k of CARRIED_FIELDS){
            const val = safeGet(v, k);
            if(val !== undefined) err[k] = val;
        }
    }
    return err;
}

// Set `flag` on the failure, replacing it with wrapThrown's stand-in when it cannot
// take the flag. Returns the object that carries it.
function withFlag(e, flag){
    let err = isTaggable(e) ? e : wrapThrown(e);
    try {
        err[flag] = true;
        if(err[flag] === true) return err;
    } catch(_e){ /* a setter or proxy refused the write: replace it below */ }
    err = wrapThrown(err);
    err[flag] = true;
    return err;
}

// May this failure have put a transaction on a wire? fundsCommitted and an existing
// tag outrank everything; the shared classifier handles both hub-client and SDK
// errors. An SDK network fault or timeout on broadcast_tx stays ambiguous.
function anchorSendAmbiguous(e){
    if(safeGet(e, 'anchorAmbiguousSend') || safeGet(e, 'fundsCommitted')) return true;
    return isAmbiguousSendError(e);
}

// The error broadcastWithRetry acts on for one broadcaster failure: tagged
// anchorAmbiguousSend when it may have spent, which is the one flag the retry loop,
// the pause and adopt checks and the intent withdrawal sites read. A failure whose
// fields cannot be read is treated as ambiguous (fail closed).
function classifyAnchorSendFailure(e){
    let err = isTaggable(e) ? e : wrapThrown(e);
    let ambiguous;
    try { ambiguous = anchorSendAmbiguous(err); }
    catch(_e){ err = wrapThrown(err); ambiguous = true; }
    return ambiguous ? withFlag(err, 'anchorAmbiguousSend') : err;
}

// The built-in pipeline's report that a failure happened before its send step, so
// nothing left the hub: tagged neverSent, whatever shape was thrown.
function markNeverSent(e){
    return withFlag(e, 'neverSent');
}

// True when the failed send may have put money on chain, so the durable publish
// intent must stay armed. fundsCommitted is read on its own as well as through the
// tag, because a signer hook sets it and it is ambiguous whatever else the error says.
function anchorSendMayHaveLanded(e){
    if(!isObjectLike(e)) return false;
    return !!(safeGet(e, 'anchorAmbiguousSend') || safeGet(e, 'fundsCommitted'));
}

// The SDK's 429 retry-after in milliseconds, or null when `e` is not an SDK rate
// limit or names no wait. broadcastWithRetry honours it like an axios Retry-After.
function sdkRetryAfterMs(e){
    if(safeGet(e, 'code') !== SDK_RATE_LIMITED) return null;
    const seconds = Number(safeGet(e, 'retryAfterSeconds'));
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

// Parse an RFC 7231 Retry-After value to milliseconds, or null when absent or
// unparseable. Both forms are in play: the encoder's per-IP limiter sends
// delta-seconds and a proxy in front of it may rewrite that to an HTTP-date.
// A past date yields 0 (retry now), never a negative wait.
function parseRetryAfterMs(raw){
    if(raw === null || raw === undefined) return null;
    let value = Array.isArray(raw) ? raw[0] : raw;
    let text = String(value).trim();
    if(text === '') return null;
    if(/^\d+$/.test(text)) return Number(text) * 1000;
    let at = Date.parse(text);
    if(Number.isNaN(at)) return null;
    return Math.max(0, at - Date.now());
}

function appendDurableLine(filePath, line){
    const fd = fs.openSync(filePath, 'a');
    try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

// Append the failed send to the anchor dead-letter file when the error carries a
// signer hook's reveal fields. The payload identifies the bundle, archive head or
// chunk; phase1Txid, revealTxid and revealTxHex are what an operator needs to
// rebroadcast the exact reveal instead of paying for the payload a second time.
// Best-effort end to end: reading the error, building the record and writing it
// all sit inside the try, so any failure returns false and never changes the
// send's outcome. An unset ANCHOR_DEADLETTER_PATH, or an empty one, resolves to the
// default path in options.js, so a falsy filePath reaches here only from a caller
// that cleared anchorDeadLetterPath itself; that send is logged and not written.
function deadLetterAnchorSend(filePath, payload, e){
    try {
        const reveal = revealFields(e);
        if(Object.keys(reveal).length === 0) return false;
        const record = Object.assign({
            payload: String(payload),
            error: describeThrown(safeGet(e, 'message') || e).slice(0, 500),
            reason: 'funded send failed after the signer hook committed funds; ' +
                    'verify on chain, then rebroadcast revealTxHex rather than republishing',
            deadLetteredAt: Date.now()
        }, reveal);
        logger.error('StateAnchorPublisher: anchor send failed AFTER funding (phase1Txid ' +
                     (reveal.phase1Txid || '?') + ', revealTxid ' + (reveal.revealTxid || '?') + '); ' +
                     'NOT re-entering the signer hook. ' +
                     (filePath ? 'Recording it with the signed reveal in ' + filePath + '.'
                               : 'No anchor dead-letter path is set, so it is not written.'));
        if(!filePath) return false;
        appendDurableLine(filePath, JSON.stringify(record) + '\n');
        return true;
    } catch(err){
        logger.error('StateAnchorPublisher: failed to write the anchor dead-letter record' +
                     (filePath ? ' to ' + filePath : '') + ': ' + describeThrown(safeGet(err, 'message') || err));
        return false;
    }
}

module.exports = { classifyAnchorSendFailure, markNeverSent, anchorSendMayHaveLanded, sdkRetryAfterMs,
                   parseRetryAfterMs, deadLetterAnchorSend };
