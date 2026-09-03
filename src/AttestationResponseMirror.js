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
 * AttestationResponseMirror: the producer side of the ATTEST response mirror
 * (the ATTEST response mirror design, §3.2).
 *
 * WHY THIS EXISTS. Below the mirror activation height a finalized attestation
 * response is an ATTEST v1 transaction the leader validator broadcasts and pays a
 * chain fee for, and the contract callback fires only once it mines. At or above
 * it the response never becomes its own transaction: it is written here, into the
 * hub's insert-only `attestation_responses` table, streamed to every indexer over
 * the same hub-DB mirror PRICE rounds ride, and applied at a block that is a pure
 * function of the SIGNED effective_time. This module is that write, and nothing
 * else: the periodic on-chain batch that keeps the history reconstructible from
 * chain parse is AttestationBatchPublisher's job, and the ATTEST_RESULT gossip
 * that carries the artifact to hubs outside the responsible set lands here later
 * (see the seam note on insertAndBroadcast).
 *
 * THE MIRROR IS TRANSPORT, NEVER AUTHORITY. Every field this module writes is
 * either covered by the responsible set's signatures or explicitly informational.
 * The row is self-authenticating, so which hub wrote it does not matter: the
 * indexer re-verifies `signatures` against the responsible set it resolves from
 * ITS OWN local v0 request row, and a row that fails is skipped identically on
 * every node rather than forking one.
 *
 * WHAT IT LISTENS TO. AttestationConsensus emits 'request:finalized' when a round
 * reaches commit quorum. That listener is PROCESS-GLOBAL and attached once in
 * start() (decision D58), which is why the activation gate is a per-request early
 * return inside the handler rather than a conditional attach; AttestationPublisher
 * carries the same predicate on the same event, with the two branches mutually
 * exclusive so a request is served by exactly one of the two eras.
 *
 * WHY THE HANDLER COPIES BEFORE IT AWAITS. `pending` (the round state the emitted
 * payload was assembled from) is deleted PENDING_EVICT_MS (10s) after the emit, and
 * the event's nested `request`, `signatures` and body objects are the round's own
 * live objects, not clones. A handler that awaited its DB round-trip first and read
 * the payload afterwards would be racing that eviction and a retry round's
 * overwrite for the same rid. So the whole row is materialized synchronously, in
 * the handler's own tick, and only the finished row crosses the await boundary.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { isResponseMirrorActive } = require('./attest_response_mirror_activation.js');

// The mirrored column set, in the order the snapshot route (api.js
// GET /hub-db/snapshot/attestation_responses) selects them. It is written out
// once here and used for BOTH the INSERT and the select-back on purpose: the REST
// bootstrap and this WS stream must hand a consumer the SAME columns, and the way
// they drift apart is one path gaining a column the other does not know about.
// `id` is excluded: it is assigned by AUTO_INCREMENT and stripped again on apply
// (two hubs carry different ids for the same logical row), so it is a paging
// cursor and never an input.
const MIRROR_COLUMNS = [
    'network', 'request_id', 'request_action_index', 'request_block_index',
    'provider_id', 'status', 'response_payload', 'response_hash', 'meta',
    'effective_time', 'signer_pubkeys', 'signatures', 'widen', 'finalized_at'
];

// The statuses the mirror carries. Terminal only: a retryable round leaves the
// request pending on the indexer, has no chain effect today beyond an audit row,
// and is the one unbounded multiplier on the size of the periodic on-chain batch.
// In practice the hub only ever produces 'ok' here (decision D56: 'expired' is an
// indexer verdict from the local deadline sweep, which needs no mirror row); the
// wider set is accepted so an 'expired' producer could be added without a schema
// change, exactly as the column's own vocabulary allows.
const TERMINAL_STATUSES = new Set(['ok', 'expired']);

class AttestationResponseMirror {

    constructor(hub){
        this.hub = hub;
        this._messageHandler = null;
        // Observability counters. Skips are logged and counted; rows never are.
        this.stats = { written: 0, duplicates: 0, skipped: 0, errors: 0 };
    }

