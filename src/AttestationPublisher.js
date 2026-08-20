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
 *
 * Wire format (parsed by xchain-indexer/src/actions/attest.js):
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

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const swq           = require('./stake_weighted_quorum.js');
const bcmath        = require('./bcmath.js');
const axios         = require('axios');
const EncoderClient = require('./EncoderClient.js');
const SpendGuard    = require('./lib/spend_guard.js');
const { AtMostOnce, isAmbiguousSendError } = require('./lib/idempotent_broadcast.js');
const { forwardableUtxos } = require('./lib/encoder_utxo_forward.js');

const APPROX_BTC_BLOCK_MS  = 600000;  // ~10 min; used to translate the failover
                                      // window from blocks to a wall-clock silence
                                      // threshold that survives a restart.
const DEFAULT_FAILOVER_WINDOW_BLOCKS = 2;       // leader silence before rank-1 steps in
const DEFAULT_FAILOVER_POLL_MS       = 30000;   // sweep cadence
const DEFAULT_LEADER_RETRY_MS        = 60000;   // grace before the sweep retries a leader entry
                                                // (lets the happy-path live broadcast win)
const PENDING_PAGE_LIMIT             = 100;     // matches AttestationRound poll page size
const ATTEST_WIRE_MAX_BYTES          = 8189;    // must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js

// Default retention window for the durable attest_published_requests marker table,
// mirroring OraclePublisher's ~90-day oracle_published_rounds window.
const DEFAULT_PUBLISHED_RETENTION_MS = 7776000000;   // 90 days
// Multiple of the re-presentability horizon the effective window is FLOORED at.
// The horizon itself is governance-controlled (see _publishedRetentionFloorMs), so
// the safety multiple is what absorbs a hub whose indexer view lags the chain.
const PUBLISHED_RETENTION_DEADLINE_SAFETY = 4;
// Cap on how many queued request ids the prune DELETE will carry as an exclusion
// list. A queue this deep is a drain failure, not a retention problem; the sweep
// skips rather than building a pathological statement.
const PUBLISHED_RETENTION_QUEUE_MAX = 5000;

class AttestationPublisher {

    constructor(hub){
        this.hub      = hub;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        let cfg = hub.p2pConfig || {};
        this.queuePath = process.env.ATTESTATION_QUEUE_PATH || cfg.ATTESTATION_QUEUE_PATH || './data/attestation-queue.jsonl';

        // Operator kill switch. Mirrors StateAnchorPublisher's
        // ANCHOR_ENABLED gate. Halts outbound BTC spend (both the live path and the
        // failover sweep) during an incident without tearing down config. Default on.
        this.enabled = String(process.env.ATTEST_ENABLED || cfg.ATTEST_ENABLED || 'true') !== 'false';

        // Shared SpendGuard (supersedes the old per-publisher SpendCeiling).
        // Per-window spend ceiling (count + a $2000-clamped USD-cents budget, default-ON),
        // wallet balance floor, and a per-capability runtime pause. The pause folds into
        // allow(), which the live path AND the sweep both consult, so an operator can halt
        // this publisher's PRIMARY (leader) BTC spend at runtime.
        this.spendGuard = new SpendGuard('ATTEST', cfg, 'AttestationPublisher');

        // Count of durable-WAL enqueue failures. A non-zero value means a
        // finalized response could not be recorded before broadcast; surfaced via
        // getPublisherStats() so it is visible without log-grepping.
        this._enqueueFailures = 0;

        // Append-only, fsync'd audit log of ACTUAL on-chain spends (rid,
        // txid, ts). The WAL queue is a pre-send intent record that is REMOVED on
        // success, so post-success reconstruction otherwise depends on stdout retention;
        // this file is the durable record of what BTC fee was actually spent.
        this.spendLogPath = this.queuePath.replace(/\.jsonl$/, '') + '.spend.jsonl';

        // rid -> timestamp of the last AMBIGUOUS broadcast failure (a
        // timeout / reset / 5xx after the request left the wire, where the BTC node may
        // have actually accepted the tx). The sweep must NOT re-broadcast such an rid
        // until it has had time to reach the indexer's mined view (leaving the pending
        // set), or a second BTC fee is spent on a landed tx. Cleared once the rid drops
        // from the pending set (landed/expired) or the cooldown proves it never landed.
        this._ambiguousSends = new Map();

        // Failover / replay tuning
        this.failoverWindowBlocks = parseInt(process.env.ATTESTATION_FAILOVER_WINDOW_BLOCKS || cfg.ATTESTATION_FAILOVER_WINDOW_BLOCKS || DEFAULT_FAILOVER_WINDOW_BLOCKS);
        this.failoverPollMs       = parseInt(process.env.ATTESTATION_FAILOVER_POLL_MS       || cfg.ATTESTATION_FAILOVER_POLL_MS       || DEFAULT_FAILOVER_POLL_MS);
        this.leaderRetryMs        = parseInt(process.env.ATTESTATION_LEADER_RETRY_MS        || cfg.ATTESTATION_LEADER_RETRY_MS        || DEFAULT_LEADER_RETRY_MS);
        this.approxBlockMs        = parseInt(process.env.ATTESTATION_BLOCK_MS               || cfg.ATTESTATION_BLOCK_MS               || APPROX_BTC_BLOCK_MS);

        // How long after an ambiguous send the sweep defers re-broadcast,
        // giving a possibly-accepted tx time to reach the indexer's mined view before
        // we conclude it never landed. Defaults to one failover window.
        this.ambiguousCooldownMs  = parseInt(process.env.ATTESTATION_AMBIGUOUS_COOLDOWN_MS  || cfg.ATTESTATION_AMBIGUOUS_COOLDOWN_MS  || String(this.failoverWindowBlocks * this.approxBlockMs), 10);

        // Optional BTC encoder wiring (default pipeline). Mirrors OraclePublisher.
        let encoderUrl = process.env.BTC_ENCODER_URL || cfg.BTC_ENCODER_URL || '';
        let encoderKey = process.env.BTC_ENCODER_API_KEY || cfg.BTC_ENCODER_API_KEY || '';
        this.encoder   = encoderUrl ? new EncoderClient(encoderUrl, encoderKey) : null;
        this.btcAddress    = process.env.BTC_ADDRESS    || cfg.BTC_ADDRESS    || '';
        this.btcPubkeyHex  = process.env.BTC_PUBKEY_HEX || cfg.BTC_PUBKEY_HEX || '';

        // Operator-supplied hooks
        this.broadcastFn  = null;  // fn(wirePayload) → Promise<{txid}>
        this.walletSignFn = null;  // fn(psbtHex)     → Promise<txHex>

        this._sweepTimer = null;

        // Cumulative on-chain broadcast outcomes. Surfaced via getPublisherStats()
        // so operators can detect persistent broadcast failures without log-grepping.
        this._broadcastSucceeded = 0;
        this._broadcastFailed    = 0;

        // Request ids whose durable marker records an INTENT to broadcast
        // with no confirmation: the process died between recording intent and marking
        // the send done, so whether the BTC tx landed is unknown. Never auto-rebroadcast
        // (that is the second-fee spend the marker exists to prevent); surfaced at
        // startup by _hydratePublishedMarkers for an operator to verify and replay.
        this._quarantinedRequests = new Set();

        // In-process at-most-once guard. Request ids broadcast this process lifetime
        // are recorded here the instant broadcaster(...) succeeds. If the post-broadcast
        // queue rewrite fails (disk full, permissions, transient I/O), the just-published
        // entry stays on the durable queue file; without this set the next _processQueue
        // sweep would re-read and RE-BROADCAST it, spending a real BTC fee twice for the
        // same request. Consulted before every (re-)broadcast so a failed rewrite can
        // never become a duplicate on-chain ATTEST. Cleared once the durable queue is
        // confirmed rewritten (mirrors OraclePublisher._publishedRounds). In-process
        // only: the restart case is covered by the durable `attest_published_requests`
        // marker below, and only where a hub DB is wired; with no DB this
        // set is still the whole guard and a restart can replay.
        this._publishedRequests = new AtMostOnce();

        // Retention window for the durable attest_published_requests marker table.
        // One row lands per ATTEST v1 request forever, so the money-bearing broadcast
        // path grew a table (and, through _hydratePublishedMarkers, a per-restart
        // SELECT) without bound. Only CONFIRMED rows are ever pruned and only past the
        // re-presentability floor; see _prunePublishedRequests for both invariants.
        // 0 disables pruning; garbage or a negative value falls back to the default.
        this.publishedRequestsRetentionMs = parseInt(
            process.env.ATTEST_PUBLISHED_REQUESTS_RETENTION_MS ||
            cfg.ATTEST_PUBLISHED_REQUESTS_RETENTION_MS, 10);
        if (!Number.isFinite(this.publishedRequestsRetentionMs) || this.publishedRequestsRetentionMs < 0){
            this.publishedRequestsRetentionMs = DEFAULT_PUBLISHED_RETENTION_MS;
        }
        // Lifetime count of confirmed marker rows the retention sweep deleted, the
        // in-flight sweep handle (fire-and-forget on the sweep path, so this is what
        // makes it awaitable in tests), and whether a marker has been written since the
        // last sweep. The table only grows when this publisher spends, so a hub that
        // has published nothing since the last sweep has nothing to age out.
        this.publishedRequestsPruned = 0;
        this._retentionSweep         = null;
        this._markersAddedSinceSweep = false;

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
            console.warn('AttestationPublisher: queue file unwritable at ' + this.queuePath + ':', e);
        }

