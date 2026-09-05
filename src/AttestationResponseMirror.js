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
 * chain parse is AttestationBatchPublisher's job. It IS, however, the receiving end
 * of that batch: `receiveValidatedBatch` takes a batch the indexer parsed off the
 * DOGE rail and pushed back, re-verifies the batch quorum, writes any row this hub
 * does not hold, and sets the row's batch link. That is the chain-only rebuild road
 * (§6.3), so a node with no mirror connection still reaches the same rows.
 *
 * IT IS ALSO THE DISSEMINATION SIDE (§3.3). Only the responsible set runs a round,
 * so on a five-hub federation at redundancy 3 two hubs never learn the result at
 * all, and an indexer follows exactly ONE hub. The finalized artifact is therefore
 * gossiped as an ATTEST_RESULT P2P envelope, and a receiving hub re-verifies it
 * against its OWN capability snapshot before writing its own copy.
 *
 * TWO LAYERS OF SIGNATURE, AND THEY ANSWER DIFFERENT QUESTIONS. The ENVELOPE is
 * signed by the sending hub and checked by PeerManager before this engine ever sees
 * it (membership in the chain-effective signer set, then Ed25519, then replay
 * dedupe): that is TRANSPORT authenticity, and all it establishes is that some
 * federation member relayed these bytes. The ROW inside carries the responsible
 * set's own signatures over the mirror-era canonical, and that is what makes the
 * artifact true. Only the second layer is consensus: a row from a peer whose
 * envelope verified is still dropped if its content signatures do not, and a row
 * whose content verifies would be equally true arriving any other way. This is the
 * XANCREWARD shape (StateAnchorPublisher._federateRewardAttestation), with one
 * difference worth naming: XANCREWARD needs a sender signature INSIDE its payload
 * because its receiver re-runs an on-chain proof keyed to the relayer's identity,
 * while nothing here is keyed to who relayed, so the transport layer is left
 * entirely to the envelope and this payload carries no sender field at all.
 *
 * NO PeerManager EDIT. There is no message-type registry on the hub: every engine
 * subscribes to PeerManager's 'message' event and switches on `envelope.type`. So
 * this is one `const` and one `case`, exactly as §6.2 requires.
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
const axios  = require('axios');
const abw    = require('./lib/attest_batch_wire.js');
const swq    = require('./stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const wid    = require('./attest_responsible_widening_activation.js');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const { isResponseMirrorActive } = require('./attest_response_mirror_activation.js');
const { ATTEST_RESPONSE_BODY_MAX_BYTES, bodyByteLength } = require('./lib/attest_response_body_cap.js');

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
    'effective_time', 'signer_pubkeys', 'signatures', 'widen', 'batch_action_index',
    'finalized_at'
];

// The statuses the mirror carries. Terminal only: a retryable round leaves the
// request pending on the indexer, has no chain effect today beyond an audit row,
// and is the one unbounded multiplier on the size of the periodic on-chain batch.
// In practice the hub only ever produces 'ok' here (decision D56: 'expired' is an
// indexer verdict from the local deadline sweep, which needs no mirror row); the
// wider set is accepted so an 'expired' producer could be added without a schema
// change, exactly as the column's own vocabulary allows.
const TERMINAL_STATUSES = new Set(['ok', 'expired']);

// The one P2P message type this engine owns (§3.3).
const ATTEST_RESULT = 'ATTEST_RESULT';

// The row as it rides the wire: every mirrored column except `finalized_at`.
// DERIVED from MIRROR_COLUMNS rather than written out again, so a column added to
// the table travels automatically instead of being silently absent on one path.
// `finalized_at` is excluded because it is the receiver's OWN audit stamp, not a
// property of the artifact: the column's contract is explicitly that two hubs'
// copies of one logical row may disagree on it, and the on-chain batch (§6.1)
// excludes it for the same reason. Leaving it off the wire also means there is no
// wire-supplied clock value to sanitize or to abuse. `batch_action_index` is off the
// wire for the same reason: it is set by the DOGE batch landing, hours after the
// gossip, and reaches every hub through the chain-to-hub push rather than through a
// peer's claim.
const GOSSIP_COLUMNS = MIRROR_COLUMNS.filter(c => c !== 'finalized_at' && c !== 'batch_action_index');

// The park set's ceiling. A row whose request this hub cannot resolve yet is held
// for one retry cycle, and a peer that gossips rows for requests that will never
// exist would otherwise grow this map without bound, so it is capped and the oldest
// entry is evicted first. Sized well above any honest backlog: the admission cap is
// 10 requests per BTC block (§6.1), so 128 covers roughly two hours of full blocks.
const PARK_MAX = 128;

// One park cycle. Matched to AttestationRound's DEFAULT_POLL_MS, because the thing
// being waited for is exactly what that poll observes: the local BTC indexer
// catching up far enough to hold the v0 request row.
const PARK_RETRY_MS = 15000;

// One page of the pending-request queue is enough to resolve a request, because the
// wire's own (block_index, action_index) positions the keyset cursor on it. See
// _resolveLocalRequest for why using an untrusted value as a cursor is safe.
const REQUEST_LOOKUP_LIMIT = 100;

