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
 * AttestationResponseMirror: the producer write
 *
 * Materializes a mirror row from a finalized round and writes and streams it: the
 * one write path both the consensus listener and the gossip receiver share.
 * Installed on AttestationResponseMirror.prototype by
 * src/attestation/response_mirror.js.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { TERMINAL_STATUSES } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The 'request:finalized' listener's body, called from the arrow start() attaches.
    handleFinalized(event){
        // SYNCHRONOUS materialization, before any await: see the header note on
        // the 10-second `pending` eviction. Everything the row needs is copied
        // out of the payload here, in the emitter's own tick.
        let row;
        try {
            row = this.buildRow(event);
        } catch (err) {
            this.stats.errors++;
            logger.error('AttestationResponseMirror: row build failed for ' +
                          this.shortRid(event) + ': ' + (err && err.message ? err.message : err));
            return;
        }
        if(!row) return;
        this.insertAndBroadcast(row).then(inserted => {
            // GOSSIP ONLY A NEW LOCAL INSERT, and only from THIS path. The
            // artifact leaves this hub exactly once per finalized round: the
            // duplicate path (a retry round re-finalizing the same request)
            // sends nothing, and the gossip RECEIVER never re-sends at all
            // (see ingestGossipRow). With every responsible hub finalizing
            // the same round independently, one hop per producer is already
            // full coverage of the federation, while forwarding on receipt
            // would multiply one artifact by the peer count on every hop and
            // let a Byzantine peer amplify at no cost.
            if(inserted) this.gossipRow(row);
        }).catch(err => {
            this.stats.errors++;
            logger.error('AttestationResponseMirror: mirror write failed for ' +
                          String(row.request_id).substring(0, 16) + '...: ' +
                          (err && err.message ? err.message : err));
        });
    },

    // Materialize a mirror row from a 'request:finalized' payload, or null when this
    // round is not one the mirror carries. Pure and synchronous by contract: it
    // touches no DB and no clock beyond nowSeconds, so the caller can run it inside
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
        if(!this.isMirrorEra(requestBlock)) return null;

        let rid = String(event.requestId).toLowerCase();
        let status = String(event.status || 'ok');
        if(!TERMINAL_STATUSES.has(status)){
            this.stats.skipped++;
            logger.info('AttestationResponseMirror: skipping non-terminal round ' + rid.substring(0, 16) +
                        '... (status=' + status + '); retryable rounds are deliberately not mirrored');
            return null;
        }

        let sigs = this.sortedSignatures(event);
        if(sigs.length === 0){
            // A row with no signatures is inert on every indexer (the verifier
            // resolves no quorum), so writing it would only put an unappliable row
            // in the stream and in the on-chain batch.
            this.stats.skipped++;
            logger.warn('AttestationResponseMirror: no signatures in finalized event for ' +
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
            logger.error('AttestationResponseMirror: mirror-era round ' + rid.substring(0, 16) +
                          '... (block ' + requestBlock + ') carries no signed effective_time; refusing to write ' +
                          'a row no verifier could rebuild');
            return null;
        }

        let body = event.responseBody;
        let bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');

        return this.mirrorRowFrom(event, rid, requestBlock, status, sigs, effectiveTime, bodyBytes);
    },

    // CANONICAL ORDER, by pubkey. AttestationConsensus hands these over in the order
    // the signatures ARRIVED at this hub (a Map walked in insertion order), and that
    // order differs hub to hub for the same quorum. Everything downstream that
    // compares rows across hubs compares these two JSON columns byte for byte: the
    // batch co-sign (`matchesLocalWindow`, ATTEST_BATCH_ROW_FIELDS) refused every
    // window carrying a real response on the regtest ladder with `differs on
    // signer_pubkeys` while all four responsible hubs held the same three signers
    // (2026-09-05, AT5). Sorting here keeps the pubkey-at-index-i-signed-signature-
    // at-index-i pairing intact, and the indexer verifies the pairs as a set.
    sortedSignatures(event){
        let sigs = Array.isArray(event.signatures) ? event.signatures : [];
        return sigs.slice().sort((a, b) => {
            let pa = String(a && a.pubkey).toLowerCase(), pb = String(b && b.pubkey).toLowerCase();
            return pa < pb ? -1 : (pa > pb ? 1 : 0);
        });
    },

    // The row itself, once every reason not to write one has been ruled out.
    mirrorRowFrom(event, rid, requestBlock, status, sigs, effectiveTime, bodyBytes){
        return {
            network:              String(this.hub && this.hub.network),
            request_id:           rid,
            // Ordering aid only, and informational at that: the applier re-derives
            // both from its own local v0 request row rather than trusting the wire.
            request_action_index: this.intOrNull(event.request && event.request.action_index),
            request_block_index:  this.intOrNull(requestBlock),
            provider_id:          String(event.providerId == null ? '' : event.providerId),
            status:               status,
            // Stored decoded as UTF-8, exactly as attests.response_payload is on the
            // on-chain path, so the applier's row is shaped like a v1's.
            response_payload:     bodyBytes.toString('utf8'),
            // Over the BYTES the signatures cover, computed the same way
            // AttestationConsensus.buildCanonical computes it. Not over the decoded
            // string above: for a body that is valid UTF-8 the two coincide, and for
            // one that is not, this field stays honest about what was signed and the
            // row is inert on every node identically instead of forking one.
            response_hash:        crypto.createHash('sha256').update(bodyBytes).digest('hex'),
            meta:                 event.meta == null ? '' : String(event.meta),
            effective_time:       effectiveTime,
            // The admission height the signatures cover, stored verbatim from the round.
            // Null is the LEGACY row and it binds by effective_time at every height, which
            // is why it is stored as null rather than as a 0 an indexer would read as
            // "admissible at genesis". Attest responses are read by BTC alone, so one column.
            admit_block_btc:      (event.admitBlocks && event.admitBlocks.BTC != null)
                                      ? Number(event.admitBlocks.BTC) : null,
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
            widen:                Math.max(0, this.intOrNull(event.widen) || 0),
            // Hub wall clock at quorum. AUDIT ONLY: never a consensus input, never
            // compared across hubs, and deliberately the one column two hubs' copies
            // of the same logical row are allowed to disagree on (alongside `id`).
            finalized_at:         this.nowSeconds()
        };
    },

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
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function'){
            this.stats.errors++;
            logger.warn('AttestationResponseMirror: no hub DB; dropping mirror row for ' +
                         String(row.request_id).substring(0, 16) + '...');
            return false;
        }

        // INSERT IGNORE against the UNIQUE (network, request_id, effective_time). A
        // duplicate is ordinary traffic rather than an error: two hubs in the responsible
        // set both finalize, each gossips, and a parked envelope retries a cycle later,
        // so the same logical row can arrive several ways. Insert-only means the existing
        // row is already correct, so absorbing the duplicate is the whole conflict policy.
        //
        // A row for a request this hub already holds under a DIFFERENT effective_time is
        // not a duplicate: it is the second honest finalization of a round that ran
        // under two leader slots (the slot follows the chain tip each hub polled), and
        // it is kept so every hub ends up holding every variant. The indexer binds the
        // smaller stamp on every node; see the table's SQL for the full argument.
        let res = await db.createAttestationResponseMirrorRow(row);
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
        let rows = await db.getAttestationResponseMirrorRow(row.network, row.request_id, row.effective_time);
        let stored = (rows && rows.length) ? rows[0] : null;
        if(!stored){
            this.stats.errors++;
            logger.error('AttestationResponseMirror: wrote ' + String(row.request_id).substring(0, 16) +
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
            let b = this.broadcaster();
            if(b && typeof b.broadcastRow === 'function')
                b.broadcastRow({ table: 'attestation_responses', row: stored });
        }
        return inserted;
    }

};
