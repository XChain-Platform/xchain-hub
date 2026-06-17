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
 *   - The indexer's pending-request set is the authoritative double-broadcast
 *     guard: an entry whose request is no longer pending has already landed
 *     on-chain (or expired) and is dropped without re-broadcast.
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
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md (§5.2, §9)
 *
 ********************************************************************/

const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');
const swq           = require('./stake_weighted_quorum.js');
const axios         = require('axios');
const EncoderClient = require('./EncoderClient.js');

const APPROX_BTC_BLOCK_MS  = 600000;  // ~10 min; used to translate the failover
                                      // window from blocks to a wall-clock silence
                                      // threshold that survives a restart.
const DEFAULT_FAILOVER_WINDOW_BLOCKS = 2;       // leader silence before rank-1 steps in
const DEFAULT_FAILOVER_POLL_MS       = 30000;   // sweep cadence
const DEFAULT_LEADER_RETRY_MS        = 60000;   // grace before the sweep retries a leader entry
                                                // (lets the happy-path live broadcast win)
const PENDING_PAGE_LIMIT             = 100;     // matches AttestationRound poll page size
const ATTEST_WIRE_MAX_BYTES          = 8189;    // must equal MAX_DATA_BYTES in xchain-encoder/src/validator.js

class AttestationPublisher {

    constructor(hub){
        this.hub      = hub;
        this.identity = hub.getIdentity ? hub.getIdentity() : null;

        let cfg = hub.p2pConfig || {};
        this.queuePath = process.env.ATTESTATION_QUEUE_PATH || cfg.ATTESTATION_QUEUE_PATH || './data/attestation-queue.jsonl';

        // Failover / replay tuning
        this.failoverWindowBlocks = parseInt(process.env.ATTESTATION_FAILOVER_WINDOW_BLOCKS || cfg.ATTESTATION_FAILOVER_WINDOW_BLOCKS || DEFAULT_FAILOVER_WINDOW_BLOCKS);
        this.failoverPollMs       = parseInt(process.env.ATTESTATION_FAILOVER_POLL_MS       || cfg.ATTESTATION_FAILOVER_POLL_MS       || DEFAULT_FAILOVER_POLL_MS);
        this.leaderRetryMs        = parseInt(process.env.ATTESTATION_LEADER_RETRY_MS        || cfg.ATTESTATION_LEADER_RETRY_MS        || DEFAULT_LEADER_RETRY_MS);
        this.approxBlockMs        = parseInt(process.env.ATTESTATION_BLOCK_MS               || cfg.ATTESTATION_BLOCK_MS               || APPROX_BTC_BLOCK_MS);

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
    }

    setBroadcastHook(fn){ this.broadcastFn  = fn; }
    setWalletSignHook(fn){ this.walletSignFn = fn; }
    setEncoder(encoder){ this.encoder = encoder; }

