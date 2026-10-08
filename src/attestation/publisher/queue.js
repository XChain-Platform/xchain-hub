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
const { isAmbiguousSendError } = require('../../lib/guards/idempotent_broadcast.js');
const { rewriteFileAtomically, splitJsonLines } = require('../../lib/fs/durable_file.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// A queue line is usable only when it parses and names both its request and its wire.
const isUsableEntry = (e) => !!(e && e.requestId && e.wire);

// Append one line to filePath and fsync it. Throws to the caller.
function appendLineSynced(filePath, line){
    let fd = fs.openSync(filePath, 'a');
    try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = {

    // ----- Durable queue (JSONL with fsync) -----

    // Durable append. Returns true on a confirmed fsync'd write, false
    // on failure. The caller GATES the fee-bearing broadcast on this result: an
    // unwritable queue must not let a real BTC fee be spent with no durable record
    // and with crash recovery disarmed for the entry. A failure is critical (not a
    // best-effort warn) and is counted in _enqueueFailures for /health visibility.
    enqueue(entry){
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

    // The queue's usable entries. An unreadable queue reads as empty here; only the
    // dequeue rewrite needs to tell the two apart, and it reads through readQueueState.
    readQueue(){
        let state = this.readQueueState();
        return state ? state.entries : [];
    },

    // Read the queue strictly: a missing file is an empty queue, and any other read
    // failure is logged and returns null, so a rewrite never mistakes it for empty.
    readQueueState(){
        let raw;
        try {
            raw = fs.readFileSync(this.queuePath, 'utf8');
        } catch (e) {
            if (e && e.code === 'ENOENT') return { entries: [], rejected: [] };
            logger.error(nodeUtil.format('AttestationPublisher: failed to read the durable queue at %s:', this.queuePath, e));
            return null;
        }
        return splitJsonLines(raw, isUsableEntry);
    },

    // Copy the queue lines no reader can use (a torn append, a hand edit) into the
    // sibling .corrupt.jsonl file before a rewrite drops them. Returns the lines that
    // could not be copied, which the rewrite keeps verbatim, so none leaves the disk.
    quarantineQueueLines(lines){
        if (!lines || lines.length === 0) return [];
        let corruptPath = this.queuePath.replace(/\.jsonl$/, '') + '.corrupt.jsonl';
        let kept = lines.filter(raw => !this.quarantineQueueLine(corruptPath, raw));
        this._corruptQueueLines = (this._corruptQueueLines || 0) + lines.length - kept.length;
        logger.error('AttestationPublisher: ' + lines.length + ' unusable line(s) on the durable queue at ' +
            this.queuePath + '; moved ' + (lines.length - kept.length) + ' to ' + corruptPath + ' and kept ' +
            kept.length + ' on the queue. Operator: inspect them for a finalized response to replay.');
        return kept;
    },

    // Append one raw queue line to the quarantine file. True once it is fsync'd there.
    quarantineQueueLine(corruptPath, raw){
        let record = JSON.stringify({ raw: raw, reason: 'unusable queue line', quarantinedAt: Date.now() }) + '\n';
        try {
            appendLineSynced(corruptPath, record);
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: failed to quarantine a queue line to %s:', corruptPath, e));
            return false;
        }
    },

    // Atomically rewrite the durable queue (temp file, fsync, rename). Returns true on
    // a confirmed fsync'd write, false on failure, which leaves the old queue whole, so
    // the dequeue path can tell whether a just-published entry is still on disk
    // (mirrors OraclePublisher.rewriteQueue). rawLines are carried through verbatim.
    rewriteQueue(entries, rawLines){
        let lines = entries.map(e => JSON.stringify(e)).concat(rawLines || []);
        let text  = lines.join('\n') + (lines.length > 0 ? '\n' : '');
        try {
            rewriteFileAtomically(fs, this.queuePath, text);
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
    // published entry. An unreadable queue is never rewritten, and a line no reader
    // can use is quarantined first, so the rewrite never erases what it could not read.
    removeFromQueue(dropSet){
        if (!dropSet || dropSet.size === 0) return true;
        let state = this.readQueueState();
        if (state === null) return this.refuseUnreadDequeue();
        let remaining = state.entries.filter(e => !dropSet.has(String(e.requestId).toLowerCase()));
        let rewritten = this.rewriteQueue(remaining, this.quarantineQueueLines(state.rejected));
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

    // Skip a dequeue whose fresh read failed: a rewrite built from it would erase every
    // finalized response still waiting. Same stance as a failed rewrite: guard stays armed.
    refuseUnreadDequeue(){
        logger.error('AttestationPublisher: CRITICAL - the durable queue at ' + this.queuePath + ' could not be ' +
            'read, so the dequeue was skipped and no queued entry was lost. Published entries remain on the queue; ' +
            'the in-process dedup guard prevents re-broadcast for this process lifetime, but a restart before the ' +
            'queue file is repaired would re-broadcast them (duplicate BTC fee spend). Fix the queue file readability now.');
        return false;
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
