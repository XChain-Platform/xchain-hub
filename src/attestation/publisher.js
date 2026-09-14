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
 * XChain Hub - Attestation Publisher
 *
 * Subscribes to AttestationConsensus 'request:finalized' events and ships the
 * on-chain ATTEST v1 (response) wire payload via an operator-provided hook.
 *
 * Durability + failover (mirrors OraclePublisher.js):
 *   - The finalized payload is written to a durable, fsync'd write-ahead log
 *     (`attestation-queue.jsonl`) BEFORE any broadcast attempt, by every node
 *     in the request's responsible set, not just the leader.
 *   - The leader broadcasts immediately and drops its queue entry on success.
 *   - A periodic sweep (_processQueue, also run once on startup, re-broadcasts
 *     any entry whose request is still pending on the indexer:
 *       * the leader's own entry is retried if the live broadcast failed or the
 *         process crashed between the queue write and the send (crash recovery);
 *       * a follower steps in once the leader has been silent for
 *         `failoverWindowBlocks` blocks (rank-staggered so the responsible set
 *         takes over in deterministic order), using the committed signatures it
 *         already holds in the queued payload.
 *   - The indexer's pending-request set is the first double-broadcast guard: an
 *     entry whose request is no longer pending has already landed on-chain (or
 *     expired) and is dropped without re-broadcast. It cannot stand alone, because
 *     an accepted-but-unmined response is still PENDING and reads exactly like one
 *     that was never sent.
 *   - The durable `attest_published_requests` marker is what closes that gap
 *     across a restart: intent is recorded IMMEDIATELY before the send, past every
 *     remaining no-send exit, and confirmed after it, so the sweep can tell "already
 *     broadcast" from "never sent", and an intent-without-confirmation is quarantined
 *     for an operator rather than re-broadcast. That ordering is load-bearing, not
 *     incidental: quarantine is permanent and operator-only, so an intent row that
 *     outlives a DESIGNED non-send (a tripped spend ceiling, a rejected pre-send)
 *     would strand a request the sweep would otherwise have published in a later
 *     window. Ported from OraclePublisher; inert where no hub DB is wired.
 *   - The marker identifies a PUBLICATION, request id plus response status, not a
 *     request. A non-ok response is advisory and leaves the request PENDING and
 *     retryable, so the same request can later finalize ok, and a request-keyed marker
 *     reads that ok as a duplicate and never spends the fee that answers it. The
 *     status set lives in the row (`sent_statuses`, with `intent_status` for the armed
 *     one) rather than in the primary key, so a hub upgrades by adding two nullable
 *     columns and a row that names no status keeps holding its whole request.
 *
 * Wire format (parsed by xchain-indexer/src/actions/attest/index.js):
 *   ATTEST|1|REQUEST_ID|PROVIDER_ID|RESPONSE_PAYLOAD|STATUS|META|
 *     SIG_COUNT|PUBKEY1|SIG1|PUBKEY2|SIG2|...
 *
 * Broadcast strategy (mirrors OraclePublisher.js):
 *   - setBroadcastHook(fn): operator-supplied broadcaster receives the wire
 *                             payload string, returns { txid }. Used directly
 *                             when present.
 *   - setEncoder + setWalletSignHook for the default pipeline; build PSBT via
 *     xchain-encoder, sign via wallet hook, broadcast via encoder. (Same
 *     hooks shape as OraclePublisher; phase-3+ wiring.)
 *
 ********************************************************************/

// This file keeps the class: construction, the operator-facing stats and the
// lifecycle, plus defaultBroadcast: test/unit/two_phase_guard.test.js and
// encoder_utxo_forward.test.js census the fee-bearing pipeline by reading THIS file's
// text, so the guarded encoder call stays where they look. Everything else lives in named parts under ./publisher/ and is installed
// on the prototype below, so every require path and method name is exactly what it was.
const fs   = require('fs');
const path = require('path');

const { initPublisherSpend, initPublisherFailover, initPublisherGuards } = require('./publisher/options.js');
const onFinalized = require('./publisher/on_finalized.js');
const queue       = require('./publisher/queue.js');
const markers     = require('./publisher/markers.js');
const retention   = require('./publisher/retention.js');
const responsible = require('./publisher/responsible.js');
const sweep       = require('./publisher/sweep.js');
const { forwardableUtxos } = require('../lib/encoder_utxo_forward.js');
const { assertSingleTxEncoding } = require('../lib/two_phase_guard.js');
const hubConfig = require('../config');
const nodeUtil  = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

class AttestationPublisher {

    constructor(hub){
        this.hub      = hub;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        let cfg = hub.p2pConfig || {};
        this.queuePath = hubConfig.ATTESTATION_QUEUE_PATH || cfg.ATTESTATION_QUEUE_PATH || './data/attestation-queue.jsonl';

        // Construction in named steps, in the order the fields were assigned before the
        // split (src/attestation/publisher/options.js).
        initPublisherSpend(this, cfg);
        initPublisherFailover(this, cfg);
        initPublisherGuards(this, cfg);

        this._sweeping = false;   // sweep self-overlap guard, see _processQueue()
    }

    // Operator-facing stats for the /health response and status tooling.
    getPublisherStats(){
        return {
            broadcastSucceeded: this._broadcastSucceeded,
            broadcastFailed:    this._broadcastFailed,
            enqueueFailures:    this._enqueueFailures,
            enabled:            this.enabled,
            quarantined:        this._quarantinedRequests.size,   // needs operator replay
            publishedRequestsRetentionMs: this.publishedRequestsRetentionMs,
            publishedRequestsPruned:      this.publishedRequestsPruned,
            spendGuard:         this.spendGuard.stats()
        };
    }

    setBroadcastHook(fn){ this.broadcastFn  = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setEncoder(encoder){ this.encoder = encoder; }

    async start(){
        // The per-window spend ceilings were memory-only, so every restart
        // restored a full allowance. Reload the saved window before anything publishes.
        this.spendGuard.persistTo();
        // Ensure the queue exists. The queue is load-bearing: it is the durable
        // write-ahead log that lets a finalized response survive a leader crash
        // and lets followers step in if the leader goes silent.
        try {
            fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            logger.warn(nodeUtil.format('AttestationPublisher: queue file unwritable at ' + this.queuePath + ':', e));
        }

        if (this.hub.attestationConsensus){
            // The handler is STORED so stop() can detach it. An anonymous closure here
            // cannot be removed, so a hub closed and reopened in one process keeps every
            // previous lifetime's publisher subscribed and one finalized response fans out
            // to all of them; the spot checker keeps its handler the same way for the same
            // reason.
            this._finalizedHandler = (event) => {
                this.onRequestFinalized(event).catch(err => {
                    logger.error('AttestationPublisher: onRequestFinalized error: ' + (err && err.message ? err.message : err));
                });
            };
            this.hub.attestationConsensus.on('request:finalized', this._finalizedHandler);
        }

        // Load the durable at-most-once markers BEFORE the crash-replay
        // sweep below, or that first sweep is exactly the pass that re-broadcasts a
        // response the pre-crash process already sent.
        await this.hydratePublishedMarkers().catch(err =>
            logger.error('AttestationPublisher: durable publish-marker hydration failed; the in-process guard is ' +
                          'the only cover this lifetime: ' + (err && err.message ? err.message : err)));

        // Crash recovery: replay any finalized responses that survived a restart
        // (a leader that crashed between the queue write and the broadcast).
        await this._processQueue().catch(err =>
            logger.error('AttestationPublisher: startup replay error: ' + (err && err.message ? err.message : err)));

        // Ongoing failover sweep: retries failed leader broadcasts and lets
        // followers step in once the leader has been silent past the window.
        this._sweepTimer = setInterval(() => {
            this._processQueue().catch(err =>
                logger.error('AttestationPublisher: sweep error: ' + (err && err.message ? err.message : err)));
        }, this.failoverPollMs);

        logger.info('AttestationPublisher started (queue: ' + this.queuePath +
                    ', failover window: ' + this.failoverWindowBlocks + ' block(s))');
    }

    async stop(){
        // The queue file is durable WAL state; it is intentionally NOT drained
        // or truncated here. Surviving entries are replayed by _processQueue on
        // the next start(), which is what protects a finalized response across a
        // crash. We only stop the in-process sweep timer.
        if(this._sweepTimer){
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
        // Detach before returning: stop() is what close() calls, and a subscription that
        // outlives the engine is the leak close() exists to prevent.
        // The typeof guard matches AttestationSpotChecker.stop(): a test double may carry
        // `on` without `removeListener`, and throwing here would abort close() partway.
        if(this.hub.attestationConsensus && this._finalizedHandler
           && typeof this.hub.attestationConsensus.removeListener === 'function'){
            this.hub.attestationConsensus.removeListener('request:finalized', this._finalizedHandler);
            this._finalizedHandler = null;
        }
    }

    async defaultBroadcast(payload){
        if (!this.encoder)       throw new Error('no encoder configured');
        if (!this.walletSignFn)  throw new Error('no wallet sign hook configured');
        if (!this.btcAddress)    throw new Error('no BTC_ADDRESS configured');
        if (!this.btcPubkeyHex)  throw new Error('no BTC_PUBKEY_HEX configured');

        let utxos = await this.encoder.getUtxos(this.btcAddress);
        if (!utxos || (Array.isArray(utxos) && utxos.length === 0)){
            throw new Error('no UTXOs available for ' + this.btcAddress);
        }
        let psbtResult = await this.encoder.createTx({
            // Forwarded only while inside the encoder's caller-facing MAX_UTXO_COUNT;
            // past it the param is omitted so the encoder selects from its own
            // uncapped fetch of this same address (lib/encoder_utxo_forward.js).
            utxos:    forwardableUtxos(utxos, 'AttestationPublisher'),
            // The encoder's P2SH path runs bitcoin.address.fromBase58Check() on this
            // field, so it must be the base58check address, not the raw hex pubkey.
            pubkey:   this.btcAddress,
            data:     payload,
            change:   this.btcAddress,
            encoding: 'P2SH'  // response payloads can exceed 80-byte OP_RETURN
        });
        if (!psbtResult || !psbtResult.psbt) throw new Error('encoder returned no PSBT');
        // Refuse phase 1 of a two-transaction encoding before anything is signed: this
        // pipeline has no reveal, so broadcasting the P2SH funding tx would publish an
        // ATTEST no indexer can decode and strand the carrier value (lib/two_phase_guard.js).
        assertSingleTxEncoding(psbtResult, 'AttestationPublisher');
        let txHex = await this.walletSignFn(psbtResult.psbt);
        if (!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        // Everything above is pre-send (build/sign; no money moved). Only broadcast_tx
        // has a side effect, so only ITS failures are classified for ambiguity.
        try {
            return await this.encoder.broadcastTx(txHex);
        } catch (e) {
            if (this.isAmbiguousSendError(e)) e.attestAmbiguousSend = true;
            throw e;
        }
    }
}

// The parts are installed NON-ENUMERABLE, like the class methods beside them. An
// assigned mixin would be the only prototype member for...in and Object.keys could
// see, and what a prototype enumerates is behaviour rather than layout (the reasoning
// src/db/index.js records for the same install). Writable and configurable stay true,
// so a test can still stub a moved method and put it back, and a name two parts both
// claim is loud at load instead of last-one-wins.
function installParts(target, parts){
    for(const part of parts){
        for(const name of Object.keys(part)){
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('AttestationPublisher: two parts define ' + name);
            Object.defineProperty(target, name,
                { value: part[name], writable: true, configurable: true, enumerable: false });
        }
    }
}

installParts(AttestationPublisher.prototype, [onFinalized, queue, markers, retention, responsible, sweep]);

module.exports = AttestationPublisher;
