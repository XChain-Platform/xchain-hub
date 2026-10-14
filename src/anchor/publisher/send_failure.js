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
 * Signer hooks built on xchain-sdk throw the SDK's EncoderClient errors, which
 * carry no axios `.response` and no raw transport `.code`. Those shapes are
 * read here, so an SDK refusal the encoder answered before processing, and any SDK
 * failure of a build call, stays retryable the way it is through the hub's own client.
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
const { isAmbiguousSendError } = require('../../lib/guards/idempotent_broadcast.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// The fields a signer hook sets on a post-funding failure: phase1Txid (the funding
// transaction on chain), revealTxid and revealTxHex (the signed reveal that spends it).
const REVEAL_FIELDS = ['phase1Txid', 'revealTxid', 'revealTxHex'];

// Everything the classifiers below and broadcastWithRetry read off a failure, copied
// onto a replacement Error so it classifies exactly as the original would have.
const CARRIED_FIELDS = REVEAL_FIELDS.concat(['fundsCommitted', 'neverSent', 'anchorAmbiguousSend',
    'anchorNoConfirmedUtxo', 'code', 'rpcCode', 'rpcData', 'response', 'status', 'details',
    'retryAfterSeconds']);

// The SDK EncoderClient's code for an HTTP 4xx answer other than 429: the encoder
// refused the call before processing it, so nothing reached the node.
const SDK_REFUSED_CODE = /^ENCODER_HTTP_4\d\d$/;
// The SDK's code for an HTTP 429 (SDKRateLimitedError), refused before processing too.
const SDK_RATE_LIMITED = 'RATE_LIMITED';
// Encoder methods that build or read and never put a transaction on a wire. The SDK
// names the failed call on details.method, so a network fault, timeout or 5xx on one
// of these is never sent. Phase one of the SDK pipeline is create_tx, and a hook that
// has already broadcast something owes the hub fundsCommitted, which outranks this.
const SDK_PRE_SEND_METHODS = new Set(['create_tx', 'get_utxos']);

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

// True when the SDK reports a failure that put nothing on a wire: the encoder refused
// the call before processing it (4xx, 429), or the failed call was a build or read.
function isSdkNeverSent(e){
    const code = safeGet(e, 'code');
    if(typeof code !== 'string') return false;
    if(code === SDK_RATE_LIMITED || SDK_REFUSED_CODE.test(code)) return true;
    if(code.indexOf('ENCODER_') !== 0) return false;
    const details = safeGet(e, 'details');
    return isObjectLike(details) && SDK_PRE_SEND_METHODS.has(safeGet(details, 'method'));
}

// The SDK keeps the encoder's JSON-RPC error on details.rpcError rather than on
// rpcCode and rpcData, so the node's own NODE_REJECTED and TX_ALREADY_IN_CHAIN
// reasons are lifted into the fields the shared classifier reads.
function classifierView(e){
    const details = safeGet(e, 'details');
    const rpcError = isObjectLike(details) ? safeGet(details, 'rpcError') : undefined;
    if(!isObjectLike(rpcError) || safeGet(e, 'rpcCode') !== undefined) return e;
    return { message: safeGet(e, 'message'), code: safeGet(e, 'code'), response: safeGet(e, 'response'),
             neverSent: safeGet(e, 'neverSent'), fundsCommitted: safeGet(e, 'fundsCommitted'),
             rpcCode: safeGet(rpcError, 'code'), rpcData: safeGet(rpcError, 'data') };
}

// May this failure have put a transaction on a wire? fundsCommitted and an existing
// tag outrank everything; an SDK failure that sent nothing is definitive; the rest is
// the shared classifier's call, so an SDK network fault or timeout on broadcast_tx
// stays ambiguous (the request can reach the node and the reply be lost). Throws only
// when the error's own fields cannot be read.
function anchorSendAmbiguous(e){
    if(e.anchorAmbiguousSend || e.fundsCommitted) return true;
    if(e.neverSent !== true && isSdkNeverSent(e)) return false;
    return isAmbiguousSendError(classifierView(e));
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

// The reveal fields present on `e` as non-empty strings, each read on its own, so a
// field whose accessor throws is left out and the others are still recorded. A
// placeholder never reaches the record, where it could pass for a real txid.
function revealFields(e){
    const out = {};
    if(!isObjectLike(e)) return out;
    for(const k of REVEAL_FIELDS){
        const v = safeGet(e, k);
        if(typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
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
                   deadLetterAnchorSend };