    // Resolved per call rather than cached at construction: startAttestation runs
    // after hub.start() has built both, but a hub that reconnects its DB or wires a
    // broadcaster later must not leave this engine holding a dead handle.
    _db(){ return this.hub && this.hub.db; }
    _broadcaster(){ return this.hub && this.hub.hubDbBroadcaster; }

    // Seam for tests; every wall-clock read on this path goes through it.
    _nowSeconds(){
        return Math.floor(Date.now() / 1000);
    }

    // True when the response to a request admitted at `requestBlock` rides the
    // mirror. The IDENTICAL predicate AttestationPublisher's early return uses, on
    // the same activation copy: the two eras must partition every finalized round
    // between them, so a request either gets a mirror row or an on-chain v1, never
    // both and never neither. Keyed on the REQUEST's own BTC block_index, never the
    // response's and never the chain tip, so the rule for a request is fixed the
    // moment it is admitted.
    _isMirrorEra(requestBlock){
        return isResponseMirrorActive(requestBlock, this.hub && this.hub.network);
    }

    async start(){
        let consensus = this.hub && this.hub.attestationConsensus;
        if(!consensus || typeof consensus.on !== 'function'){
            console.log('AttestationResponseMirror: no AttestationConsensus, skipping consensus wiring');
            return;
        }
        if(this._messageHandler) return;   // idempotent start; never a second listener on one event
        this._messageHandler = (event) => {
            // SYNCHRONOUS materialization, before any await: see the header note on
            // the 10-second `pending` eviction. Everything the row needs is copied
            // out of the payload here, in the emitter's own tick.
            let row;
            try {
                row = this.buildRow(event);
            } catch (err) {
                this.stats.errors++;
                console.error('AttestationResponseMirror: row build failed for ' +
                              this._shortRid(event) + ': ' + (err && err.message ? err.message : err));
                return;
            }
            if(!row) return;
            this.insertAndBroadcast(row).catch(err => {
                this.stats.errors++;
                console.error('AttestationResponseMirror: mirror write failed for ' +
                              String(row.request_id).substring(0, 16) + '...: ' +
                              (err && err.message ? err.message : err));
            });
        };
        consensus.on('request:finalized', this._messageHandler);
        console.log('AttestationResponseMirror started (network: ' + (this.hub && this.hub.network) + ')');
    }

    async stop(){
        let consensus = this.hub && this.hub.attestationConsensus;
        if(consensus && this._messageHandler && typeof consensus.removeListener === 'function')
            consensus.removeListener('request:finalized', this._messageHandler);
        // Cleared even when the removeListener above could not run, so a restart
        // re-attaches from a known state instead of refusing on the stale handle.
        this._messageHandler = null;
    }

