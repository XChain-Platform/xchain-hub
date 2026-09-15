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
 * AttestationResponseMirror: ATTEST_RESULT gossip
 *
 * Sends a new local row to the federation once, and on receipt shapes, dedupes,
 * resolves, parks and ingests a peer's row. Installed on
 * AttestationResponseMirror.prototype by src/attestation/response_mirror.js.
 *
 ********************************************************************/

'use strict';

const axios = require('axios');
const { ATTEST_RESPONSE_BODY_MAX_BYTES, bodyByteLength } = require('../attest_response_body_cap.js');
const { TERMINAL_STATUSES, ATTEST_RESULT, GOSSIP_COLUMNS, PARK_MAX, REQUEST_LOOKUP_LIMIT } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

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
    gossipRow(row){
        let pm = this.hubPeerManager();
        if(!pm || typeof pm.broadcast !== 'function') return;
        let data = {};
        for(let c of GOSSIP_COLUMNS) data[c] = row[c];
        pm.broadcast(ATTEST_RESULT, data);
        this.stats.gossiped++;
    },

    // The engine's inbound switch. One case, per §3.3.
    handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case ATTEST_RESULT:
                this.handleResult(envelope).catch(e =>
                    logger.error('AttestationResponseMirror: ATTEST_RESULT error: ' +
                                  (e && e.message ? e.message : e)));
                break;
        }
    },

    async handleResult(envelope){
        this.stats.received++;
        let row = this.parseGossipRow(envelope.data);
        if(!row){
            this.stats.rejected++;
            return;
        }
        await this.ingestGossipRow(row, true);
    },

    // Shape the wire payload into a row this hub could store, or null. Structural
    // only: this rejects what cannot be a row at all (wrong network, malformed id,
    // a status the table does not carry) so the expensive checks downstream are
    // never reached by junk. It establishes NOTHING about truth; that is the
    // verifier's job.
    parseGossipRow(d){
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
        if(this.parseSigList(d.signatures) === null) return null;
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

        return this.gossipRowFrom(d, network, rid, status, effectiveTime, responseHash,
                                  signerPubkeys, providerId, payload);
    },

    // The row a structurally sound payload becomes. Every field is either the sender's,
    // restated from local state later, or this hub's own clock.
    gossipRowFrom(d, network, rid, status, effectiveTime, responseHash, signerPubkeys, providerId, payload){
        return {
            network:              network,
            request_id:           rid,
            // Informational, and overwritten from this hub's own request row once it
            // resolves (see ingestGossipRow). Accepted here only as the cursor hint
            // resolveLocalRequest uses.
            request_action_index: this.intOrNull(d.request_action_index),
            request_block_index:  this.intOrNull(d.request_block_index),
            provider_id:          providerId,
            status:               status,
            response_payload:     payload,
            response_hash:        responseHash,
            meta:                 d.meta == null ? '' : String(d.meta),
            effective_time:       effectiveTime,
            // From the wire, and NOT coerced: Number(null) and Number('') are both 0, a
            // finite height that would make the row admissible at the first block every
            // indexer already has. Anything that is not a non-negative safe integer is
            // stored as null, which is the legacy row and binds by effective_time. The
            // verifier re-checks it as part of the canonical, so a lying sender only
            // produces a row whose signatures do not verify.
            admit_block_btc:      this.heightOrNull(d.admit_block_btc),
            signer_pubkeys:       signerPubkeys,
            signatures:           String(d.signatures == null ? '' : d.signatures),
            // TINYINT UNSIGNED, and purely informational: the verifier recomputes the
            // widening step from the request's own block, so this is clamped rather
            // than checked.
            widen:                Math.max(0, Math.min(255, this.intOrNull(d.widen) || 0)),
            // OUR clock, not the sender's. This column means "when this hub came to
            // hold the row", it is never a consensus input, and the two hubs are
            // explicitly allowed to disagree on it.
            finalized_at:         this._nowSeconds()
        };
    },

    // Judge one received row and, if it holds up, write it. Returns true iff this
    // call newly inserted it.
    //
    // `allowPark` is false on the retry pass, which is what makes the retry happen
    // exactly ONCE: an entry drained from the park set can no longer re-park itself.
    async ingestGossipRow(row, allowPark){
        let short = row.request_id.substring(0, 16) + '...';

        // Cheapest gate first, and it is the one that carries the storm. Five hubs
        // finalize and gossip the same artifact, so most deliveries are of a row this
        // hub already holds. The table is insert-only and unique on (network,
        // request_id, effective_time), so a row we hold is a row we already verified and
        // nothing about it can have changed: answering from the index costs one keyed
        // read and spends no capability snapshot, no indexer round-trip and no signature
        // math. A second variant of a request this hub holds (a different signed stamp,
        // from a round that finalized under another leader slot) is NOT held, and takes
        // the full verification below like any first delivery.
        if(await this.alreadyHeld(row)){
            this.stats.duplicates++;
            return false;
        }

        // THE REQUEST IS LOCAL STATE OR IT IS NOTHING. Every height the verification
        // turns on comes from this row, never from the wire: an untrusted hub that
        // could name the block its signatures are checked at could name a block at
        // which it controlled the responsible set.
        let local = await this.resolveLocalRequest(row);
        if(!local){
            this.parkOrDrop(row, allowPark, short);
            return false;
        }

        let request = local.request;
        let declaredBlock = Number(request.block_index);

        if(!this.mirrorEraRequest(declaredBlock, short)) return false;

        let verdict = await this.verifyGossipedRow(row, request, local.latestBlock);
        if(!verdict.ok){
            this.stats.rejected++;
            logger.warn('AttestationResponseMirror: dropping gossiped row ' + short +
                         '; ' + verdict.error);
            return false;
        }

        // The two informational columns are re-stated from the local request rather
        // than kept as the sender wrote them. They are ordering aids the applier
        // re-derives anyway, so a lie in them is inert either way, but the local
        // values are the same on every honest node, so taking them makes two hubs'
        // copies of one logical row converge instead of diverge, which is what the
        // on-chain batch body (§6.1) puts on chain.
        row.request_block_index  = this.intOrNull(request.block_index);
        row.request_action_index = this.intOrNull(request.action_index);

        // insertAndBroadcast streams the row to THIS hub's WS subscribers on a fresh
        // insert, which is the whole point: an indexer following a hub outside the
        // responsible set gets the artifact only through here. What it deliberately
        // does not do is send another ATTEST_RESULT. A received row is not re-gossiped
        // because every hub is already one hop from every producer, so forwarding adds
        // no reach and turns one artifact into a fan-out per peer per hop.
        return await this.insertAndBroadcast(row);
    },

    // A row whose local v0 request has not turned up: parked for its one retry, or
    // dropped when this IS the retry. The periodic on-chain batch is the backstop.
    parkOrDrop(row, allowPark, short){
        if(allowPark){
            this.park(row);
            return;
        }
        this.stats.dropped++;
        logger.warn('AttestationResponseMirror: dropping gossiped row ' + short +
                     ' after one parked retry; this hub still holds no v0 request for it. ' +
                     'The periodic on-chain batch is the backstop.');
    },

    // The era gate, read off the LOCAL request exactly as the producer path reads
    // it off the round's own request. A legacy-era request's response is an
    // on-chain v1; a mirror row for one would be a second delivery under a
    // canonical its signatures do not cover.
    mirrorEraRequest(declaredBlock, short){
        if(this.isMirrorEra(declaredBlock)) return true;
        this.stats.rejected++;
        logger.warn('AttestationResponseMirror: dropping gossiped row ' + short +
                     '; its local request at block ' + declaredBlock + ' is legacy-era');
        return false;
    },

    // Does this hub already hold the row? One keyed read on the UNIQUE index.
    async alreadyHeld(row){
        let db = this._db();
        if(!db || typeof db.doQuery !== 'function') return false;
        let rows = await db.getAttestationResponse(row.network, row.request_id, row.effective_time);
        return !!(rows && rows.length);
    },

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
    async resolveLocalRequest(row){
        let hub = this.hub;
        if(!hub || typeof hub.resolveBtcIndexerUrl !== 'function') return null;
        let url = await hub.resolveBtcIndexerUrl();
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
            }, { headers: hub.btcIndexerHeaders(), timeout: 5000 });
        } catch (e){
            logger.warn('AttestationResponseMirror: request lookup failed for ' +
                         row.request_id.substring(0, 16) + '...: ' + (e && e.message ? e.message : e));
            return null;
        }

        let result = res && res.data && res.data.result;
        if(!result || result.error) return null;
        let requests = Array.isArray(result.requests) ? result.requests : [];
        let request  = requests.find(r => String((r && r.request_id) || '').toLowerCase() === row.request_id);
        if(!request) return null;
        return { request: request, latestBlock: Number(result.latest_block_index) || 0 };
    },

    // Hold a row whose request this hub cannot resolve yet, for exactly one retry.
    park(row){
        let key = row.network + '|' + row.request_id;
        // One entry per logical row: several peers gossiping the same unknown request
        // must buy it one retry, not one retry each.
        if(this._parked.has(key)) return;
        if(this._parked.size >= PARK_MAX){
            let oldest = this._parked.keys().next().value;
            this._parked.delete(oldest);
            this.stats.dropped++;
            logger.warn('AttestationResponseMirror: park set full (' + PARK_MAX +
                         '); dropped the oldest entry to admit ' + row.request_id.substring(0, 16) + '...');
        }
        this._parked.set(key, { row: row, parkedAt: Date.now() });
        this.stats.parked++;
    },

    // One park cycle. Every entry is removed from the set BEFORE its retry runs, so a
    // row gets exactly one second chance whatever the retry does and the set cannot
    // accumulate across cycles.
    async drainParked(){
        if(this._parked.size === 0) return;
        let entries = Array.from(this._parked.values());
        this._parked.clear();
        for(let entry of entries){
            try {
                await this.ingestGossipRow(entry.row, false);
            } catch (e){
                this.stats.errors++;
                logger.error('AttestationResponseMirror: parked retry failed for ' +
                              entry.row.request_id.substring(0, 16) + '...: ' +
                              (e && e.message ? e.message : e));
            }
        }
    }

};
