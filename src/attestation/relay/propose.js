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
 * XChain Hub - Attestation cross-chain relay: proposing a leg
 *
 * Decides whether a request leg (origin to BTC, v3) or a response leg (BTC to origin,
 * v4) is owed, projects the origin or home row onto the fields the round signs, and
 * proposes the PBFT round. Installed on AttestationRelay.prototype by
 * src/attestation/relay.js.
 *
 ********************************************************************/

'use strict';

const crypto      = require('crypto');
const attestRelay = require('../../attest_relay_activation.js');
const { HOME_CHAIN, ORIGIN_CHAINS, RELAYABLE_STATUSES } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The response leg's entry guards, in the order they ran inline and still without
    // an await between them: the row names an origin chain this hub polls, that origin
    // still holds the request, its deadline is indexed before any already-relayed
    // return, and the BTC response is buried deep enough to be irreversible. Returns
    // the values the round is built from, or null when this row is not one to relay on
    // this tick.
    responseLegCandidate(latestHomeBlock, res){
        let rid = String(res.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(rid)) return null;

        let coin = String(res.origin_chain || '');
        if(ORIGIN_CHAINS.indexOf(coin) === -1) return null;
        if(!this.indexers[coin] || !this.indexers[coin].url) return null;

        // The origin must still be waiting for it. A refresh that failed leaves the
        // set null, and a null set is not evidence of anything, so the chain waits a
        // tick rather than being relayed to blind.
        let pending = this._originPending[coin];
        if(!pending || !pending.has(rid)) return null;
        let originReq = pending.get(rid);

        // Index the origin's ABSOLUTE deadline BEFORE the already-relayed guards below.
        // Eviction can only forget a record it holds a deadline for, and the
        // record most in need of forgetting is precisely one already marked published:
        // indexing after those returns would leave every relayed leg pinned forever.
        this.noteDeadline(coin, rid, originReq && originReq.deadline_block);

        // Same horizon, same reason as the request leg, and here it also saves a real
        // fee outright: the origin indexer rejects a v4 for a request past its own
        // deadline_block ('invalid: REQUEST expired'), so the broadcast could only burn.
        if(this.pastEvictionHorizon(coin, originReq && originReq.deadline_block)) return null;

        if(this._publishedResponses.has(rid)) return null;
        if(this._finalizedResponse.has(rid)) return null;

        // BTC confirmation depth on the RESPONSE row, not the request. The v4 closes
        // the origin request irreversibly, so relaying a response that a BTC reorg can
        // still take back would leave the origin settled against a fulfillment the
        // home chain no longer has.
        let depth = latestHomeBlock - Number(res.response_block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[HOME_CHAIN]) return null;

        let roundId = this._roundId('response', rid);
        if(this._inflight.has(roundId)) return null;

        return { rid: rid, coin: coin, originReq: originReq, roundId: roundId };
    },

    async maybeRelayResponse(latestHomeBlock, res){
        let leg = this.responseLegCandidate(latestHomeBlock, res);
        if(!leg) return;

        let snapshotBlock = await this.resolveSnapshotBlock();
        if(snapshotBlock == null) return;
        if(!attestRelay.isAttestRelayActive(snapshotBlock, this.network)){
            this.logGateOnce(snapshotBlock);
            return;
        }

        let row = this.responseRoundRow(leg, snapshotBlock, res);
        if(!row) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(leg.roundId);
        try {
            await this.consensus.propose(leg.roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(leg.roundId);
            throw e;
        }
    },

    // The v4 round row, or null when the response cannot be relayed faithfully: the
    // home fields must project onto the wire, the two chains must agree on the
    // provider, and the assembled wire must fit. Synchronous, so nothing can change
    // between the checks and the row they admit.
    responseRoundRow(leg, snapshotBlock, res){
        let rid  = leg.rid;
        let coin = leg.coin;
        let originReq = leg.originReq;

        let fields = this.responseFieldsFromHome(res);
        if(!fields) return null;

        // The origin indexer builds its canonical from ITS OWN request row's
        // provider_id, so the two copies must agree or every peer refuses the round
        // and it wedges silently. They agree by construction (the v3 carried the
        // provider from the origin), which is exactly why a disagreement is worth
        // saying out loud rather than proposing into a round that cannot finalize.
        if(originReq && String(originReq.provider_id || '') !== fields.providerId){
            logger.error('AttestationRelay: refusing to relay ' + rid.substring(0, 16) +
                          '...: ' + coin + ' names provider "' + originReq.provider_id +
                          '" but ' + HOME_CHAIN + ' holds "' + fields.providerId + '"');
            return null;
        }

        let row = {
            round_id:                   leg.roundId,
            request_id:                 rid,
            phase:                      'response',
            snapshot_block:             Number(snapshotBlock),
            network:                    this.network,
            origin_chain:               coin,
            // The operator's proposal-A record-shape change. The home chain's
            // relayed-request row carries no deadline of its own (the v3 put a RELATIVE
            // block count on BTC), so the origin's absolute deadline_block travels on the
            // round row, paired with the origin_chain it is a height on. It is BOOKKEEPING,
            // NOT CONSENSUS: it is deliberately absent from relayResponseCanonical, which
            // must byte-match the indexer's, and every follower re-derives it from its own
            // origin indexer instead of trusting the leader's copy.
            origin_deadline_block:      this.absoluteOriginDeadline(originReq),
            home_response_action_index: fields.homeResponseActionIndex,
            provider_id:                fields.providerId,
            response_hash:              fields.responseHash,
            response_payload_b64:       fields.payloadB64,
            status:                     fields.status,
            meta:                       fields.meta
        };

        let wireFault = this.wireFault(row, 1);
        if(wireFault){
            logger.error('AttestationRelay: cannot relay the response for ' + rid.substring(0, 16) + '... : ' + wireFault);
            return null;
        }

        return row;
    },

    // Project a home relayable-response row onto the v4 wire fields, or null when the
    // response cannot be relayed faithfully.
    //
    // THE BODY MUST SURVIVE A ROUND TRIP. The indexer stores response_payload as the
    // UTF-8 DECODE of the bytes the v1 carried and hashes those raw bytes, so a
    // non-UTF-8 attested body cannot be re-encoded to the same bytes: base64 of the
    // stored text would deliver a MANGLED payload to the origin contract, under a
    // quorum signature. The stored response_hash is what makes that detectable, and a
    // mismatch refuses the relay outright. Such a request expires on the origin's own
    // deadline, which is the honest outcome.
    responseFieldsFromHome(res){
        let homeResponseActionIndex = Number(res.response_action_index);
        let providerId              = String(res.provider_id || '');
        let status                  = String(res.response_status || '');
        let meta                    = (res.meta == null) ? '' : String(res.meta);
        let payload                 = (res.response_payload == null) ? '' : String(res.response_payload);

        if(!Number.isInteger(homeResponseActionIndex) || homeResponseActionIndex <= 0) return null;
        if(!providerId) return null;
        if(RELAYABLE_STATUSES.indexOf(status) === -1) return null;

        let bytes        = Buffer.from(payload, 'utf8');
        let payloadB64   = bytes.toString('base64');
        let responseHash = crypto.createHash('sha256').update(bytes).digest('hex');

        let stored = String(res.response_hash || '').toLowerCase();
        if(stored && stored !== responseHash){
            logger.error('AttestationRelay: refusing to relay ' + String(res.request_id).substring(0, 16) +
                          '...: the stored response body does not re-encode to its own hash ' +
                          '(a non-UTF-8 attested body cannot cross chains)');
            return null;
        }

        return { homeResponseActionIndex, providerId, status, meta, payloadB64, responseHash };
    },

    // The request leg's entry guards, in the order they ran inline and still without an
    // await between them. Returns the values the round is built from, or null when this
    // origin row is not one to materialize on this tick.
    requestLegCandidate(coin, latestBlock, req){
        let rid = String(req.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(rid)) return null;

        // Only a request this chain admitted FOR RELAY is ours to materialize. A
        // native request on an origin chain (there are none today, since an empty
        // responsible set rejects it at admission) carries no origin_chain stamp.
        if(String(req.origin_chain || '') !== coin) return null;

        // Index the absolute deadline BEFORE the already-relayed guards, for the reason
        // spelled out in responseLegCandidate: the record that most needs evicting is one
        // this node has already published, and those returns are hit on every later tick.
        this.noteDeadline(coin, rid, req.deadline_block);

        // Never materialize a request whose deadline the origin has already buried. This
        // is the same horizon eviction uses, and it is what makes eviction safe: a
        // forgotten key cannot come back through this path and spend a second fee. The
        // request is dead anyway (the origin's expiry sweep is simply behind).
        if(this.pastEvictionHorizon(coin, req.deadline_block)) return null;

        if(this._published.has(rid)) return null;
        if(this.homeHasRequest(rid)) return null;
        if(this._finalizedWire.has(rid)) return null;

        let depth = latestBlock - Number(req.block_index) + 1;
        if(!Number.isFinite(depth) || depth < this.confirmations[coin]) return null;

        let roundId = this._roundId('request', rid);
        if(this._inflight.has(roundId)) return null;

        return { rid: rid, coin: coin, roundId: roundId };
    },

    async maybeMaterialize(coin, latestBlock, req){
        let leg = this.requestLegCandidate(coin, latestBlock, req);
        if(!leg) return;

        let snapshotBlock = await this.resolveSnapshotBlock();
        if(snapshotBlock == null) return;

        // The flag-day gate, evaluated on the BTC-anchored snapshot we are about to
        // pin. Below it the fleet's indexers reject a v3 outright, so proposing a
        // round would only burn a BTC fee on a guaranteed-invalid action.
        if(!attestRelay.isAttestRelayActive(snapshotBlock, this.network)){
            this.logGateOnce(snapshotBlock);
            return;
        }

        let row = this.requestRoundRow(leg, snapshotBlock, req);
        if(!row) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);
        this._inflight.add(leg.roundId);
        try {
            await this.consensus.propose(leg.roundId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(leg.roundId);
            throw e;
        }
    },

    // The v3 round row, or null when the origin request cannot be represented on the
    // wire. Synchronous, so nothing can change between the checks and the row they
    // admit.
    requestRoundRow(leg, snapshotBlock, req){
        let rid  = leg.rid;
        let coin = leg.coin;

        let fields = this.relayFieldsFromOrigin(coin, req);
        if(!fields) return null;

        let row = {
            round_id:            leg.roundId,
            request_id:          rid,
            phase:               'request',
            snapshot_block:      Number(snapshotBlock),
            network:             this.network,
            origin_chain:        coin,
            origin_action_index: fields.originActionIndex,
            provider_id:         fields.providerId,
            request_payload:     fields.requestPayload,
            redundancy:          fields.redundancy,
            deadline_blocks:     fields.deadlineBlocks
        };

        // Reject here rather than after finalization: the wire is assembled from the
        // signed fields, so an oversized or unsplittable payload dooms the round.
        let wireFault = this.wireFault(row, 1);
        if(wireFault){
            logger.error('AttestationRelay: cannot materialize ' + rid.substring(0, 16) + '... : ' + wireFault);
            return null;
        }

        return row;
    },

    // Project an origin pending-request row onto the v3 wire fields, or null when it
    // cannot be represented. DEADLINE travels as a BLOCK COUNT because the BTC-side
    // deadline must be relative to the v3's own BTC height; the origin's absolute
    // deadline_block is a height on a different chain. The count is NOT rescaled for
    // the chains' differing block intervals: the indexer's provider deadline window
    // is the authority on what BTC-side span is acceptable and rejects the rest.
    relayFieldsFromOrigin(coin, req){
        let originActionIndex = Number(req.action_index);
        let redundancy        = Number(req.redundancy);
        let deadlineBlocks    = Number(req.deadline_block) - Number(req.block_index);
        let providerId        = String(req.provider_id || '');
        let requestPayload    = (req.payload == null) ? '' : String(req.payload);

        if(!Number.isInteger(originActionIndex) || originActionIndex <= 0) return null;
        if(!Number.isInteger(redundancy) || redundancy < 1) return null;
        if(!Number.isInteger(deadlineBlocks) || deadlineBlocks <= 0) return null;
        if(!providerId) return null;

        return { originActionIndex, redundancy, deadlineBlocks, providerId, requestPayload };
    },

    // ----- helpers -----

    logGateOnce(snapshotBlock){
        if(this._gateLogged) return;
        this._gateLogged = true;
        logger.info('AttestationRelay: ATTEST_RELAY_ACTIVATION not reached on ' + this.network +
                    ' (BTC ' + snapshotBlock + '); relay-eligible origin requests are held, nothing is broadcast');
    },

    async resolveSnapshotBlock(){
        return this.hub.resolveBtcLatestBlock ? await this.hub.resolveBtcLatestBlock() : null;
    }

};
