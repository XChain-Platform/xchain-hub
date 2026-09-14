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
 * XChain Hub - Attestation Publisher: the durable at-most-once marker
 *
 * The attest_published_requests marker that survives a restart: publication
 * identity, intent and sent records, startup hydration and quarantine, and the gate
 * consulted before every spend. Installed on AttestationPublisher.prototype by
 * src/attestation/publisher.js.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ----- Durable at-most-once marker (attest_published_requests) -----
    //
    // The WAL entry is removed only AFTER broadcaster() resolves and both in-process
    // guards die with the process, so a crash between an accepted send and the dequeue
    // leaves an entry the restart sweep cannot tell from a never-sent one: the request
    // is still in the indexer's PENDING set precisely because the tx has not been mined
    // yet. This table is the restart-surviving half of the guard, ported from
    // OraclePublisher's oracle_published_rounds. Resolved lazily off the hub so a
    // publisher constructed before the hub's DB is wired still sees it.
    _db(){ return (this.hub && this.hub.db) ? this.hub.db : null; },

    // Identity of one PUBLICATION, which is what the at-most-once guards actually
    // protect. A request id alone is the wrong identity: a non-ok response
    // (provider_error, no_quorum) is an advisory audit row that leaves the request
    // PENDING and RETRYABLE on the indexer, so the next round can finalize the same
    // request ok, and a request-keyed guard reads that ok as a duplicate and drops the
    // response the requester paid for.
    publicationKey(rid, status){ return rid + '|' + String(status || 'ok'); },

    // Statuses a marker row records as broadcast, or null when the row names none.
    // Null is NOT "nothing published": it is a row written before `sent_statuses`
    // existed, whose outcome is unrecorded, and every caller reads it as the whole
    // request being spoken for. That keeps an upgraded hub exactly as closed as it was.
    parseSentStatuses(value){
        if (value === null || value === undefined) return null;
        let list = String(value).split(',').map(s => s.trim()).filter(s => s.length > 0);
        return list.length > 0 ? new Set(list) : null;
    },

    // In-process half of the guard, over both key shapes: this publication, or a whole
    // request held by a pre-upgrade marker row.
    isPublishedInProcess(rid, status){
        return this._publishedRequests.has(rid)
            || this._publishedRequests.has(this.publicationKey(rid, status));
    },

    // Read the durable marker for a request, or null when none exists / no DB is wired.
    // Shape: { request_id, txid, sent_at, sent_statuses, intent_status }. A non-null
    // sent_at plus the status list is the authoritative "already broadcast" signal
    // (txid may legitimately be null when the broadcaster returns none, so sent_at,
    // not txid, gates re-broadcast). Throws on a DB error so the caller can FAIL CLOSED
    // rather than spend on an unproven request; a hub whose schema reconciliation has
    // not yet added the per-outcome columns lands here too, and defers rather than
    // spending against an identity it cannot read.
    async getPublishedMarker(rid){
        let db = this._db();
        if (!db) return null;
        let rows = await db.findAttestPublishedRequestsByRequestId(rid);
        return (rows && rows.length > 0) ? rows[0] : null;
    },

    // Durably record broadcast INTENT before the send, naming the status it is for.
    // Idempotent per publication, and it arms the intent on a row whose EARLIER
    // publication already completed, so a crash mid-send of a second response is
    // quarantined rather than replayed for a second fee. Throws on a DB error so the
    // caller fails closed. No-op when no DB is wired.
    async recordPublishIntent(rid, status){
        let db = this._db();
        if (!db) return;
        await db.setAttestPublishedRequest(rid, String(status || 'ok'));
    },

    // Durably record that the broadcast COMPLETED: add the status to the published set,
    // refresh txid + sent_at, and disarm the intent. The status list is extended in SQL
    // rather than read-modify-written, so two publishers racing the same row cannot
    // drop one another's status; FIND_IN_SET keeps a repeat append from growing the
    // column past its width. Logged, never thrown: the BTC fee is already spent, and
    // the surviving armed intent makes a restart QUARANTINE this publication instead of
    // re-broadcasting it, which is the fail-safe direction. No-op when no DB is wired.
    async markPublished(rid, txid, status){
        let db = this._db();
        if (!db) return;
        let st = String(status || 'ok');
        try {
            await db.updateAttestPublishedRequestByRequestId(txid || null, st, st, rid);
            // The table just grew by one confirmed row, which is the only thing the
            // retention sweep has to age out; arm it for the next sweep pass.
            this._markersAddedSinceSweep = true;
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: broadcast for %s... succeeded but its ' +
                'durable sent marker could not be persisted; a restart will QUARANTINE (not re-broadcast) this request. ' +
                'Operator: confirm the txid on-chain. Error:', String(rid).substring(0,16), e));
        }
    },

    // Startup reconciliation. Loads every completed publication into the in-process
    // guard so a queued-but-already-published response is never re-broadcast after a
    // restart, and QUARANTINES every unconfirmed one. Quarantine is scoped to the
    // status the crashed send was for, so an unresolved advisory row does not also
    // hold the ok response the request is still waiting for; a row naming no status at
    // all is pre-upgrade and holds the whole request, as it did before. Best-effort: a
    // DB error is logged and startup continues, leaving the in-process guard as the only
    // cover for this process lifetime (the behavior before this marker existed, never
    // worse).
    async hydratePublishedMarkers(){
        let db = this._db();
        if (!db) return;
        let rows = await db.findAllAttestPublishedRequests();
        let quarantined = [];
        for (let r of (rows || [])){
            let rid   = String(r.request_id).toLowerCase();
            let armed = (r.intent_status === null || r.intent_status === undefined) ? null : String(r.intent_status);
            if (r.sent_at !== null && r.sent_at !== undefined){
                let sent = this.parseSentStatuses(r.sent_statuses);
                if (sent === null){
                    this._publishedRequests.mark(rid);
                } else {
                    for (let s of sent) this._publishedRequests.mark(this.publicationKey(rid, s));
                }
            } else if (armed === null){
                this._quarantinedRequests.add(rid);
                quarantined.push(rid.substring(0,16) + '...');
            }
            if (armed !== null){
                this._quarantinedRequests.add(this.publicationKey(rid, armed));
                quarantined.push(rid.substring(0,16) + '... (' + armed + ')');
            }
        }
        if (quarantined.length > 0){
            logger.error('AttestationPublisher: ' + quarantined.length + ' publication(s) have a publish-intent marker ' +
                'with no confirmation (' + quarantined.join(', ') + '); their on-chain state is unknown after a crash. ' +
                'They will NOT be re-broadcast automatically (fail closed). Operator: verify each on-chain and replay ' +
                'manually if absent.');
        }
    },

    // Withdraw the armed intent for a send that DEFINITIVELY never went out (a pre-send
    // broadcaster rejection). Without this the routine failure becomes a permanent
    // quarantine on the next restart, which is worse than the replay risk the marker
    // exists to remove. Two statements because the row can outlive the intent: the
    // DISARM is scoped to the status we armed, so a concurrent publication's intent
    // survives, and the DELETE stays scoped `AND sent_at IS NULL` so a row carrying a
    // completed publication is never removed by a late or misordered call. Logged,
    // never thrown: leaving the intent is the fail-closed direction, so a failure here
    // only costs an operator replay.
    async clearPublishIntent(rid, status){
        let db = this._db();
        if (!db) return;
        try {
            await db.updateAttestPublishedRequestByRequestIdAndIntentStatus(rid, String(status || 'ok'));
            await db.deleteAttestPublishedRequest(rid);
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: could not withdraw the publish-intent marker for %s... ' +
                'after a definitive send failure; a restart will QUARANTINE it ' +
                'and it will need an operator replay. Error:', String(rid).substring(0,16), e));
        }
    },

    // Consult the durable marker before spending a BTC fee. READ-ONLY: it writes no
    // intent, because the caller may still decline to send after it
    // and an intent row for a request that was never sent is indistinguishable from a
    // crash-mid-send, so a restart would quarantine a perfectly replayable request.
    // Intent is armed by armPublishIntent once the send is actually committed to.
    // Answers for the PUBLICATION (request id plus response status), not for the
    // request: a request whose advisory failure row is already on chain is still
    // waiting for its ok response, and gating that ok on the failure's marker drops the
    // answer the requester paid for.
    //
    // Returns one of:
    //   'send'  - no marker for this status, or intent-only from THIS process; proceed
    //   'sent'  - already broadcast (durable status entry, or quarantined); drop, do not send
    //   'defer' - the marker could not be read; fail closed, leave the entry queued and
    //             retry on a later sweep
    // Marking the in-process guard on a 'sent' answer keeps the rest of the pass
    // consistent with a same-process duplicate.
    async durableSendGate(rid, status){
        let st = String(status || 'ok');
        if (this._quarantinedRequests.has(rid) || this._quarantinedRequests.has(this.publicationKey(rid, st))){
            logger.warn('AttestationPublisher: ' + rid.substring(0,16) + '... (' + st + ') is quarantined (publish intent ' +
                'recorded before a crash, on-chain state unknown); not re-broadcasting, awaiting operator replay');
            return 'sent';
        }
        if (!this._db()) return 'send';
        let marker;
        try {
            marker = await this.getPublishedMarker(rid);
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: cannot read the durable publish marker for %s...; deferring broadcast (fail closed to avoid a duplicate BTC spend):',
                rid.substring(0,16), e));
            return 'defer';
        }
        if (marker && marker.sent_at !== null && marker.sent_at !== undefined){
            // A row naming no statuses predates the per-outcome columns, so what it
            // published is unknown and it holds every status. An 'ok' entry is terminal
            // for every status too: the request is answered, and anything further is a
            // second paid response to a question already settled.
            let sent = this.parseSentStatuses(marker.sent_statuses);
            if (sent === null || sent.has(st) || sent.has('ok')){
                logger.warn('AttestationPublisher: ' + rid.substring(0,16) + '... (' + st + ') has a durable sent marker (txid ' +
                    (marker.txid || '<none>') + ', published ' + (sent === null ? '<unrecorded>' : Array.from(sent).join(',')) +
                    '); not re-broadcasting');
                this._publishedRequests.mark(this.publicationKey(rid, st));
                return 'sent';
            }
        }
        return 'send';
    },

    // Arm the durable intent immediately before the broadcast, and ONLY once every
    // remaining no-send exit is behind us (the spend reservation in particular: a
    // ceiling trip is a designed, routine state whose entry stays queued for a later
    // window, and an intent row would turn that into a quarantine). Returns false when
    // the intent cannot be persisted, which is a fail-closed defer: the caller hands the
    // reservation back and leaves the entry queued rather than spending a fee it could
    // not record.
    async armPublishIntent(rid, status){
        try {
            await this.recordPublishIntent(rid, status);
            return true;
        } catch (e) {
            logger.error(nodeUtil.format('AttestationPublisher: cannot record durable publish intent for %s...; deferring broadcast (fail closed):',
                rid.substring(0,16), e));
            return false;
        }
    }

};