    // Materialize a mirror row from a 'request:finalized' payload, or null when this
    // round is not one the mirror carries. Pure and synchronous by contract: it
    // touches no DB and no clock beyond _nowSeconds, so the caller can run it inside
    // the emit and let only the finished row cross an await.
    //
    // Returns null (with a logged reason) rather than throwing on every "not ours"
    // case, because those are ordinary traffic: legacy-era rounds, retryable
    // statuses, and rounds that reached quorum with no verifying signature.
    buildRow(event){
        if(!event || !event.requestId) return null;

        // Era gate. Below the height, or on a network whose activation entry is
        // null (unratified), the legacy on-chain path owns this response and the
        // mirror must write NOTHING: a row here would be a second delivery of the
        // same response under a canonical the signatures do not cover.
        let requestBlock = Number(event.request && event.request.block_index);
        if(!this._isMirrorEra(requestBlock)) return null;

        let rid = String(event.requestId).toLowerCase();
        let status = String(event.status || 'ok');
        if(!TERMINAL_STATUSES.has(status)){
            this.stats.skipped++;
            console.log('AttestationResponseMirror: skipping non-terminal round ' + rid.substring(0, 16) +
                        '... (status=' + status + '); retryable rounds are deliberately not mirrored');
            return null;
        }

        let sigs = Array.isArray(event.signatures) ? event.signatures : [];
        if(sigs.length === 0){
            // A row with no signatures is inert on every indexer (the verifier
            // resolves no quorum), so writing it would only put an unappliable row
            // in the stream and in the on-chain batch.
            this.stats.skipped++;
            console.warn('AttestationResponseMirror: no signatures in finalized event for ' +
                         rid.substring(0, 16) + '...; skipping mirror row');
            return null;
        }

        // effective_time is the whole reason the applying block is deterministic: it
        // is INSIDE the canonical the set signed, so it can only be copied from the
        // event, never recomputed here. A recomputed `now + margin` would store a
        // value no signature covers and every indexer would skip the row, which is
        // why a mirror-era event without one is an error rather than a default.
        //
        // `null` is the LEGACY-ERA marker the emitter uses, and it must not coerce:
        // Number(null) is 0, a finite value that would sail past a bare isFinite check
        // and store an effective_time of the unix epoch, applying the row at the very
        // first block every indexer already has. Number('') is 0 for the same reason.
        // This is the same coercion trap the activation module's own null sentinel
        // documents, so it is tested for explicitly rather than left to Number().
        let rawEffective = event.effectiveTime;
        let effectiveTime = (rawEffective === null || rawEffective === undefined || rawEffective === '')
            ? NaN : Number(rawEffective);
        if(!Number.isInteger(effectiveTime)){
            this.stats.skipped++;
            console.error('AttestationResponseMirror: mirror-era round ' + rid.substring(0, 16) +
                          '... (block ' + requestBlock + ') carries no signed effective_time; refusing to write ' +
                          'a row no verifier could rebuild');
            return null;
        }

        let body = event.responseBody;
        let bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');

        return {
            network:              String(this.hub && this.hub.network),
            request_id:           rid,
            // Ordering aid only, and informational at that: the applier re-derives
            // both from its own local v0 request row rather than trusting the wire.
            request_action_index: this._intOrNull(event.request && event.request.action_index),
            request_block_index:  this._intOrNull(requestBlock),
            provider_id:          String(event.providerId == null ? '' : event.providerId),
            status:               status,
            // Stored decoded as UTF-8, exactly as attests.response_payload is on the
            // on-chain path, so the applier's row is shaped like a v1's.
            response_payload:     bodyBytes.toString('utf8'),
            // Over the BYTES the signatures cover, computed the same way
            // AttestationConsensus._buildCanonical computes it. Not over the decoded
            // string above: for a body that is valid UTF-8 the two coincide, and for
            // one that is not, this field stays honest about what was signed and the
            // row is inert on every node identically instead of forking one.
            response_hash:        crypto.createHash('sha256').update(bodyBytes).digest('hex'),
            meta:                 event.meta == null ? '' : String(event.meta),
            effective_time:       effectiveTime,
            // Ordered exactly as the signature list is: the pubkey at index i signed
            // the signature at index i, which is what lets a consumer pair them
            // without re-deriving the responsible set's ordering.
            signer_pubkeys:       JSON.stringify(sigs.map(s => String(s && s.pubkey).toLowerCase())),
            signatures:           JSON.stringify(sigs.map(s => ({
                                      pubkey: String(s && s.pubkey).toLowerCase(),
                                      sig:    String(s && s.sig).toLowerCase()
                                  }))),
            // Informational: the verifier recomputes the widening step itself from
            // the request's own block, so a lying `widen` changes nothing on chain.
            widen:                Math.max(0, this._intOrNull(event.widen) || 0),
            // Hub wall clock at quorum. AUDIT ONLY: never a consensus input, never
            // compared across hubs, and deliberately the one column two hubs' copies
            // of the same logical row are allowed to disagree on (alongside `id`).
            finalized_at:         this._nowSeconds()
        };
    }