class AttestationResponseMirror {

    constructor(hub){
        this.hub = hub;
        this._messageHandler = null;
        this._peerHandler    = null;
        this._retryTimer     = null;
        // Rows whose local v0 request this hub has not seen yet, keyed
        // network|request_id. Insertion-ordered, which is what makes the overflow
        // eviction below "oldest first" without a second index.
        this._parked = new Map();
        // Observability counters. Skips are logged and counted; rows never are.
        this.stats = {
            written: 0, duplicates: 0, skipped: 0, errors: 0,
            gossiped: 0, received: 0, rejected: 0, parked: 0, dropped: 0
        };
    }

    // Resolved per call rather than cached at construction: startAttestation runs
    // after hub.start() has built both, but a hub that reconnects its DB or wires a
    // broadcaster later must not leave this engine holding a dead handle.
    _db(){ return this.hub && this.hub.db; }
    _broadcaster(){ return this.hub && this.hub.hubDbBroadcaster; }
    _peerManager(){ return this.hub && this.hub.peerManager; }

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
            this.insertAndBroadcast(row).then(inserted => {
                // GOSSIP ONLY A NEW LOCAL INSERT, and only from THIS path. The
                // artifact leaves this hub exactly once per finalized round: the
                // duplicate path (a retry round re-finalizing the same request)
                // sends nothing, and the gossip RECEIVER never re-sends at all
                // (see _ingestGossipRow). With every responsible hub finalizing
                // the same round independently, one hop per producer is already
                // full coverage of the federation, while forwarding on receipt
                // would multiply one artifact by the peer count on every hop and
                // let a Byzantine peer amplify at no cost.
                if(inserted) this._gossipRow(row);
            }).catch(err => {
                this.stats.errors++;
                console.error('AttestationResponseMirror: mirror write failed for ' +
                              String(row.request_id).substring(0, 16) + '...: ' +
                              (err && err.message ? err.message : err));
            });
        };
        consensus.on('request:finalized', this._messageHandler);

        // The receive half. There is no message-type registry on the hub, so this
        // is a plain 'message' subscription that switches on envelope.type, exactly
        // as StateAnchorPublisher and OracleBatchSigner do. Wired AFTER the
        // consensus listener and behind the same idempotence guard, because the
        // verifier below reaches into AttestationConsensus for the canonical: a hub
        // with no consensus engine cannot judge a gossiped row and must not accept
        // one either.
        let pm = this._peerManager();
        if(pm && typeof pm.on === 'function'){
            this._peerHandler = (envelope) => this._handleMessage(envelope);
            pm.on('message', this._peerHandler);
            this._retryTimer = setInterval(() => {
                this._drainParked().catch(e =>
                    console.error('AttestationResponseMirror: park drain error: ' + (e && e.message ? e.message : e)));
            }, PARK_RETRY_MS);
            // Never hold the process (or a test runner) open for a cache of rows
            // whose only backstop is already the periodic on-chain batch.
            if(typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
        }

        console.log('AttestationResponseMirror started (network: ' + (this.hub && this.hub.network) + ')');
    }

    async stop(){
        let consensus = this.hub && this.hub.attestationConsensus;
        if(consensus && this._messageHandler && typeof consensus.removeListener === 'function')
            consensus.removeListener('request:finalized', this._messageHandler);
        let pm = this._peerManager();
        if(pm && this._peerHandler && typeof pm.removeListener === 'function')
            pm.removeListener('message', this._peerHandler);
        if(this._retryTimer){
            clearInterval(this._retryTimer);
            this._retryTimer = null;
        }
        // Parked rows are deliberately NOT carried across a stop: they are unverified
        // wire content whose backstop is the batch, so re-reading them after a restart
        // would only replay stale envelopes.
        this._parked.clear();
        // Cleared even when the removeListener above could not run, so a restart
        // re-attaches from a known state instead of refusing on the stale handle.
        this._messageHandler = null;
        this._peerHandler    = null;
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
        // CANONICAL ORDER, by pubkey. AttestationConsensus hands these over in the order
        // the signatures ARRIVED at this hub (a Map walked in insertion order), and that
        // order differs hub to hub for the same quorum. Everything downstream that
        // compares rows across hubs compares these two JSON columns byte for byte: the
        // batch co-sign (`_matchesLocalWindow`, ATTEST_BATCH_ROW_FIELDS) refused every
        // window carrying a real response on the regtest ladder with `differs on
        // signer_pubkeys` while all four responsible hubs held the same three signers
        // (2026-09-05, AT5). Sorting here keeps the pubkey-at-index-i-signed-signature-
        // at-index-i pairing intact, and the indexer verifies the pairs as a set.
        sigs = sigs.slice().sort((a, b) => {
            let pa = String(a && a.pubkey).toLowerCase(), pb = String(b && b.pubkey).toLowerCase();
            return pa < pb ? -1 : (pa > pb ? 1 : 0);
        });
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
            // A column the writer never sets (batch_action_index at finalization) binds
            // NULL explicitly rather than riding the driver's treatment of undefined.
            MIRROR_COLUMNS.map(c => (row[c] === undefined ? null : row[c])));
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

    // ---- the batch landing (§6.3, D72 and D78) -----------------------------

    // Absorb one ATTEST v5 batch that landed on the DOGE rail and was pushed back by
    // the indexer that parsed it. THIS IS THE CHAIN-ONLY REBUILD ROAD: a node with no
    // mirror connection reaches the same rows by replaying the chain into a hub, which
    // re-serves them through the ordinary §4 path.
    //
    // WHAT IS VERIFIED HERE AND WHAT IS NOT. The BATCH quorum is re-verified once,
    // against this hub's OWN capability view at the batch's signed BTC anchor, exactly
    // as the price rail re-verifies a pushed batch: the pusher's local validation is
    // never trusted. The per-row responsible-set signatures are deliberately NOT
    // re-checked here, and that is the design rather than an omission (D72): they are
    // checked where attestation stake actually resolves, on every BTC indexer, through
    // the shared verifier, after this hub re-serves the row. A row this batch carries
    // that the BTC side later rejects is inert there, exactly as a bad gossiped row is.
    //
    // THREE EFFECTS, ALL IDEMPOTENT, so a replay and a push_generation retry are
    // no-ops: INSERT IGNORE for a row this hub does not hold (the chain-only case), a
    // set-once UPDATE of `batch_action_index`, and a re-broadcast that fires only when
    // one of those actually changed something. No reorg fence is needed on the way in:
    // nothing here deletes, and a DOGE reorg leaves a stale display link until the batch
    // re-lands, which is cosmetic by construction (the column is in no state hash and
    // the applier never reads it).
    //
    // Returns { accepted, stored, duplicates, linked, rejected, reason }.
    async receiveValidatedBatch(sourceChain, batchData){
        let rowCount = (batchData && Array.isArray(batchData.rows)) ? batchData.rows.length : 0;
        let refuse = (reason) => {
            this.stats.rejected++;
            console.warn('AttestationResponseMirror: refusing pushed batch from ' +
                         (sourceChain || 'unknown') + ': ' + reason);
            return { accepted: false, stored: 0, duplicates: 0, linked: 0, rejected: rowCount, reason: reason };
        };

        if(!batchData || !Array.isArray(batchData.rows)) return refuse('rows must be an array');
        // DoS bound first, mirroring the wire parser's own: the count arrives from an
        // external pusher and every row below costs a keyed read and an INSERT.
        if(batchData.rows.length > abw.ATTEST_BATCH_MAX_ROWS) return refuse('too many rows');

        let network = String(batchData.network == null ? '' : batchData.network);
        if(!network || network !== String(this.hub && this.hub.network))
            return refuse('batch declares network "' + network + '", this hub serves "' +
                          String(this.hub && this.hub.network) + '"');

        // Strict, because Number(null) and Number('') are both 0 and every field below
        // is a chain-derived integer where a coerced 0 is a real value: a zero window
        // start is the epoch, and a zero action_index is a batch link pointing at the
        // first action ever indexed. Same coercion trap the row parser documents.
        let intOrNaN = (v) => ((v === null || v === undefined || v === '') ? NaN : Number(v));

        let windowStart = intOrNaN(batchData.window_start);
        let windowEnd   = intOrNaN(batchData.window_end);
        if(!Number.isInteger(windowStart) || windowStart < 0 ||
           !Number.isInteger(windowEnd) || windowEnd <= windowStart)
            return refuse('invalid window bounds');
        if(intOrNaN(batchData.row_count) !== batchData.rows.length)
            return refuse('row_count does not match the rows carried');

        let anchor = intOrNaN(batchData.btc_block_height);
        if(!Number.isInteger(anchor) || anchor <= 0) return refuse('invalid btc_block_height');

        let actionIndex = intOrNaN(batchData.action_index);
        if(!Number.isInteger(actionIndex) || actionIndex < 0) return refuse('invalid action_index');

        // Structural signature shape before any snapshot work.
        if(!Array.isArray(batchData.sigs) || batchData.sigs.length < 1) return refuse('invalid sigs');
        let sigs = [];
        for(let s of batchData.sigs){
            let pubkey = String((s && s.pubkey) || '').toLowerCase();
            let sig    = String((s && s.sig) || '').toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig)) return refuse('invalid sigs');
            sigs.push({ pubkey: pubkey, sig: sig });
        }

        let quorum = await this._verifyBatchQuorum(batchData, anchor, sigs);
        if(!quorum.ok) return refuse(quorum.error);

        let stored = 0, duplicates = 0, linked = 0, skipped = 0;
        for(let raw of batchData.rows){
            // The batch's row fields ARE the gossip payload's fields, so the structural
            // parse is shared rather than written twice: a row the gossip path would not
            // store is not a row the chain path may store either.
            let row = this._parseGossipRow(raw);
            if(!row){ skipped++; continue; }

            let inserted = false;
            try {
                inserted = await this.insertAndBroadcast(row);
            } catch(err){
                this.stats.errors++;
                console.error('AttestationResponseMirror: batch row ' + row.request_id.substring(0, 16) +
                              '... could not be written: ' + (err && err.message ? err.message : err));
                skipped++;
                continue;
            }
            if(inserted) stored++;
            else         duplicates++;

            // SET ONCE. `batch_action_index IS NULL` in the predicate is what makes a
            // replay, a re-landed batch and a second batch carrying the same row all
            // no-ops: the first batch to carry a response owns its link, and a later one
            // cannot re-point it at itself.
            let didLink = await this._linkBatchAction(row, actionIndex);
            if(didLink){
                linked++;
                // Re-broadcast so the mirror consumer upserts the ONE column on the
                // natural key. insertAndBroadcast streams a row only on a fresh insert,
                // and the row this link lands on has usually been in the stream for
                // hours, so without this the link would reach no indexer.
                await this._rebroadcastRow(row);
            }
        }

        // Tell the publisher the window is covered, so no hub pays to publish a window
        // some hub has already landed. Best-effort and never fatal: the rows are what
        // matter here, and a missing marker costs at most one duplicate batch.
        let publisher = this.hub && this.hub.attestationBatchPublisher;
        if(publisher && typeof publisher.recordLandedWindow === 'function'){
            try {
                await publisher.recordLandedWindow(windowStart, windowEnd,
                    batchData.txid == null ? null : String(batchData.txid), batchData.rows.length);
            } catch(err){
                console.warn('AttestationResponseMirror: could not record the landed batch window ' +
                             windowStart + ': ' + (err && err.message ? err.message : err));
            }
        }

        console.log('AttestationResponseMirror: absorbed batch for window ' + windowStart + '-' + windowEnd +
                    ' from ' + (sourceChain || 'unknown') + ' action ' + actionIndex + ' (' + stored +
                    ' new, ' + duplicates + ' held, ' + linked + ' linked, ' + skipped + ' unusable)');
        return { accepted: true, stored, duplicates, linked, rejected: skipped, reason: null };
    }

    // The batch quorum, against THIS hub's own capability view at the batch's signed
    // anchor. Same signer-set rule the DOGE indexer applies to the wire and the PRICE
    // batch applies to its own: stake-weighted at and above the flag day, count-keyed
    // below, and a pubkey counts only after its signature verifies.
    async _verifyBatchQuorum(batchData, anchor, sigs){
        let network  = this.hub && this.hub.network;
        let weighted = swq.isStakeWeightedQuorumActive(anchor, network);
        let cs = this.hub && this.hub.capabilitySnapshot;
        let snapshot = cs
            ? (weighted ? await cs.getWeightSnapshot('attestation', anchor)
                        : await cs.getSnapshot('attestation', anchor))
            : null;
        // Fail closed: without the snapshot the signatures cannot be checked against the
        // qualified set, so the batch is refused rather than stored on trust.
        if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)
            return { ok: false, error: 'no attestation capability snapshot at block ' + anchor };
        // A truncated weight snapshot under-counts total stake, so the 2/3 bar could
        // admit a batch the full set would refuse.
        if(weighted && snapshot.truncated === true)
            return { ok: false, error: 'attestation capability snapshot truncated at block ' + anchor };

        // Rebuilt from the pushed body, never taken from the pusher: the canonical is the
        // one thing the signatures actually cover.
        let canonical = abw.buildAttestBatchCanonical({
            network:          String(batchData.network),
            window_start:     Number(batchData.window_start),
            window_end:       Number(batchData.window_end),
            row_count:        Number(batchData.row_count),
            btc_block_height: anchor,
            rows:             batchData.rows
        });

        let qualified = new Set(snapshot.validators.map(v => String(v.pubkey).toLowerCase()));
        let seen = new Set(), verified = [];
        for(let s of sigs){
            if(seen.has(s.pubkey)) continue;
            if(!qualified.has(s.pubkey)) continue;
            // Marked seen only AFTER the signature verifies, so a garbage signature
            // carrying a qualified validator's pubkey cannot be ordered ahead of the real
            // one to consume its slot.
            if(!ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) continue;
            seen.add(s.pubkey);
            verified.push(s.pubkey);
        }

        if(weighted){
            if(!swq.meetsStakeThreshold(snapshot.validators, verified))
                return { ok: false, error: 'insufficient signer stake (' + verified.length + ' verified signers)' };
        } else {
            let setSize = Number.isFinite(parseInt(snapshot.count)) ? parseInt(snapshot.count)
                                                                   : snapshot.validators.length;
            let need = bftQuorumOrSingle(setSize, 1);
            if(verified.length < need)
                return { ok: false, error: 'insufficient batch quorum (' + verified.length + '/' + need + ')' };
        }
        return { ok: true, error: null };
    }

    // Set the batch link on one row, once. Returns true iff this call set it.
    async _linkBatchAction(row, actionIndex){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return false;
        let res = await db.doQuery(
            'UPDATE attestation_responses SET batch_action_index = ? ' +
            'WHERE network = ? AND request_id = ? AND batch_action_index IS NULL',
            [actionIndex, row.network, row.request_id]);
        return !!(res && Number(res.affectedRows) > 0);
    }

    // Stream a row that already existed. Selected back rather than broadcast from the
    // object in hand for the reason insertAndBroadcast records: the consumer's cursor is
    // the AUTO_INCREMENT id, and only the table carries it.
    async _rebroadcastRow(row){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return;
        let rows = await db.doQuery(
            'SELECT id, ' + MIRROR_COLUMNS.join(', ') + ' ' +
            'FROM attestation_responses WHERE network = ? AND request_id = ? LIMIT 1',
            [row.network, row.request_id]);
        let stored = (rows && rows.length) ? rows[0] : null;
        if(!stored) return;
        let b = this._broadcaster();
        if(b && typeof b.broadcastRow === 'function')
            b.broadcastRow({ table: 'attestation_responses', row: stored });
    }

    // ---- ATTEST_RESULT gossip (§3.3) --------------------------------------

    // Send. The payload is the row itself and nothing else: no sender field, no
    // extra signature, no hub id. Everything a receiver needs to judge it is either
    // inside the row (the responsible set's signatures) or resolved from the
    // receiver's own local state (the request, the capability snapshot), and the
    // envelope PeerManager builds around this already carries the sending hub's
    // identity and signature.
    //
    // `signer_pubkeys` and `signatures` travel as the JSON STRINGS the column
    // stores, not as re-serialized objects. The receiver writes what it received, so
    // a round-trip through parse-and-stringify would be a chance for key order or
    // number spelling to drift between two hubs' copies of one logical row, and the
    // on-chain batch (§6.1) puts those columns on chain verbatim.
    _gossipRow(row){
        let pm = this._peerManager();
        if(!pm || typeof pm.broadcast !== 'function') return;
        let data = {};
        for(let c of GOSSIP_COLUMNS) data[c] = row[c];
        pm.broadcast(ATTEST_RESULT, data);
        this.stats.gossiped++;
    }

    // The engine's inbound switch. One case, per §3.3.
    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case ATTEST_RESULT:
                this._handleResult(envelope).catch(e =>
                    console.error('AttestationResponseMirror: ATTEST_RESULT error: ' +
                                  (e && e.message ? e.message : e)));
                break;
        }
    }

    async _handleResult(envelope){
        this.stats.received++;
        let row = this._parseGossipRow(envelope.data);
        if(!row){
            this.stats.rejected++;
            return;
        }
        await this._ingestGossipRow(row, true);
    }

    // Shape the wire payload into a row this hub could store, or null. Structural
    // only: this rejects what cannot be a row at all (wrong network, malformed id,
    // a status the table does not carry) so the expensive checks downstream are
    // never reached by junk. It establishes NOTHING about truth; that is the
    // verifier's job.
    _parseGossipRow(d){
        if(!d || typeof d !== 'object') return null;

        // A hub writes rows for ITS OWN network only. The mirror's whole scoping
        // and purge story keys on this column, so accepting a foreign-network row
        // would strand it in a table every local reader filters it out of.
        let network = String(d.network == null ? '' : d.network);
        if(!network || network !== String(this.hub && this.hub.network)) return null;

        let rid = String(d.request_id == null ? '' : d.request_id).toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(rid)) return null;

        let status = String(d.status == null ? '' : d.status);
        if(!TERMINAL_STATUSES.has(status)) return null;

        // Same explicit null/empty handling buildRow documents: Number(null) and
        // Number('') are both 0, an effective_time at the unix epoch, which would
        // bind the row at the first block every indexer already holds.
        let rawEffective = d.effective_time;
        let effectiveTime = (rawEffective === null || rawEffective === undefined || rawEffective === '')
            ? NaN : Number(rawEffective);
        if(!Number.isInteger(effectiveTime) || effectiveTime < 0) return null;

        let responseHash = String(d.response_hash == null ? '' : d.response_hash).toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(responseHash)) return null;

        // The two JSON columns must at least PARSE as the shapes the applier and the
        // batch expect, or the row is unusable everywhere downstream.
        if(this._parseSigList(d.signatures) === null) return null;
        let signerPubkeys = String(d.signer_pubkeys == null ? '' : d.signer_pubkeys);
        try {
            if(!Array.isArray(JSON.parse(signerPubkeys))) return null;
        } catch(_){ return null; }

        let providerId = String(d.provider_id == null ? '' : d.provider_id);
        if(!providerId || providerId.length > 64) return null;

        let payload = String(d.response_payload == null ? '' : d.response_payload);
        // The same cap the leader and every follower enforced before signing (§5.3).
        // Checked here as well as in the verifier so an oversize body never reaches a
        // capability-snapshot fetch: this is the cheap gate, that one is the correct one.
        if(bodyByteLength(payload) > ATTEST_RESPONSE_BODY_MAX_BYTES) return null;

        return {
            network:              network,
            request_id:           rid,
            // Informational, and overwritten from this hub's own request row once it
            // resolves (see _ingestGossipRow). Accepted here only as the cursor hint
            // _resolveLocalRequest uses.
            request_action_index: this._intOrNull(d.request_action_index),
            request_block_index:  this._intOrNull(d.request_block_index),
            provider_id:          providerId,
            status:               status,
            response_payload:     payload,
            response_hash:        responseHash,
            meta:                 d.meta == null ? '' : String(d.meta),
            effective_time:       effectiveTime,
            signer_pubkeys:       signerPubkeys,
            signatures:           String(d.signatures == null ? '' : d.signatures),
            // TINYINT UNSIGNED, and purely informational: the verifier recomputes the
            // widening step from the request's own block, so this is clamped rather
            // than checked.
            widen:                Math.max(0, Math.min(255, this._intOrNull(d.widen) || 0)),
            // OUR clock, not the sender's. This column means "when this hub came to
            // hold the row", it is never a consensus input, and the two hubs are
            // explicitly allowed to disagree on it.
            finalized_at:         this._nowSeconds()
        };
    }

    // Judge one received row and, if it holds up, write it. Returns true iff this
    // call newly inserted it.
    //
    // `allowPark` is false on the retry pass, which is what makes the retry happen
    // exactly ONCE: an entry drained from the park set can no longer re-park itself.
    async _ingestGossipRow(row, allowPark){
        let short = row.request_id.substring(0, 16) + '...';

        // Cheapest gate first, and it is the one that carries the storm. Five hubs
        // finalize and gossip the same artifact, so most deliveries are of a row this
        // hub already holds. The table is insert-only and unique on (network,
        // request_id), so a row we hold is a row we already verified and nothing about
        // it can have changed: answering from the index costs one keyed read and
        // spends no capability snapshot, no indexer round-trip and no signature math.
        if(await this._alreadyHeld(row)){
            this.stats.duplicates++;
            return false;
        }

        // THE REQUEST IS LOCAL STATE OR IT IS NOTHING. Every height the verification
        // turns on comes from this row, never from the wire: an untrusted hub that
        // could name the block its signatures are checked at could name a block at
        // which it controlled the responsible set.
        let local = await this._resolveLocalRequest(row);
        if(!local){
            if(allowPark){
                this._park(row);
                return false;
            }
            this.stats.dropped++;
            console.warn('AttestationResponseMirror: dropping gossiped row ' + short +
                         ' after one parked retry; this hub still holds no v0 request for it. ' +
                         'The periodic on-chain batch is the backstop.');
            return false;
        }

        let request = local.request;
        let declaredBlock = Number(request.block_index);

        // The era gate, read off the LOCAL request exactly as the producer path reads
        // it off the round's own request. A legacy-era request's response is an
        // on-chain v1; a mirror row for one would be a second delivery under a
        // canonical its signatures do not cover.
        if(!this._isMirrorEra(declaredBlock)){
            this.stats.rejected++;
            console.warn('AttestationResponseMirror: dropping gossiped row ' + short +
                         '; its local request at block ' + declaredBlock + ' is legacy-era');
            return false;
        }

        let verdict = await this._verifyGossipedRow(row, request, local.latestBlock);
        if(!verdict.ok){
            this.stats.rejected++;
            console.warn('AttestationResponseMirror: dropping gossiped row ' + short +
                         '; ' + verdict.error);
            return false;
        }

        // The two informational columns are re-stated from the local request rather
        // than kept as the sender wrote them. They are ordering aids the applier
        // re-derives anyway, so a lie in them is inert either way, but the local
        // values are the same on every honest node, so taking them makes two hubs'
        // copies of one logical row converge instead of diverge, which is what the
        // on-chain batch body (§6.1) puts on chain.
        row.request_block_index  = this._intOrNull(request.block_index);
        row.request_action_index = this._intOrNull(request.action_index);

        // insertAndBroadcast streams the row to THIS hub's WS subscribers on a fresh
        // insert, which is the whole point: an indexer following a hub outside the
        // responsible set gets the artifact only through here. What it deliberately
        // does not do is send another ATTEST_RESULT. A received row is not re-gossiped
        // because every hub is already one hop from every producer, so forwarding adds
        // no reach and turns one artifact into a fan-out per peer per hop.
        return await this.insertAndBroadcast(row);
    }

    // Does this hub already hold the row? One keyed read on the UNIQUE index.
    async _alreadyHeld(row){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return false;
        let rows = await db.doQuery(
            'SELECT id FROM attestation_responses WHERE network = ? AND request_id = ? LIMIT 1',
            [row.network, row.request_id]);
        return !!(rows && rows.length);
    }

    // Resolve this hub's OWN v0 request row for a gossiped response, plus the chain
    // tip the same call reports. Returns null when the request cannot be resolved,
    // whether because the local indexer has not indexed the v0 yet or because it
    // could not be reached at all: both are "we cannot judge this row right now",
    // and both park.
    //
    // WHY AN UNTRUSTED CURSOR HINT IS SAFE. The pending queue is keyset-paged on
    // (block_index, action_index) and can be longer than one page, so the row's own
    // claimed position drives the seek. That value is wire content, but it can only
    // steer a READ: the returned row is matched on request_id, and every field the
    // verification consumes is taken from that returned row. A lie therefore costs
    // the liar its own delivery (we look in the wrong page, find nothing, park and
    // drop) and cannot make us verify against a set of its choosing.
    async _resolveLocalRequest(row){
        let hub = this.hub;
        if(!hub || typeof hub._resolveBtcIndexerUrl !== 'function') return null;
        let url = await hub._resolveBtcIndexerUrl();
        if(!url) return null;

        let params = { limit: REQUEST_LOOKUP_LIMIT };
        let hintBlock  = Number(row.request_block_index);
        let hintAction = Number(row.request_action_index);
        // The cursor is EXCLUSIVE, so seek to one before the claimed position and the
        // claimed row is the first the page can return. Omitted entirely for an
        // unusable or zero hint, which asks for the oldest page instead.
        if(Number.isFinite(hintBlock) && Number.isFinite(hintAction) && hintAction >= 1){
            params.after_block_index  = Math.trunc(hintBlock);
            params.after_action_index = Math.trunc(hintAction) - 1;
        }

        let res;
        try {
            res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method:  'getpendingattestation_requests',
                params:  params
            }, { headers: hub._btcIndexerHeaders(), timeout: 5000 });
        } catch (e){
            console.warn('AttestationResponseMirror: request lookup failed for ' +
                         row.request_id.substring(0, 16) + '...: ' + (e && e.message ? e.message : e));
            return null;
        }

        let result = res && res.data && res.data.result;
        if(!result || result.error) return null;
        let requests = Array.isArray(result.requests) ? result.requests : [];
        let request  = requests.find(r => String((r && r.request_id) || '').toLowerCase() === row.request_id);
        if(!request) return null;
        return { request: request, latestBlock: Number(result.latest_block_index) || 0 };
    }

    // Verify the responsible set's signatures over the mirror-era canonical, using
    // this hub's own snapshot of the world (§4.3). Returns {ok, error}.
    //
    // Every helper here is the hub's OWN copy of a consensus rule, called rather than
    // re-implemented: _computeResponsibleSet is the ranking that picks the signers in
    // AttestationRound, and _buildCanonical is the byte string they sign. A second
    // spelling of either would be a fork surface that no suite compares, which is why
    // this reaches for two "private" methods instead of copying twenty lines.
    async _verifyGossipedRow(row, request, latestBlock){
        let rid = row.request_id;
        let declaredBlock = Number(request.block_index);
        if(!Number.isFinite(declaredBlock)) return { ok: false, error: 'local request carries no block_index' };
        let redundancy = Math.max(1, Number(request.redundancy) || 1);

        let sigs = this._parseSigList(row.signatures);
        if(sigs === null || sigs.length === 0) return { ok: false, error: 'signature list is not a non-empty JSON array of {pubkey,sig}' };

        // The body as bytes. The column stores the UTF-8 DECODE of what was signed, so
        // re-encoding is all that is available; the echo check is what turns a body
        // that is not UTF-8 round-trippable into a named rejection instead of an
        // opaque signature failure. Byte-identical reasoning to the indexer applier.
        let bodyBytes = Buffer.from(String(row.response_payload == null ? '' : row.response_payload), 'utf8');
        if(bodyBytes.length > ATTEST_RESPONSE_BODY_MAX_BYTES)
            return { ok: false, error: 'body ' + bodyBytes.length + ' bytes over the ' + ATTEST_RESPONSE_BODY_MAX_BYTES + '-byte cap' };
        let echoHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
        if(echoHash !== row.response_hash)
            return { ok: false, error: 'response_hash does not match the stored body' };

        // The capability snapshot at the request's own declared height. The BURIAL is
        // applied inside CapabilitySnapshot (_buriedBlockIndex subtracts
        // CANONICAL_REORG_BUFFER from every height it is handed), which is why the
        // DECLARED height is passed here and why this must not bury it a second time:
        // AttestationRound passes the declared height too, so this resolves exactly
        // the set the signers were drawn from.
        let weighted = swq.isStakeWeightedQuorumActive(declaredBlock, this.hub && this.hub.network);
        let cs = this.hub && this.hub.capabilitySnapshot;
        let snapshot = cs
            ? (weighted ? await cs.getWeightSnapshot('attestation', declaredBlock)
                        : await cs.getSnapshot('attestation', declaredBlock))
            : null;
        // Fail CLOSED on an unresolved snapshot, as every other hub path does: an
        // empty set would admit no signature anyway, and treating "we could not ask"
        // as "nobody is eligible" is the direction that cannot mint a row.
        if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)
            return { ok: false, error: 'no capability snapshot at block ' + declaredBlock };

        // The provider's block-anchored stake floor, resolved at the same height the
        // round resolved it at. Fails closed on the weighted branch exactly as
        // AttestationRound does: a floorless provider must not widen the serving set
        // back out to everyone clearing the lower capability bar.
        let reg = this.hub && this.hub.providerRegistry;
        let providerFloor = (reg && typeof reg.getMinStake === 'function')
            ? reg.getMinStake(String(request.provider_id), declaredBlock) : null;
        if(weighted && providerFloor === null)
            return { ok: false, error: 'provider "' + request.provider_id + '" has no min_stake floor at block ' + declaredBlock };

        // The widening ladder, evaluated at OUR tip. Monotone in the block, and the
        // signing hub derived its slots from a tip no higher than this one, so the set
        // admitted here is a superset of the set that signed: a signature that was
        // authorized at proposal time can never be rejected by this term.
        let widen = (Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0)
            ? wid.widenSlots(Number(latestBlock), declaredBlock, Number(request.deadline_block), this.hub && this.hub.network)
            : 0;

        let round = this.hub && this.hub.attestationRound;
        if(!round || typeof round._computeResponsibleSet !== 'function')
            return { ok: false, error: 'no AttestationRound to resolve the responsible set' };
        // Derived from the snapshot above, so membership here already implies holding
        // the attestation capability at that height. The indexer needs two filters
        // because its capability read and its responsible read are separate queries
        // that can disagree; here they are one set, so one filter is the same rule.
        let responsible = new Set(round._computeResponsibleSet(
            snapshot.validators, rid, redundancy, weighted, providerFloor, widen
        ).map(v => String(v.pubkey).toLowerCase()));

        let consensus = this.hub && this.hub.attestationConsensus;
        if(!consensus || typeof consensus._buildCanonical !== 'function')
            return { ok: false, error: 'no AttestationConsensus to rebuild the canonical' };
        let canonical;
        try {
            // The mirror-era canonical: the same seven-argument call every in-round
            // signing site makes, with the SIGNED effective_time from the row. The
            // era assertion inside it is a second, independent check that this row and
            // this request agree about which era they are in.
            canonical = consensus._buildCanonical(
                rid, String(row.provider_id), bodyBytes, String(row.status),
                String(row.meta == null ? '' : row.meta), declaredBlock, Number(row.effective_time));
        } catch (e){
            return { ok: false, error: 'canonical could not be rebuilt: ' + (e && e.message ? e.message : e) };
        }
        let canonicalStr = canonical.toString('utf8');

        // Dedupe BEFORE verifying, and one attempt per pubkey. Deduping after would
        // let a producer hide a bad signature behind a good one for the same key, so
        // the admitted count would depend on how many entries it chose to send rather
        // than on how many distinct responsible validators actually signed.
        let seen = new Set();
        let valid = 0;
        for(let s of sigs){
            if(seen.has(s.pubkey)) continue;
            seen.add(s.pubkey);
            if(!responsible.has(s.pubkey)) continue;
            if(!ValidatorIdentity.verify(canonicalStr, s.sig, s.pubkey)) continue;
            valid++;
        }
        if(valid < redundancy)
            return { ok: false, error: 'insufficient valid signatures (' + valid + '/' + redundancy + ')' };
        return { ok: true, error: null };
    }

    // Parse the `signatures` column into format-checked, lower-cased entries, or null
    // when it is not the shape every consumer requires. Shared by the structural gate
    // and the verifier so the two can never disagree about what a signature list is.
    _parseSigList(raw){
        let declared;
        try { declared = JSON.parse(String(raw == null ? '' : raw)); }
        catch(_){ return null; }
        if(!Array.isArray(declared) || declared.length === 0) return null;
        let out = [];
        for(let s of declared){
            let pubkey = String((s && s.pubkey) || '').toLowerCase();
            let sig    = String((s && s.sig) || '').toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig)) return null;
            out.push({ pubkey: pubkey, sig: sig });
        }
        return out;
    }

    // Hold a row whose request this hub cannot resolve yet, for exactly one retry.
    _park(row){
        let key = row.network + '|' + row.request_id;
        // One entry per logical row: several peers gossiping the same unknown request
        // must buy it one retry, not one retry each.
        if(this._parked.has(key)) return;
        if(this._parked.size >= PARK_MAX){
            let oldest = this._parked.keys().next().value;
            this._parked.delete(oldest);
            this.stats.dropped++;
            console.warn('AttestationResponseMirror: park set full (' + PARK_MAX +
                         '); dropped the oldest entry to admit ' + row.request_id.substring(0, 16) + '...');
        }
        this._parked.set(key, { row: row, parkedAt: Date.now() });
        this.stats.parked++;
    }

    // One park cycle. Every entry is removed from the set BEFORE its retry runs, so a
    // row gets exactly one second chance whatever the retry does and the set cannot
    // accumulate across cycles.
    async _drainParked(){
        if(this._parked.size === 0) return;
        let entries = Array.from(this._parked.values());
        this._parked.clear();
        for(let entry of entries){
            try {
                await this._ingestGossipRow(entry.row, false);
            } catch (e){
                this.stats.errors++;
                console.error('AttestationResponseMirror: parked retry failed for ' +
                              entry.row.request_id.substring(0, 16) + '...: ' +
                              (e && e.message ? e.message : e));
            }
        }
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
module.exports.ATTEST_RESULT = ATTEST_RESULT;
module.exports.GOSSIP_COLUMNS = GOSSIP_COLUMNS;
module.exports.PARK_MAX = PARK_MAX;
module.exports.PARK_RETRY_MS = PARK_RETRY_MS;