    async start(){
        // Ensure the queue exists. The queue is load-bearing: it is the durable
        // write-ahead log that lets a finalized response survive a leader crash
        // and lets followers step in if the leader goes silent.
        try {
            fs.mkdirSync(path.dirname(this.queuePath), { recursive: true });
            if (!fs.existsSync(this.queuePath)) fs.writeFileSync(this.queuePath, '');
        } catch (e) {
            console.warn('AttestationPublisher: queue file unwritable at ' + this.queuePath + ':', e);
        }

        // Subscribe to consensus finalization
        if (this.hub.attestationConsensus){
            this.hub.attestationConsensus.on('request:finalized', (event) => {
                this.onRequestFinalized(event).catch(err => {
                    console.error('AttestationPublisher: onRequestFinalized error: ' + (err && err.message ? err.message : err));
                });
            });
        }

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

        // Recompute the responsible-set ordering so any node (not just the
        // leader) knows its rank for failover step-in. Persisted on the queue
        // entry so the ordering survives a restart without re-querying snapshots.
        let requestBlock = (event.request && event.request.block_index != null) ? Number(event.request.block_index) : null;
        let redundancy   = (event.request && Number(event.request.redundancy)) ? Number(event.request.redundancy) : event.signatures.length;
        let responsible  = (requestBlock != null) ? await this._computeResponsible(rid, requestBlock, redundancy) : null;
        let leaderPubkey = event.leaderPubkey ? String(event.leaderPubkey).toLowerCase()
                         : (responsible && responsible.length ? responsible[0] : null);

        // Durable write-ahead log BEFORE the send attempt.
        this._enqueue({
            ts:           Date.now(),
            requestId:    event.requestId,
            wire:         payload,
            requestBlock: requestBlock,
            responsible:  responsible || undefined,
            leaderPubkey: leaderPubkey || undefined
        });

        let isLeader = (leaderPubkey && myPubkey && leaderPubkey === myPubkey);
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
        try {
            let result = await broadcaster(payload, event);
            console.log('AttestationPublisher: broadcast ' + rid.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
            // Success; drop the entry so the sweep doesn't re-broadcast it.
            this._removeFromQueue(new Set([rid]));
        } catch (e) {
            console.error('AttestationPublisher: broadcast failed for ' + rid.substring(0,16) + '... (will retry via sweep): ', e);
        }
    }

    // ----- Durable queue (JSONL with fsync), mirroring OraclePublisher -----

    // Append a finalized-response entry to the durable write-ahead log.
    // Best-effort: an unwritable queue must not block the live broadcast, but it
    // does forfeit crash protection for that entry (logged so operators notice).
    _enqueue(entry){
        try {
            let fd = fs.openSync(this.queuePath, 'a');
            fs.writeSync(fd, JSON.stringify(entry) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.warn('AttestationPublisher: failed to enqueue ' + String(entry.requestId).substring(0,16) + '...:', e);
        }
    }

    // Read all queue entries (used by _processQueue and on restart).
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

    // Rewrite the queue with the given entries.
    _rewriteQueue(entries){
        let lines = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
        try {
            let fd = fs.openSync(this.queuePath, 'w');
            fs.writeSync(fd, lines);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch (e) {
            console.error('AttestationPublisher: failed to rewrite queue:', e);
        }
    }

    // Remove the given request IDs from the queue. Re-reads the queue fresh so a
    // concurrently-appended entry (from a live onRequestFinalized that fired
    // mid-sweep) is never clobbered.
    _removeFromQueue(dropSet){
        if (!dropSet || dropSet.size === 0) return;
        let remaining = this._readQueue().filter(e => !dropSet.has(String(e.requestId).toLowerCase()));
        this._rewriteQueue(remaining);
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
            let idx = entry.responsible.map(p => String(p).toLowerCase()).indexOf(myPubkey);
            return idx >= 0 ? idx : null;
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
    // CONSENSUS-CRITICAL: must stay in sync with AttestationRound and the indexer.
    async _computeResponsible(rid, blockIndex, redundancy){
        try {
            if (!this.hub.capabilitySnapshot) return null;
            let weighted = swq.isStakeWeightedQuorumActive(blockIndex, this.hub.network);
            let snapshot = weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('attestation', blockIndex)
                : await this.hub.capabilitySnapshot.getSnapshot('attestation', blockIndex);
            if (!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0) return null;
            let withHash = snapshot.validators.map(v => {
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

    // ----- Failover / replay sweep -----

    // Re-broadcast any queued finalized response whose request is still pending
    // on the indexer. Run once at startup (crash replay) and on an interval
    // (failover step-in + leader retry).
    async _processQueue(){
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

            if (!pendingIds.has(rid)){
                // Already resolved on-chain; clear it out.
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

            if (!broadcaster){
                console.warn('AttestationPublisher: no broadcast pipeline configured; ' + rid.substring(0,16) + '... retained for later replay');
                continue;
            }

            try {
                let result = await broadcaster(entry.wire, { requestId: entry.requestId });
                replayed++;
                drop.add(rid);
                console.log('AttestationPublisher: ' + (rank === 0 ? 're-broadcast leader' : 'stepped in (rank ' + rank + ')') +
                            ' for ' + rid.substring(0,16) + '... txid=' + (result && result.txid ? result.txid : '?'));
            } catch (e) {
                console.error('AttestationPublisher: replay broadcast failed for ' + rid.substring(0,16) + '... (will retry): ', e);
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
            utxos:    utxos,
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
        return await this.encoder.broadcastTx(txHex);
    }
}

module.exports = AttestationPublisher;