        if (this.hub.attestationConsensus){
            this.hub.attestationConsensus.on('request:finalized', (event) => {
                this.onRequestFinalized(event).catch(err => {
                    console.error('AttestationPublisher: onRequestFinalized error: ' + (err && err.message ? err.message : err));
                });
            });
        }

        // Load the durable at-most-once markers BEFORE the crash-replay
        // sweep below, or that first sweep is exactly the pass that re-broadcasts a
        // response the pre-crash process already sent.
        await this._hydratePublishedMarkers().catch(err =>
            console.error('AttestationPublisher: durable publish-marker hydration failed; the in-process guard is ' +
                          'the only cover this lifetime: ' + (err && err.message ? err.message : err)));

        // Crash recovery: replay any finalized responses that survived a restart
        // (a leader that crashed between the queue write and the broadcast).
        await this._processQueue().catch(err =>
            console.error('AttestationPublisher: startup replay error: ' + (err && err.message ? err.message : err)));

        // Ongoing failover sweep: retries failed leader broadcasts and lets
        // followers step in once the leader has been silent past the window.
        this._sweepTimer = setInterval(() => {
            this._processQueue().catch(err =>
                console.error('AttestationPublisher: sweep error: ' + (err && err.message ? err.message : err)));
        }, this.failoverPollMs);

        console.log('AttestationPublisher started (queue: ' + this.queuePath +
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
    }

