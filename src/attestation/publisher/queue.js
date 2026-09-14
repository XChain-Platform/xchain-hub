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
 * XChain Hub - Attestation Publisher: the durable queue and the wire
 *
 * The fsync'd WAL and spend audit, queue rewrite and removal, the broadcaster choice,
 * and the ATTEST v1 wire (the default encoder pipeline stays in the class file). Installed on
 * AttestationPublisher.prototype by src/attestation/publisher.js.
 *
 ********************************************************************/

'use strict';

const fs       = require('fs');
const nodeUtil = require('node:util');
const { isAmbiguousSendError } = require('../../lib/idempotent_broadcast.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- Durable queue (JSONL with fsync) -----

    // Durable append. Returns true on a confirmed fsync'd write, false
    // on failure. The caller GATES the fee-bearing broadcast on this result: an
    // unwritable queue must not let a real BTC fee be spent with no durable record
    // and with crash recovery disarmed for the entry. A failure is critical (not a
    // best-effort warn) and is counted in _enqueueFailures for /health visibility.
    _enqueue(entry){
        try {
            let fd = fs.openSync(this.queuePath, 'a');
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            this._enqueueFailures++;
            logger.error(nodeUtil.format('AttestationPublisher: CRITICAL - failed to durably enqueue %s... to %s; broadcast will be SKIPPED to preserve no-spend-without-a-durable-record:',
                          String(entry.requestId).substring(0,16), this.queuePath, e));
            return false;
        }
    },

    // Append-only, fsync'd audit record of an ACTUAL on-chain spend.
    // Best-effort (never blocks or reverses a spend that already happened); its job
    // is post-incident reconstruction of what BTC fee was spent, independent of
    // stdout retention. The WAL queue entry is removed on success, so without this
    // there is no durable trace of a completed spend.
    recordSpend(rid, txid, kind){
        let record = JSON.stringify({ ts: Date.now(), requestId: rid, txid: txid || null, kind: kind || 'live' }) + '\n';
        try {
            let fd = fs.openSync(this.spendLogPath, 'a');
            fs.writeSync(fd, record);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: failed to write spend-audit record for %s... to %s:',
                          String(rid).substring(0,16), this.spendLogPath, e));
        }
    },

    // Classify a broadcast failure (delegates to the shared classifier so
    // all four hub effectors answer "could this send have landed?" identically).
    isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    },

    readQueue(){
        try {
            let raw = fs.readFileSync(this.queuePath, 'utf8');
            return raw.split('\n').filter(line => line.trim().length > 0).map(line => {
                try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(e => e && e.requestId && e.wire);
        } catch (e) {
            return [];
        }
    },

    // Truncate-and-rewrite the durable queue. Returns true on a confirmed fsync'd
    // write, false on failure, so the dequeue path can tell whether a just-published
    // entry is still on disk (mirrors OraclePublisher.rewriteQueue).
    rewriteQueue(entries){
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.queuePath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: failed to rewrite queue:', e));
            return false;
        }
    },

    // Remove the given request IDs from the queue. Re-reads the queue fresh so a
    // concurrently-appended entry (from a live onRequestFinalized that fired
    // mid-sweep) is never clobbered. Returns the rewrite outcome so the at-most-once
    // guard is only reset when the durable queue is proven to no longer hold any
    // published entry.
    removeFromQueue(dropSet){
        if (!dropSet || dropSet.size === 0) return true;
        let remaining = this.readQueue().filter(e => !dropSet.has(String(e.requestId).toLowerCase()));
        let rewritten = this.rewriteQueue(remaining);
        if (rewritten){
            // The durable queue now equals `remaining`, which holds no just-dropped
            // (published) request, so no published entry can still be on disk and the
            // dedup guard can be reset to bound its growth.
            this._publishedRequests.clear();
        } else {
            logger.error('AttestationPublisher: CRITICAL - queue rewrite failed after broadcast; ' +
                'published entries remain on the durable queue at ' + this.queuePath + '. The in-process ' +
                'dedup guard prevents re-broadcast for this process lifetime, but a restart before the ' +
                'queue file is repaired would re-broadcast already-landed attestations (duplicate BTC fee spend). ' +
                'Fix the queue file writability now.');
        }
        return rewritten;
    },

    // Choose the active broadcaster, or null when none is configured.
    getBroadcaster(){
        if (this.broadcastFn) return (payload, ev) => this.broadcastFn(payload, ev);
        if (this.encoder && this.walletSignFn && this.btcAddress && this.btcPubkeyHex){
            return (payload) => this.defaultBroadcast(payload);
        }
        return null;
    },

    // Build the pipe-delimited ATTEST v1 (response) wire format that the
    // indexer's attest handler parses. Response body travels as base64 so
    // binary payloads round-trip losslessly through the pipe-delimited
    // format and so the indexer's signature verification hashes the same
    // bytes the hub signed.
    buildAttestationResponseWire({ requestId, providerId, responseBody, status, meta, signatures }){
        let bodyBuf;
        if (Buffer.isBuffer(responseBody))      bodyBuf = responseBody;
        else if (responseBody == null)          bodyBuf = Buffer.alloc(0);
        else                                    bodyBuf = Buffer.from(String(responseBody), 'utf8');
        let bodyB64 = bodyBuf.toString('base64');
        let parts = [
            'ATTEST',
            '1',
            String(requestId).toLowerCase(),
            String(providerId),
            bodyB64,
            String(status),
            String(meta || ''),
            String(signatures.length)
        ];
        for (let s of signatures){
            parts.push(String(s.pubkey).toLowerCase());
            parts.push(String(s.sig).toLowerCase());
        }
        return parts.join('|');
    }

};