    // Write one mirror row and stream it. THE SHARED WRITE PATH: the
    // 'request:finalized' listener above is one caller, and the ATTEST_RESULT gossip
    // receiver is the other (§3.3) - a hub outside the responsible set never runs
    // the round, so its only source for the artifact is a peer's envelope, and once
    // that envelope's signatures verify the row it inserts is byte-identical to this
    // one apart from `id` and `finalized_at`. Both callers therefore need the same
    // idempotent write, which is why this takes a finished row rather than an event.
    //
    // Returns true iff THIS hub newly inserted the row.
    async insertAndBroadcast(row){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function'){
            this.stats.errors++;
            console.warn('AttestationResponseMirror: no hub DB; dropping mirror row for ' +
                         String(row.request_id).substring(0, 16) + '...');
            return false;
        }

        // INSERT IGNORE against the UNIQUE (network, request_id). A duplicate is
        // ordinary traffic rather than an error: two hubs in the responsible set both
        // finalize, each gossips, and a parked envelope retries a cycle later, so the
        // same logical row can arrive several ways. Insert-only means the existing row
        // is already correct, so absorbing the duplicate is the whole conflict policy.
        let res = await db.doQuery(
            'INSERT IGNORE INTO attestation_responses (' + MIRROR_COLUMNS.join(', ') + ') ' +
            'VALUES (' + MIRROR_COLUMNS.map(() => '?').join(', ') + ')',
            MIRROR_COLUMNS.map(c => row[c]));
        let inserted = !!(res && Number(res.affectedRows) > 0);
        if(inserted) this.stats.written++;
        else         this.stats.duplicates++;

        // THE SELECT-BACK IS LOAD-BEARING, and it is why this cannot just broadcast
        // the object it inserted. `id` is assigned by AUTO_INCREMENT, and the id is
        // the consumer's paging cursor: the mirror bootstraps over `since_id` and
        // reasons about catch-up against the `max_ids` entry in the WS ready frame,
        // so a streamed row without one is a row the consumer cannot place in this
        // hub's stream. It is also read back on the DUPLICATE path, deliberately: a
        // hub that already holds the row must be able to answer with the id it holds
        // (the gossip receiver needs exactly that), and res.insertId is 0 on an
        // ignored insert, so the id can only come from the table.
        let rows = await db.doQuery(
            'SELECT id, ' + MIRROR_COLUMNS.join(', ') + ' ' +
            'FROM attestation_responses WHERE network = ? AND request_id = ? LIMIT 1',
            [row.network, row.request_id]);
        let stored = (rows && rows.length) ? rows[0] : null;
        if(!stored){
            this.stats.errors++;
            console.error('AttestationResponseMirror: wrote ' + String(row.request_id).substring(0, 16) +
                          '... but could not read it back; not broadcasting a row with no id');
            return inserted;
        }

        // Broadcast ONLY a fresh insert. `row:inserted` is a delta notification for a
        // row that just entered this hub's stream, and on the duplicate path nothing
        // did: with a five-hub federation all gossiping the same artifact, and a
        // parked envelope retrying a cycle later, re-emitting would fan the same row
        // at every subscriber once per delivery. Suppressing it costs nothing, because
        // the row a subscriber missed is recovered by the bootstrap over `since_id`,
        // not by a re-emit it may equally have missed.
        if(inserted){
            let b = this._broadcaster();
            if(b && typeof b.broadcastRow === 'function')
                b.broadcastRow({ table: 'attestation_responses', row: stored });
        }
        return inserted;
    }

    // Bounded chain integers only (block heights, action indexes). Null rather than
    // NaN on anything unparseable, because both columns are nullable and
    // informational: a null there degrades an ordering aid, while a NaN is a SQL error
    // that would lose the whole row.
    _intOrNull(v){
        if(v == null) return null;
        let n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    }

    _shortRid(event){
        let rid = event && event.requestId;
        return rid ? String(rid).substring(0, 16) + '...' : '(no request id)';
    }
}

module.exports = AttestationResponseMirror;
module.exports.MIRROR_COLUMNS = MIRROR_COLUMNS;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