    // Called when AttestationConsensus emits 'request:finalized'. Every node in
    // the responsible set receives this (only responsible nodes run consensus to
    // commit). Each persists the finalized payload to the durable queue; the
    // leader broadcasts immediately, followers wait for the failover sweep.
    async onRequestFinalized(event){
        if (!event || !event.requestId) return;
        // Kill switch: when disabled, do not WAL or broadcast. Skip rather
        // than queue-for-later so a disabled publisher does not build a backlog that
        // floods BTC broadcasts the moment it is re-enabled.
        if (!this.enabled){
            console.log('AttestationPublisher: disabled (ATTEST_ENABLED=false); skipping finalized response for ' +
                        String(event.requestId).substring(0,16) + '...');
            return;
        }
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if (!event.signatures || event.signatures.length === 0){
            console.warn('AttestationPublisher: no sigs in finalized event for ' + event.requestId.substring(0,16) + '...; skipping broadcast');
            return;
        }

        let rid     = String(event.requestId).toLowerCase();
        let payload = this.buildAttestationResponseWire({
            requestId:   event.requestId,
            providerId:  event.providerId,
            responseBody: event.responseBody,
            status:      event.status || 'ok',
            meta:        event.meta,
            signatures:  event.signatures
        });

        // Guard: the assembled wire string must fit the encoder's data-payload
        // ceiling, or createTx rejects it with a RangeError. Catching that downstream
        // is too late; the entry would already be on the durable WAL and the failover
        // sweep would retry the same oversized payload forever. Drop it loudly here so
        // the operator can shrink the provider's response body.
        let payloadBytes = Buffer.byteLength(payload, 'utf8');
        if (payloadBytes > ATTEST_WIRE_MAX_BYTES) {
            console.error('AttestationPublisher: ATTEST v1 wire for ' + rid.substring(0, 16) +
                '... is ' + payloadBytes + ' bytes, exceeds encoder limit of ' + ATTEST_WIRE_MAX_BYTES +
                '; dropping broadcast. Reduce the attestation response body size for this provider.');
            return;
        }

        // Non-ok responses (provider_error / no_quorum, Phase 4) are advisory
        // audit rows: the request STAYS pending on the indexer, so the sweep's
        // "still pending → not yet landed" replay guard cannot tell a landed
        // non-ok row from a lost one. To keep double-publication impossible,
        // only the LEADER handles a non-ok response (no follower WAL step-in),
        // and its queue entry carries the status so the sweep bounds retries.
        // Losing one advisory row to a leader crash is acceptable; the
        // deadline-expiry path remains the terminal backstop.
        let responseStatus = String(event.status || 'ok');

        // Recompute the responsible-set ordering so any node (not just the
        // leader) knows its rank for failover step-in. Persisted on the queue
        // entry so the ordering survives a restart without re-querying snapshots.
        let requestBlock = (event.request && event.request.block_index != null) ? Number(event.request.block_index) : null;
        // Normalize redundancy with the SAME rule the other two copies of the
        // responsible-set derivation use (AttestationRound._computeResponsibleSet,
        // the indexer's attest.js): Math.max(1, Number(redundancy) || 1). The prior
        // event.signatures.length fallback produced a responsible list of a
        // different LENGTH than consensus and the indexer derived whenever the
        // request carried no redundancy, so _myRank and the failover step-in
        // schedule ranked against a divergent ordering. Failover timing
        // only - the indexer's pending-set guard still prevents a double landing -
        // but wrong timing means multiple followers can step in early or the true
        // rank-1 late.
        let redundancy   = Math.max(1, Number(event.request && event.request.redundancy) || 1);
        // Provider id for the block-anchored stake floor. The event carries it
        // directly; the request row is the fallback for an event shaped by an older
        // publisher. Absent on both, _computeResponsible fails closed on the weighted
        // path rather than rank against a set the other two copies do not agree with.
        let eventProvider = (event.providerId != null) ? event.providerId
                          : ((event.request && event.request.provider_id != null) ? event.request.provider_id : null);
        let responsible  = (requestBlock != null) ? await this._computeResponsible(rid, requestBlock, redundancy, eventProvider) : null;
        let leaderPubkey = event.leaderPubkey ? String(event.leaderPubkey).toLowerCase()
                         : (responsible && responsible.length ? responsible[0] : null);

        let isLeader = (leaderPubkey && myPubkey && leaderPubkey === myPubkey);
        if (responseStatus !== 'ok' && !isLeader){
            // Advisory row; see the non-ok note above. No WAL, no step-in.
            return;
        }

        // Durable write-ahead log BEFORE the send attempt.
        // Gate the broadcast on a successful, fsync'd WAL write. The queue
        // is the durable record of an intent to spend a real BTC fee; if it cannot be
        // written (full disk, permissions, bad mount) we must NOT spend, or the fee is
        // spent with only stdout as its trace and crash recovery is disarmed for the
        // entry. A failed enqueue is fatal for this entry: skip the broadcast.
        let queued = this._enqueue({
            ts:           Date.now(),
            requestId:    event.requestId,
            wire:         payload,
            status:       responseStatus,
            requestBlock: requestBlock,
            responsible:  responsible || undefined,
            leaderPubkey: leaderPubkey || undefined
        });
        if (!queued){
            console.error('AttestationPublisher: durable enqueue FAILED for ' + rid.substring(0,16) +
                          '...; skipping broadcast (no BTC spend without a durable record). ' +
                          'Other responsible nodes that enqueued cover this response; the deadline-expiry ' +
                          'path is the terminal backstop. Fix the queue file writability now.');
            return;
        }

        if (!isLeader){
            // Followers persist and wait. If the leader stays silent, the
            // failover sweep promotes the next responsible validator in turn.
            console.log('AttestationPublisher: [FOLLOWER] persisted finalized response for ' + rid.substring(0,16) +
                        '...; will step in after ' + this.failoverWindowBlocks + ' silent block(s) if leader does not broadcast');
            return;
        }

        let broadcaster = this._getBroadcaster();
        if (!broadcaster){
            console.warn('AttestationPublisher: no broadcast hook configured for ' + rid.substring(0,16) + '...; entry queued for later replay');
            return;
        }
        // At-most-once guard: a re-finalized event for a request already broadcast
        // this process lifetime (whose prior dequeue rewrite failed, leaving it on the
        // durable queue) must not spend a second BTC fee. The stale queue entry is
        // dropped by the sweep's matching guard.
        if (this._publishedRequests.has(rid)){
            console.warn('AttestationPublisher: ' + rid.substring(0,16) + '... already broadcast this process lifetime; skipping duplicate live broadcast');
            return;
        }
        // The durable half of the same guard, which survives the restart
        // the in-process set does not. Read-only here; the matching intent write comes
        // after the spend reservation below. Either non-send answer leaves the entry on
        // the WAL for the sweep, whose matching gate drops it: the same disposition the
        // in-process check above already gives a duplicate.
        if (await this._durableSendGate(rid) !== 'send') return;
        // Per-window BTC spend ceiling. A tripped ceiling is not a
        // failure: leave the entry on the WAL so the sweep publishes it in a later
        // window; do not spend now.
        // RESERVE rather than allow(): every 'request:finalized' handler
        // runs detached (start() only .catch()es it), so several can be parked on the
        // await below at once. With a pure allow() they all read the same pre-send
        // budget and every one of them broadcasts, overshooting the window ceiling by
        // the concurrency with irreversible sends. The reservation consumes the budget
        // in this synchronous turn and is handed back only if the send never went out.
        let spendToken = this.spendGuard.reserve();
        if (!spendToken){
            console.warn(this.spendGuard.noteBlocked() + ' (' + rid.substring(0,16) + '...); entry retained on queue');
            return;
        }
        // The send is now committed to, so the intent is durable from here
        // and not one line earlier: everything above this point can still decline to
        // send, and an intent row for a never-sent request reads as a crash-mid-send.
        if (!await this._armPublishIntent(rid)){
            this.spendGuard.release(spendToken);
            return;
        }
        try {
            let result = await broadcaster(payload, event);
            console.log('AttestationPublisher: broadcast ' + rid.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
            this._broadcastSucceeded++;
            this.spendGuard.commit(spendToken);   // the reservation IS the recorded spend
            this._ambiguousSends.delete(rid);
            this._recordSpend(rid, result && result.txid, 'live');   // durable spend audit
            this._publishedRequests.mark(rid);
            await this._markPublished(rid, result && result.txid);   // restart-surviving marker
            this._removeFromQueue(new Set([rid]));
        } catch (e) {
            // The send did not go out, so it consumes no budget (the invariant the
            // old post-send record() gave us for free).
            this.spendGuard.release(spendToken);
            this._broadcastFailed++;
            // An ambiguous send may have reached the BTC node. Mark it so
            // the sweep defers re-broadcast (see _processQueue) instead of blindly
            // spending a second fee. Definitive pre-send errors leave no mark and retry
            // normally.
            if (this._isAmbiguousSendError(e) || (e && e.attestAmbiguousSend)){
                this._ambiguousSends.set(rid, Date.now());
                console.error('AttestationPublisher: AMBIGUOUS broadcast failure for %s... (tx may have reached the BTC node); sweep will defer re-broadcast for ~%ds before retrying:',
                              rid.substring(0,16), Math.ceil(this.ambiguousCooldownMs / 1000), e);
            } else {
                // Definitively no send, so withdraw the intent: leaving it
                // would quarantine an ordinary RPC rejection at the next restart.
                await this._clearPublishIntent(rid);
                console.error('AttestationPublisher: broadcast failed for %s... (will retry via sweep):', rid.substring(0,16), e);
            }
        }
    }

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
            console.error('AttestationPublisher: CRITICAL - failed to durably enqueue %s... to %s; broadcast will be SKIPPED to preserve no-spend-without-a-durable-record:',
                          String(entry.requestId).substring(0,16), this.queuePath, e);
            return false;
        }
    }

    // Append-only, fsync'd audit record of an ACTUAL on-chain spend.
    // Best-effort (never blocks or reverses a spend that already happened); its job
    // is post-incident reconstruction of what BTC fee was spent, independent of
    // stdout retention. The WAL queue entry is removed on success, so without this
    // there is no durable trace of a completed spend.
    _recordSpend(rid, txid, kind){
        let record = JSON.stringify({ ts: Date.now(), requestId: rid, txid: txid || null, kind: kind || 'live' }) + '\n';
        try {
            let fd = fs.openSync(this.spendLogPath, 'a');
            fs.writeSync(fd, record);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('AttestationPublisher: failed to write spend-audit record for %s... to %s:',
                          String(rid).substring(0,16), this.spendLogPath, e);
        }
    }

    // ----- Durable at-most-once marker (attest_published_requests) -----
    //
    // The WAL entry is removed only AFTER broadcaster() resolves and both in-process
    // guards die with the process, so a crash between an accepted send and the dequeue
    // leaves an entry the restart sweep cannot tell from a never-sent one: the request
    // is still in the indexer's PENDING set precisely because the tx has not been mined
    // yet. This table is the restart-surviving half of the guard, ported from
    // OraclePublisher's oracle_published_rounds. Resolved lazily off the hub so a
    // publisher constructed before the hub's DB is wired still sees it.
    _db(){ return (this.hub && this.hub.db) ? this.hub.db : null; }

    // Read the durable marker for a request, or null when none exists / no DB is wired.
    // Shape: { request_id, txid, sent_at }. A non-null sent_at is the authoritative
    // "already broadcast" signal (txid may legitimately be null when the broadcaster
    // returns none, so sent_at, not txid, gates re-broadcast). Throws on a DB error so
    // the caller can FAIL CLOSED rather than spend on an unproven request.
    async _getPublishedMarker(rid){
        let db = this._db();
        if (!db) return null;
        let rows = await db.doQuery(
            'SELECT request_id, txid, sent_at FROM attest_published_requests WHERE request_id = ?',
            [rid]
        );
        return (rows && rows.length > 0) ? rows[0] : null;
    }

    // Durably record broadcast INTENT before the send. Idempotent: an existing row
    // (intent or sent) is left untouched. Throws on a DB error so the caller fails
    // closed. No-op when no DB is wired.
    async _recordPublishIntent(rid){
        let db = this._db();
        if (!db) return;
        await db.doQuery(
            'INSERT INTO attest_published_requests (request_id) VALUES (?) ' +
            'ON DUPLICATE KEY UPDATE request_id = request_id',
            [rid]
        );
    }

    // Durably record that the broadcast COMPLETED (sets sent_at + txid). Logged, never
    // thrown: the BTC fee is already spent, and the surviving intent-only row makes a
    // restart QUARANTINE the request instead of re-broadcasting it, which is the
    // fail-safe direction. No-op when no DB is wired.
    async _markPublished(rid, txid){
        let db = this._db();
        if (!db) return;
        try {
            await db.doQuery(
                'UPDATE attest_published_requests SET txid = ?, sent_at = NOW() WHERE request_id = ?',
                [txid || null, rid]
            );
            // The table just grew by one confirmed row, which is the only thing the
            // retention sweep has to age out; arm it for the next sweep pass.
            this._markersAddedSinceSweep = true;
        } catch (e) {
            console.error('AttestationPublisher: broadcast for %s... succeeded but its ' +
                'durable sent marker could not be persisted; a restart will QUARANTINE (not re-broadcast) this request. ' +
                'Operator: confirm the txid on-chain. Error:', String(rid).substring(0,16), e);
        }
    }

    // Startup reconciliation. Loads every confirmed (sent_at set) request into the
    // in-process guard so a queued-but-already-published response is never re-broadcast
    // after a restart, and QUARANTINES every intent-only row. Best-effort: a DB error is
    // logged and startup continues, leaving the in-process guard as the only cover for
    // this process lifetime (the behavior before this marker existed, never worse).
    async _hydratePublishedMarkers(){
        let db = this._db();
        if (!db) return;
        let rows = await db.doQuery('SELECT request_id, sent_at FROM attest_published_requests', []);
        let quarantined = [];
        for (let r of (rows || [])){
            let rid = String(r.request_id).toLowerCase();
            if (r.sent_at !== null && r.sent_at !== undefined){
                this._publishedRequests.mark(rid);
            } else {
                this._quarantinedRequests.add(rid);
                quarantined.push(rid.substring(0,16) + '...');
            }
        }
        if (quarantined.length > 0){
            console.error('AttestationPublisher: ' + quarantined.length + ' request(s) have a publish-intent marker ' +
                'with no confirmation (' + quarantined.join(', ') + '); their on-chain state is unknown after a crash. ' +
                'They will NOT be re-broadcast automatically (fail closed). Operator: verify each on-chain and replay ' +
                'manually if absent.');
        }
    }

    // Withdraw an intent row for a send that DEFINITIVELY never went out (a pre-send
    // broadcaster rejection). Without this the routine failure becomes a permanent
    // quarantine on the next restart, which is worse than the replay risk the marker
    // exists to remove. Scoped `AND sent_at IS NULL` so a confirmed marker can never be
    // deleted by a late/misordered call. Logged, never thrown: leaving the row is the
    // fail-closed direction, so a failure here only costs an operator replay.
    async _clearPublishIntent(rid){
        let db = this._db();
        if (!db) return;
        try {
            await db.doQuery(
                'DELETE FROM attest_published_requests WHERE request_id = ? AND sent_at IS NULL',
                [rid]
            );
        } catch (e) {
            console.error('AttestationPublisher: could not withdraw the publish-intent marker for %s... ' +
                'after a definitive send failure; a restart will QUARANTINE it ' +
                'and it will need an operator replay. Error:', String(rid).substring(0,16), e);
        }
    }

    // Longest wall-clock window in which a CONFIRMED marker can still change a
    // decision, derived from live governance rather than from a baked constant.
    //
    // A confirmed marker is only ever read through _durableSendGate, and that gate is
    // reachable from exactly two places: onRequestFinalized (an AttestationConsensus
    // finalization, which only fires for a request the consensus polled out of the
    // indexer's PENDING set) and the replay sweep (which reaches the gate only past
    // `pendingIds.has(rid)`). So a request whose marker no longer matters is precisely
    // one that can no longer be PENDING, and the indexer expires a request at its
    // deadline_block, at most `deadline_window_blocks` BTC blocks after the request
    // landed (xchain-indexer providerRegistry.isDeadlineAllowed).
    //
    // That window is governance-controlled JSON, so it is re-derived here through
    // ProviderRegistry.maxDeadlineWindowBlocks() the way AttestationConsensus
    // .checkNonOkSizingFloor does, never from the 100-block http_get figure in any
    // comment. Unlike that check this one is a HARD CLAMP, not a warning: an
    // undersized ring only wastes a fee, while a marker pruned too early lets the very
    // next finalization spend a SECOND fee for a response already on-chain.
    //
    // Returns 0 when no registry or no usable window is available, in which case the
    // caller falls back to the queue exclusion plus the configured window alone.
    _publishedRetentionFloorMs(){
        let registry = (this.hub && this.hub.providerRegistry) ? this.hub.providerRegistry : null;
        if (!registry || typeof registry.maxDeadlineWindowBlocks !== 'function') return 0;
        let max = registry.maxDeadlineWindowBlocks();
        let blocks = Number(max && max.blocks);
        if (!Number.isFinite(blocks) || blocks <= 0) return 0;
        return blocks * this.approxBlockMs * PUBLISHED_RETENTION_DEADLINE_SAFETY;
    }

    // Bound the durable attest_published_requests marker table to the retention
    // window. Without this the table appends one row per paid ATTEST request forever,
    // and _hydratePublishedMarkers re-reads all of it into memory on every restart.
    //
    // Three invariants dominate this DELETE, all load-bearing on a path that spends
    // real BTC:
    //
    //   1. `sent_at IS NOT NULL` is mandatory. A sent_at NULL row is an intent-only
    //      QUARANTINE marker for a request whose on-chain state is unknown after a
    //      crash; _hydratePublishedMarkers turns it into a permanent operator-only
    //      hold. Pruning one would erase the sole record that the request needs
    //      hand-verification, and the next finalization would broadcast it again.
    //   2. No request still on the durable WAL may be pruned, the exact analogue of
    //      OraclePublisher's queue-file clamp. The rid is a string rather than an
    //      orderable round, so the queue is excluded by identity instead of by a
    //      cutoff clamp, which is tighter than a clamp rather than looser.
    //   3. The window is floored at the re-presentability horizon
    //      (_publishedRetentionFloorMs), so a configured window shorter than the
    //      longest provider deadline cannot delete a marker a live path can still
    //      reach.
    //
    // Returns the number of rows deleted. Throws on a DB error; the caller decides
    // (the sweep path treats a retention failure as non-fatal).
    async _prunePublishedRequests(){
        let db = this._db();
        if (!db) return 0;
        if (!this.publishedRequestsRetentionMs || this.publishedRequestsRetentionMs <= 0) return 0;

        let windowMs = Math.max(this.publishedRequestsRetentionMs, this._publishedRetentionFloorMs());

        // Invariant 2. Best-effort read; an unreadable queue returns [] and the window
        // applies on its own (an unreadable queue file is already loud elsewhere).
        let queued = [];
        for (let entry of this._readQueue()){
            let rid = String(entry && entry.requestId || '').toLowerCase();
            if (rid) queued.push(rid);
        }
        if (queued.length > PUBLISHED_RETENTION_QUEUE_MAX){
            console.warn('AttestationPublisher: skipping the published-requests retention sweep; ' +
                queued.length + ' entries are still on the durable queue at ' + this.queuePath +
                ' (over the ' + PUBLISHED_RETENTION_QUEUE_MAX + ' exclusion cap). The queue is not draining; ' +
                'fix that first, retention is the lesser problem.');
            return 0;
        }

        // Seconds, and DB-clock arithmetic on both sides: sent_at is written by NOW(),
        // so comparing it against a Node-side timestamp would fold any host/DB clock
        // skew straight into the cutoff.
        let windowSec = Math.ceil(windowMs / 1000);
        let sql = 'DELETE FROM attest_published_requests ' +
                  'WHERE sent_at IS NOT NULL AND sent_at < DATE_SUB(NOW(), INTERVAL ? SECOND)';
        let params = [windowSec];
        if (queued.length > 0){
            sql += ' AND request_id NOT IN (' + queued.map(() => '?').join(',') + ')';
            params = params.concat(queued);
        }

        let result  = await db.doQuery(sql, params);
        let deleted = (result && result.affectedRows) ? Number(result.affectedRows) : 0;
        if (deleted > 0){
            this.publishedRequestsPruned += deleted;
            console.log('AttestationPublisher: published-requests retention pruned ' + deleted +
                ' confirmed marker row(s) older than ' + windowSec + 's (quarantined intent-only rows and ' +
                'anything still on the durable queue are never pruned)');
        }
        return deleted;
    }

    // Housekeeping hook for the retention sweep. Fire-and-forget with the rejection
    // swallowed: bounding the marker table must never stall, fail or retry a broadcast
    // pass that has already spent BTC. Skipped when the publisher is disabled (a paused
    // publisher touches nothing) and when nothing has been published since the last
    // sweep, since the table only grows when this hub spends.
    _sweepPublishedRequestRetention(){
        if (!this.enabled || !this._markersAddedSinceSweep) return;
        if (!this._db() || !this.publishedRequestsRetentionMs) return;
        this._markersAddedSinceSweep = false;
        this._retentionSweep = this._prunePublishedRequests()
            .catch((e) => {
                console.warn('AttestationPublisher: published-requests retention sweep failed ' +
                    '(the marker table keeps growing until it succeeds): ', e);
                return 0;
            });
    }

    // Consult the durable marker before spending a BTC fee. READ-ONLY: it writes no
    // intent, because the caller may still decline to send after it
    // and an intent row for a request that was never sent is indistinguishable from a
    // crash-mid-send, so a restart would quarantine a perfectly replayable request.
    // Intent is armed by _armPublishIntent once the send is actually committed to.
    // Returns one of:
    //   'send'  - no marker, or intent-only from THIS process; proceed
    //   'sent'  - already broadcast (durable sent marker, or quarantined); drop, do not send
    //   'defer' - the marker could not be read; fail closed, leave the entry queued and
    //             retry on a later sweep
    // Marking the in-process guard on a 'sent' answer keeps the rest of the pass
    // consistent with a same-process duplicate.
    async _durableSendGate(rid){
        if (this._quarantinedRequests.has(rid)){
            console.warn('AttestationPublisher: ' + rid.substring(0,16) + '... is quarantined (publish intent recorded ' +
                'before a crash, on-chain state unknown); not re-broadcasting, awaiting operator replay');
            return 'sent';
        }
        if (!this._db()) return 'send';
        let marker;
        try {
            marker = await this._getPublishedMarker(rid);
        } catch (e) {
            console.error('AttestationPublisher: cannot read the durable publish marker for %s...; deferring broadcast (fail closed to avoid a duplicate BTC spend):',
                rid.substring(0,16), e);
            return 'defer';
        }
        if (marker && marker.sent_at !== null && marker.sent_at !== undefined){
            console.warn('AttestationPublisher: ' + rid.substring(0,16) + '... has a durable sent marker (txid ' +
                (marker.txid || '<none>') + '); not re-broadcasting');
            this._publishedRequests.mark(rid);
            return 'sent';
        }
        return 'send';
    }

    // Arm the durable intent immediately before the broadcast, and ONLY once every
    // remaining no-send exit is behind us (the spend reservation in particular: a
    // ceiling trip is a designed, routine state whose entry stays queued for a later
    // window, and an intent row would turn that into a quarantine). Returns false when
    // the intent cannot be persisted, which is a fail-closed defer: the caller hands the
    // reservation back and leaves the entry queued rather than spending a fee it could
    // not record.
    async _armPublishIntent(rid){
        try {
            await this._recordPublishIntent(rid);
            return true;
        } catch (e) {
            console.error('AttestationPublisher: cannot record durable publish intent for %s...; deferring broadcast (fail closed):',
                rid.substring(0,16), e);
            return false;
        }
    }

    // Classify a broadcast failure (delegates to the shared classifier so
    // all four hub effectors answer "could this send have landed?" identically).
    _isAmbiguousSendError(e){
        return isAmbiguousSendError(e);
    }

    _readQueue(){
        try {
            let raw = fs.readFileSync(this.queuePath, 'utf8');
            return raw.split('\n').filter(line => line.trim().length > 0).map(line => {
                try { return JSON.parse(line); } catch (e) { return null; }
            }).filter(e => e && e.requestId && e.wire);
        } catch (e) {
            return [];
        }
    }

    // Truncate-and-rewrite the durable queue. Returns true on a confirmed fsync'd
    // write, false on failure, so the dequeue path can tell whether a just-published
    // entry is still on disk (mirrors OraclePublisher._rewriteQueue).
    _rewriteQueue(entries){
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.queuePath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            return true;
        } catch (e) {
            console.error('AttestationPublisher: failed to rewrite queue:', e);
            return false;
        }
    }

    // Remove the given request IDs from the queue. Re-reads the queue fresh so a
    // concurrently-appended entry (from a live onRequestFinalized that fired
    // mid-sweep) is never clobbered. Returns the rewrite outcome so the at-most-once
    // guard is only reset when the durable queue is proven to no longer hold any
    // published entry.
    _removeFromQueue(dropSet){
        if (!dropSet || dropSet.size === 0) return true;
        let remaining = this._readQueue().filter(e => !dropSet.has(String(e.requestId).toLowerCase()));
        let rewritten = this._rewriteQueue(remaining);
        if (rewritten){
            // The durable queue now equals `remaining`, which holds no just-dropped
            // (published) request, so no published entry can still be on disk and the
            // dedup guard can be reset to bound its growth.
            this._publishedRequests.clear();
        } else {
            console.error('AttestationPublisher: CRITICAL - queue rewrite failed after broadcast; ' +
                'published entries remain on the durable queue at ' + this.queuePath + '. The in-process ' +
                'dedup guard prevents re-broadcast for this process lifetime, but a restart before the ' +
                'queue file is repaired would re-broadcast already-landed attestations (duplicate BTC fee spend). ' +
                'Fix the queue file writability now.');
        }
        return rewritten;
    }

    // Choose the active broadcaster, or null when none is configured.
    _getBroadcaster(){
        if (this.broadcastFn) return (payload, ev) => this.broadcastFn(payload, ev);
        if (this.encoder && this.walletSignFn && this.btcAddress && this.btcPubkeyHex){
            return (payload) => this._defaultBroadcast(payload);
        }
        return null;
    }

    // This node's rank in the request's responsible set: 0 = leader, ≥1 = follower
    // (step-in order). Returns null if this node holds no identity / isn't listed.
    _myRank(entry){
        let myPubkey = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        if (!myPubkey) return null;
        if (Array.isArray(entry.responsible) && entry.responsible.length){
            let ordered = entry.responsible.map(p => String(p).toLowerCase());
            let idx = ordered.indexOf(myPubkey);
            if (idx < 0) return null;
            // The consensus leader ROTATES down the hash order when earlier
            // slots go silent (attestation_escalation.js), so the round's
            // actual broadcaster may not be hash-slot 0. Rank relative to the
            // recorded round leader, or the hash-slot-0 hub would fast-retry
            // (leaderRetryMs) a response the real leader already broadcast
            // that merely hasn't confirmed into a block yet.
            let leaderIdx = entry.leaderPubkey ? ordered.indexOf(String(entry.leaderPubkey).toLowerCase()) : 0;
            if (leaderIdx < 0) leaderIdx = 0;
            return (idx - leaderIdx + ordered.length) % ordered.length;
        }
        // Fallback when the responsible ordering couldn't be computed: treat the
        // recorded leader as rank 0 and ourselves as the sole follower (rank 1).
        if (entry.leaderPubkey){
            return String(entry.leaderPubkey).toLowerCase() === myPubkey ? 0 : 1;
        }
        return 0;
    }

    // Recompute the deterministic responsible-set ordering for a request, exactly
    // as AttestationRound does: sort the qualifying `attestation` validators at
    // the request's block boundary by SHA256(request_id || pubkey) ascending,
    // take the top `redundancy`. responsible[0] is the leader. Returns an array
    // of lowercase pubkeys, or null when the snapshot is unavailable.
    //
    // STAKE_WEIGHTED_QUORUM: when active at blockIndex, resolve the SOURCE-keyed
    // weight snapshot and dedupe by staking source so a source's delegated keys
    // cannot occupy multiple responsible slots (mirrors AttestationRound._computeResponsibleSet).
    // CONSENSUS-CRITICAL: this is the THIRD copy of the responsible-set rule;
    // it must stay byte-for-byte in sync with
    // AttestationRound._computeResponsibleSet and the indexer's attest.js,
    // including the caller's Math.max(1, Number(redundancy) || 1) normalization.
    // A silent change to any one copy is a fork surface; update all three together.
    //
    // PROVIDER STAKE FLOOR (weighted only): sources below the request
    // provider's block-anchored min_stake_xchain are dropped before the ranking, the
    // same filter AttestationRound._computeResponsibleSet applies. This ordering only
    // drives failover step-in timing, but ranking against a set the other copies do
    // not agree with means followers step in early or the true rank-1 steps in late,
    // so it tracks them exactly. An unresolvable floor returns null (rank unknown),
    // which the caller already handles as "snapshot unavailable".
    async _computeResponsible(rid, blockIndex, redundancy, providerId){
        try {
            if (!this.hub.capabilitySnapshot) return null;
            let weighted = swq.isStakeWeightedQuorumActive(blockIndex, this.hub.network);
            let snapshot = weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('attestation', blockIndex)
                : await this.hub.capabilitySnapshot.getSnapshot('attestation', blockIndex);
            if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
            let validators = snapshot.validators;
            if (weighted) {
                let registry = this.hub.providerRegistry || null;
                let floor = (registry && providerId != null)
                    ? registry.getMinStake(String(providerId), blockIndex) : null;
                if (floor === null) return null;
                validators = validators.filter(v => this._meetsProviderFloor(v && v.weight, floor));
                if (validators.length === 0) return null;
            }
            let withHash = validators.map(v => {
                let pk = String(v.pubkey).toLowerCase();
                let h  = crypto.createHash('sha256').update(rid, 'utf8').update(pk, 'utf8').digest('hex');
                return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
            });
            withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
            if (weighted) {
                let seen = new Set();
                withHash = withHash.filter(v => {
                    if (v.source === null) return true;   // no source info: keep (defensive)
                    if (seen.has(v.source)) return false; // source already represented
                    seen.add(v.source);
                    return true;
                });
            }
            return withHash.slice(0, Math.max(1, redundancy)).map(x => x.pubkey);
        } catch (e) {
            return null;
        }
    }

    // Byte-mirror of AttestationRound._meetsProviderFloor (and of the indexer's
    // providerMinStakeHistory.meetsProviderFloor). Strict decimal-string acceptance
    // plus decimal.js `.gte()`; an unusable weight or floor excludes the row. Kept as
    // its own method rather than imported so all copies of the responsible-set rule
    // read alike side by side in their own file.
    _meetsProviderFloor(weight, minStake){
        const usable = (v) => {
            if (v === null || v === undefined || typeof v === 'boolean') return null;
            let s = String(v).trim();
            return /^\d+(\.\d+)?$/.test(s) ? s : null;
        };
        let floor = usable(minStake);
        if (floor === null) return false;
        let w = usable(weight);
        if (w === null) return false;
        return bcmath.bcgte(w, floor);
    }

    // ----- Failover / replay sweep -----

    // Re-broadcast any queued finalized response whose request is still pending.
    // Run once at startup (crash replay) and on an interval (failover + leader retry).
    //
    // Sweep self-overlap guard (house convention: FullNodeChallengeRound._tick).
    // The sweep is a bare setInterval at 30s while one pass pages the indexer's whole
    // pending set (5s per page) and then awaits a real BTC broadcast per eligible entry,
    // so a slow indexer or a slow node lets the next interval fire on top of this one.
    // Both passes read the same queue FILE, and every gate that would stop the second
    // one is read before the first arms it: _publishedRequests.mark(rid) lands only
    // after broadcaster() resolves, pendingIds still lists the request because nothing
    // has been mined, and _removeFromQueue runs at the very end. So two overlapping
    // sweeps re-broadcast the SAME finalized response, spending the BTC fee twice for a
    // duplicate on-chain ATTEST response, which is exactly the double-spend the
    // at-most-once set and the ambiguous-send cooldown exist to prevent. The guard is a
    // wrapper rather than inline so the finally cannot be skipped by any of the body's
    // early returns; a rejected _fetchPendingRequestIds must not wedge the sweep, since
    // only this timer ever drains the WAL.
    async _processQueue(){
        if (this._sweeping){
            console.warn('AttestationPublisher: queue sweep still in flight; skipping this pass');
            return;
        }
        this._sweeping = true;
        try {
            return await this._processQueueInner();
        } finally {
            this._sweeping = false;
            // Marker-table retention, not part of the broadcast pass. It runs from the
            // finally so every early return above it is covered (a live-path publish
            // leaves an EMPTY queue, and the inner pass returns before its body on an
            // empty queue), and after the overlap guard releases so a slow DELETE can
            // never make the next tick think a sweep is still in flight.
            this._sweepPublishedRequestRetention();
        }
    }

    async _processQueueInner(){
        // Kill switch: suppress the failover/replay sweep too, not just the
        // live path, or a paused publisher would still drain the queue and spend BTC.
        // Entries stay on the durable WAL untouched and resume only when re-enabled.
        if (!this.enabled){
            console.log('AttestationPublisher: disabled (ATTEST_ENABLED=false); skipping queue sweep');
            return;
        }

        let entries = this._readQueue();
        if (entries.length === 0) return;

        // Authoritative double-broadcast guard: any request no longer in the
        // indexer's pending set has already landed on-chain (or expired past its
        // deadline) and must not be re-broadcast.
        let pendingIds = await this._fetchPendingRequestIds();
        if (pendingIds === null){
            // Indexer unreachable; we can't tell which entries already landed,
            // so we defer rather than risk a double-broadcast. Retried next sweep.
            console.warn('AttestationPublisher: indexer unreachable; deferring queue replay (' + entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') + ' retained)');
            return;
        }

        let broadcaster = this._getBroadcaster();
        let now  = Date.now();
        let drop = new Set();     // request IDs to remove (landed/expired or re-broadcast)
        let replayed = 0;

        for (let entry of entries){
            let rid = String(entry.requestId).toLowerCase();

            // At-most-once guard: if this request was already broadcast this process
            // lifetime, it is only still on the queue because a prior tick's rewrite
            // failed to truncate it. Re-broadcasting would spend a BTC fee twice, so
            // drop the stale entry without re-sending (mirrors OraclePublisher).
            if (this._publishedRequests.has(rid)){
                console.warn('AttestationPublisher: ' + rid.substring(0,16) + '... already broadcast this process lifetime; dropping stale queue entry without re-broadcast (a prior queue rewrite must have failed)');
                drop.add(rid);
                continue;
            }

            if (!pendingIds.has(rid)){
                // Already resolved on-chain; clear it out. This also settles an
                // ambiguous send: the tx landed and left the pending set,
                // so drop it and forget the ambiguous mark rather than re-broadcasting.
                drop.add(rid);
                this._ambiguousSends.delete(rid);
                continue;
            }

            // Non-ok entries (Phase 4 advisory rows) leave the request pending
            // BY DESIGN, so "still pending" proves nothing about whether the
            // row landed. Retry only briefly (crash recovery / transient
            // encoder failure), then drop rather than risk duplicate audit
            // rows; the deadline-expiry path is the terminal backstop.
            let entryStatus = String(entry.status || 'ok');
            let age0 = now - (Number(entry.ts) || 0);
            if (entryStatus !== 'ok' && age0 > this.failoverWindowBlocks * this.approxBlockMs){
                drop.add(rid);
                continue;
            }

            let rank = this._myRank(entry);
            if (rank === null) continue;  // not our responsibility; leave it

            // Eligibility: the leader entry is only retried after a short grace
            // (so the live broadcast wins the happy path and a crash-surviving
            // entry, whose ts is already old; replays at once). A follower at
            // rank r steps in only after r failover windows of leader silence.
            let age = now - (Number(entry.ts) || 0);
            let eligible = (rank === 0)
                ? (age >= this.leaderRetryMs)
                : (age >= rank * this.failoverWindowBlocks * this.approxBlockMs);
            if (!eligible) continue;

            // Defer re-broadcast of a request whose prior send failed
            // AMBIGUOUSLY until it has had time to reach the indexer's mined view. It
            // is still pending here, but "pending" cannot distinguish a never-sent tx
            // from a landed-but-unmined one (the exact double-spend window). If the
            // cooldown has elapsed and it is STILL pending, it genuinely did not land,
            // so clear the mark and allow a safe re-broadcast.
            let ambTs = this._ambiguousSends.get(rid);
            if (ambTs !== undefined){
                if ((now - ambTs) < this.ambiguousCooldownMs){
                    console.warn('AttestationPublisher: ' + rid.substring(0,16) + '... had an ambiguous send ~' +
                                 Math.round((now - ambTs) / 1000) + 's ago; deferring re-broadcast to avoid a double spend');
                    continue;
                }
                this._ambiguousSends.delete(rid);   // cooldown passed + still pending => safe to resend
            }

            if (!broadcaster){
                console.warn('AttestationPublisher: no broadcast pipeline configured; ' + rid.substring(0,16) + '... retained for later replay');
                continue;
            }

            // The guard the pending-set check above cannot give us. A
            // response the PREVIOUS process broadcast is still pending here (accepted
            // but unmined), and both in-process guards died with that process, so
            // without a durable marker this sweep pays a second BTC fee for it.
            let gate = await this._durableSendGate(rid);
            if (gate === 'sent'){ drop.add(rid); continue; }
            if (gate === 'defer') continue;   // retained, retried on a later sweep

            // Per-window BTC spend ceiling. When exhausted, retain the
            // entry (no spend) for a later window rather than re-broadcasting now.
            // Reserve before the await for the same reason the live path
            // does: this loop awaits a real broadcast per entry, so a live
            // onRequestFinalized firing mid-await would otherwise pass the very same
            // allow() this pass already passed.
            let spendToken = this.spendGuard.reserve();
            if (!spendToken){
                console.warn(this.spendGuard.noteBlocked() + ' (' + rid.substring(0,16) + '...); entry retained on queue');
                continue;
            }
            // Intent goes durable only here, past every no-send exit above
            // (the ceiling trip especially: it retains the entry for a later window, and
            // an intent row would make that later window quarantine it instead).
            if (!await this._armPublishIntent(rid)){
                this.spendGuard.release(spendToken);
                continue;   // retained, retried on a later sweep
            }

            try {
                let result = await broadcaster(entry.wire, { requestId: entry.requestId });
                // Arm the at-most-once guard the instant the fee is spent, so a failed
                // dequeue rewrite below cannot let the next sweep re-broadcast this rid.
                this._publishedRequests.mark(rid);
                this.spendGuard.commit(spendToken);   // the reservation IS the recorded spend
                this._ambiguousSends.delete(rid);
                await this._markPublished(rid, result && result.txid);   // restart-surviving marker
                this._recordSpend(rid, result && result.txid, rank === 0 ? 'sweep-leader' : 'sweep-stepin');
                replayed++;
                drop.add(rid);
                console.log('AttestationPublisher: ' + (rank === 0 ? 're-broadcast leader' : 'stepped in (rank ' + rank + ')') +
                            ' for ' + rid.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
            } catch (e) {
                // The send did not go out, so it consumes no budget.
                this.spendGuard.release(spendToken);
                // Mark an ambiguous replay failure so the NEXT sweep defers
                // rather than immediately re-broadcasting a possibly-landed tx.
                if (this._isAmbiguousSendError(e) || (e && e.attestAmbiguousSend)){
                    this._ambiguousSends.set(rid, Date.now());
                    console.error('AttestationPublisher: AMBIGUOUS replay failure for ' + rid.substring(0,16) +
                                  '... (tx may have reached the BTC node); deferring re-broadcast: ', e);
                } else {
                    // Definitively no send; withdraw the intent so the retry
                    // this line promises is not cancelled by a quarantine after a restart.
                    await this._clearPublishIntent(rid);
                    console.error('AttestationPublisher: replay broadcast failed for ' + rid.substring(0,16) + '... (will retry): ', e);
                }
                // keep; not added to drop
            }
        }

        if (drop.size > 0) this._removeFromQueue(drop);
        if (replayed > 0) console.log('AttestationPublisher: replay/failover re-broadcast ' + replayed + ' finalized response(s)');
    }

    // Sweep the indexer's pending attestation_requests into a Set of request IDs.
    // Returns null on any failure (indexer unreachable / error) so callers can
    // distinguish "nothing pending" (empty Set) from "couldn't determine".
    async _fetchPendingRequestIds(){
        let url = await this._resolveBtcIndexerUrl();
        if (!url) return null;

        let ids = new Set();
        let cursor = null;
        // Page through the full pending queue. Bounded by a generous page cap so a
        // pathological indexer response can't spin forever.
        for (let page = 0; page < 10000; page++){
            let params = { limit: PENDING_PAGE_LIMIT };
            if (cursor){
                params.after_block_index  = cursor.block_index;
                params.after_action_index = cursor.action_index;
            }
            let res;
            try {
                res = await axios.post(url, {
                    jsonrpc: '2.0', id: Date.now(),
                    method:  'getpendingattestation_requests',
                    params:  params
                }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
            } catch (e) {
                console.warn('AttestationPublisher: pending-request fetch failed:', (e && e.message ? e.message : e));
                return null;
            }
            let result = res && res.data && res.data.result;
            if (!result || result.error) return null;
            let requests = result.requests || [];
            for (let r of requests){
                let rid = String(r.request_id || '').toLowerCase();
                if (rid) ids.add(rid);
            }
            if (requests.length < PENDING_PAGE_LIMIT) break;
            let last = requests[requests.length - 1];
            cursor = { block_index: Number(last.block_index), action_index: Number(last.action_index) };
        }
        return ids;
    }

    async _resolveBtcIndexerUrl(){
        if (typeof this.hub._resolveBtcIndexerUrl === 'function'){
            return await this.hub._resolveBtcIndexerUrl();
        }
        return null;
    }

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
        let txHex = await this.walletSignFn(psbtResult.psbt);
        if (!txHex || typeof txHex !== 'string') throw new Error('wallet sign hook returned invalid tx hex');
        // Everything above is pre-send (build/sign; no money moved). Only broadcast_tx
        // has a side effect, so only ITS failures are classified for ambiguity.
        try {
            return await this.encoder.broadcastTx(txHex);
        } catch (e) {
            if (this._isAmbiguousSendError(e)) e.attestAmbiguousSend = true;
            throw e;
        }
    }
}

module.exports = AttestationPublisher;
