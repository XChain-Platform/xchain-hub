'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const http = require('http');
const https = require('https');

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const RESPONSE_TOO_LARGE = 'CATCHUP_RESPONSE_TOO_LARGE';

function tooLargeError(contentLength) {
    const err = new Error('Hub DB catch-up response exceeded byte limit');
    err.code = RESPONSE_TOO_LARGE;
    if (Number.isFinite(contentLength)) err.contentLength = contentLength;
    return err;
}

function peerFeedUrl(peerAddr, table, cursor, limit) {
    let value = String(peerAddr || '');
    if (!/^[a-z]+:\/\//i.test(value)) value = 'ws://' + value;
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Unsupported peer URL protocol: ' + url.protocol);
    }
    url.pathname = '/hub-db/snapshot/' + table;
    url.search = '';
    url.searchParams.set('since_id', String(cursor));
    url.searchParams.set('limit', String(limit));
    return url;
}

// Keeps the status and Retry-After so the caller can back off a refusing peer.
function refusedRequestError(res) {
    const err = new Error('Snapshot request returned HTTP ' + res.statusCode);
    const retryAfterSeconds = Number(res.headers && res.headers['retry-after']);
    err.statusCode = res.statusCode;
    err.retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : null;
    return err;
}

function requestJson(url, feedKey, timeoutMs) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const headers = feedKey ? { 'x-api-key': feedKey } : {};
        const req = transport.request(url, { method: 'GET', headers }, (res) => {
            const contentLength = Number(res.headers && res.headers['content-length']);
            if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
                req.destroy(tooLargeError(contentLength));
                return;
            }
            let size = 0;
            const chunks = [];
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    req.destroy(tooLargeError(size));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(refusedRequestError(res));
                    return;
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Snapshot response was not valid JSON')); }
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Snapshot request timed out')));
        req.on('error', reject);
        req.end();
    });
}

module.exports = { peerFeedUrl, requestJson, MAX_RESPONSE_BYTES, RESPONSE_TOO_LARGE };
