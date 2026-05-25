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
 * XChain Hub - Attestation Publisher
 *
 * Subscribes to AttestationConsensus 'request:finalized' events and, when
 * this validator is the leader for the round, builds the on-chain
 * ATTESTATION_RESPONSE wire payload and broadcasts it via an operator-
 * provided hook. Followers' publishers are no-ops per request (only the
 * leader broadcasts to avoid duplicate-tx waste).
 *
 * Wire format (parsed by xchain-indexer/src/actions/attestation_response.js):
 *   ATTESTATION_RESPONSE|0|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|
 *     SIG_COUNT|PUBKEY1|SIG1|PUBKEY2|SIG2|...
 *
 * Broadcast strategy (mirrors OraclePublisher.js):
 *   - setBroadcastHook(fn)  — operator-supplied broadcaster receives the wire
 *                             payload string, returns { txid }. Used directly
 *                             when present.
 *   - setEncoder + setWalletSignHook for the default pipeline — build PSBT via
 *     xchain-encoder, sign via wallet hook, broadcast via encoder. (Same
 *     hooks shape as OraclePublisher; phase-3+ wiring.)
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§5.2, §9)
 *
 ********************************************************************/

const fs            = require('fs');
const path          = require('path');
const EncoderClient = require('./EncoderClient.js');

class AttestationPublisher {

    constructor(hub){
        this.hub      = hub;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        let cfg = hub.p2pConfig || {};
        this.queuePath = process.env.ATTESTATION_QUEUE_PATH || cfg.ATTESTATION_QUEUE_PATH || './data/attestation-queue.jsonl';

        // Optional BTC encoder wiring (default pipeline). Mirrors OraclePublisher.
        let encoderUrl = process.env.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
        let encoderKey = process.env.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
        this.btcAddress    = process.env.BTC_ADDRESS    || cfg.BTC_ADDRESS    || '';
        this.btcPubkeyHex  = process.env.BTC_PUBKEY_HEX || cfg.BTC_PUBKEY_HEX || '';

        // Operator-supplied hooks
        this.broadcastFn  = null;  // fn(wirePayload) → Promise<{txid}>
        this.walletSignFn = null;  // fn(psbtHex)     → Promise<txHex>
    }

    setBroadcastHook(fn){ this.broadcastFn  = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setEncoder(encoder){ this.encoder = encoder; }

    async start(){
        // Ensure queue dir exists (best effort — used for crash-recovery diagnostics
        // in future scope; not load-bearing for the v1 broadcast path).
        try {
            fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            console.warn('AttestationPublisher: queue file unwritable at ' + this.queuePath + ': ' + e.message);
        }

        // Subscribe to consensus finalization
        if (this.hub.attestationConsensus){
            this.hub.attestationConsensus.on('request:finalized', (event) => {
                this.onRequestFinalized(event).catch(err => {
                    console.error('AttestationPublisher: onRequestFinalized error: ' + (err && err.message ? err.message : err));
                });
            });
        }

        console.log('AttestationPublisher started (queue: ' + this.queuePath + ')');
    }

    async stop(){
        // Nothing persistent to drain right now — the queue file is informational.
    }

    // Called when AttestationConsensus emits 'request:finalized'. The leader
    // assembles and broadcasts; followers no-op for this request.
    async onRequestFinalized(event){
        if (!event || !event.requestId) return;
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let isLeader = (event.leaderPubkey && myPubkey && event.leaderPubkey.toLowerCase() === myPubkey);
        if (!isLeader){
            // Followers don't broadcast. (Failover rotation: out of scope for Phase 2-3;
            // missed-leader response retries via deadline-expiry.)
            return;
        }
        if (!event.signatures || event.signatures.length === 0){
            console.warn('AttestationPublisher: no sigs in finalized event for ' + event.requestId.substring(0,16) + '... — skipping broadcast');
            return;
        }

        let payload = this.buildAttestationResponseWire({
            requestId:   event.requestId,
            providerId:  event.providerId,
            responseBody: event.responseBody,
            status:      event.status || 'ok',
            meta:        event.meta,
            signatures:  event.signatures
        });

        // Crash-resume log: best-effort append so an operator can re-broadcast
        // manually if the in-flight broadcast fails.
        try {
            fs.appendFileSync(this.queuePath, JSON.stringify({
                ts:        Date.now(),
                requestId: event.requestId,
                wire:      payload
            }) + '\n');
        } catch (_) { /* non-fatal */ }

        try {
            let result;
            if (this.broadcastFn){
                result = await this.broadcastFn(payload, event);
            } else if (this.encoder && this.walletSignFn && this.btcAddress && this.btcPubkeyHex){
                result = await this._defaultBroadcast(payload);
            } else {
                console.warn('AttestationPublisher: no broadcast hook configured for ' + event.requestId.substring(0,16) + '... — skipping');
                return;
            }
            console.log('AttestationPublisher: broadcast ' + event.requestId.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
        } catch (e) {
            console.error('AttestationPublisher: broadcast failed for ' + event.requestId.substring(0,16) + '...: ' + (e && e.message ? e.message : e));
        }
    }

    // Build the pipe-delimited ATTESTATION_RESPONSE wire format that the
    // indexer's attestation_response handler parses. Response body travels
    // as base64 so binary payloads round-trip losslessly through the
    // pipe-delimited format and so the indexer's signature verification
    // hashes the same bytes the hub signed.
    buildAttestationResponseWire({ requestId, providerId, responseBody, status, meta, signatures }){
        let bodyBuf;
        if (Buffer.isBuffer(responseBody))      bodyBuf = responseBody;
        else if (responseBody == null)          bodyBuf = Buffer.alloc(0);
        else                                    bodyBuf = Buffer.from(String(responseBody), 'utf8');
        let bodyB64 = bodyBuf.toString('base64');
        let parts = [
            'ATTESTATION_RESPONSE',
            '0',
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

    async _defaultBroadcast(payload){
        if (!this.encoder)       throw new Error('no encoder configured');
        if (!this.walletSignFn)  throw new Error('no wallet sign hook configured');
        if (!this.btcAddress)    throw new Error('no BTC_ADDRESS configured');
        if (!this.btcPubkeyHex)  throw new Error('no BTC_PUBKEY_HEX configured');

        let utxos = await this.encoder.getUtxos(this.btcAddress);
        if (!utxos || (Array.isArray(utxos) && utxos.length === 0)){
            throw new Error('no UTXOs available for ' + this.btcAddress);
        }
        let psbtResult = await this.encoder.createTx({
            utxos:    utxos,
            pubkey:   this.btcPubkeyHex,
            data:     payload,
            change:   this.btcAddress,
            encoding: 'p2sh'  // response payloads can exceed 80-byte OP_RETURN
        });
        if (!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        let txHex = await this.walletSignFn(psbtResult.psbt);
        if (!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        return await this.encoder.broadcastTx(txHex);
    }
}

module.exports = AttestationPublisher;
