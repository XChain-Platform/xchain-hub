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
 * XChain Hub - Attestation Consensus Wire
 *
 * What this engine accepts off the gossip wire and what it puts back on it: the
 * per-round body ceiling every inbound envelope is measured against, the short
 * tag caps beside it, and the one outbound vote shape a settled round sends.
 *
 ********************************************************************/

'use strict';
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ATTEST_PROPOSE, ATTEST_PREPARE, ATTEST_COMMIT } = require('./constants.js');

// Cap for the inbound `meta` and `status` fields on PROPOSE/PREPARE envelopes,
// mirroring the body_b64 cap: both are short tags (meta a provider tag, HTTP
// status code or LLM model id; status one of 'ok', 'provider_error',
// 'no_quorum'), so anything longer is adversarial padding that would otherwise
// be stored, hashed into the canonical, and re-broadcast unbounded.
const ATTEST_META_MAX_LENGTH   = 256;

module.exports = {

    _handleMessage(envelope){
        switch(envelope.type){
            case ATTEST_PROPOSE: this._handlePropose(envelope); break;
            case ATTEST_PREPARE: this.handlePrepare(envelope); break;
            case ATTEST_COMMIT:  this._handleCommit(envelope);  break;
        }
    },

    // Maximum allowed base64 length for a peer-supplied body, derived from the
    // provider's configured max_response_bytes (x1.4 base64 expansion factor).
    // The only transport gate on an incoming PROPOSE/PREPARE is the WebSocket
    // frame limit (~1 MB), which is 22-46x larger than any legitimate provider
    // response, so a peer could otherwise force multi-hundred-KB Buffer
    // allocations per message. Falls back to a 64 KB cap when the provider def
    // or its max_response_bytes is unavailable.
    maxBodyB64Length(providerId){
        let def      = this.providerRegistry.getDef(providerId);
        let maxBytes = (def && Number(def.max_response_bytes)) || 65536;
        return Math.ceil(maxBytes * 1.4);
    },

    // Body cap for THIS round, pinned once at propose() from the same provider
    // def the round fetched under, so the acceptance predicate cannot move
    // between two messages of one round. Reading max_response_bytes live per
    // message let a governance hotReload (which re-parses every def on every
    // proposal:finalized event, whatever the proposal was about) lower the cap
    // mid-round: this hub's own proposal is inserted directly and bypasses the
    // gate, so it would then reject the byte-identical bodies its honest peers
    // sent and stall the round to timeout. Falls back to the live read when the
    // round state carried no cap, which keeps the gate exactly as it was.
    bodyB64Limit(pending){
        return pending.maxBodyB64Length || this.maxBodyB64Length(pending.providerId);
    },

    // Reject oversized payloads before allocating a Buffer. A responsible
    // peer could otherwise craft a body_b64 up to the WebSocket frame limit,
    // far larger than the provider's configured response cap.
    //
    // Same cap for `status`, and for the same reason: it is a short outcome
    // tag ('ok', 'provider_error', 'no_quorum'), it is hashed into the
    // canonical the caller verifies, stored verbatim for the round's lifetime, and
    // concatenated into the A-F4 candidate key, so an uncapped one is
    // adversarial padding on every surface `meta` is capped against.
    envelopeWithinCaps(pending, d, phase, senderPubkey, rid){
        if(String(d.body_b64 || '').length > this.bodyB64Limit(pending)){
            logger.warn('AttestationConsensus: oversized ' + phase + ' body from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected pre-decode)');
            return false;
        }
        if(String(d.meta || '').length > ATTEST_META_MAX_LENGTH){
            logger.warn('AttestationConsensus: oversized ' + phase + ' meta from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return false;
        }
        if(String(d.status || '').length > ATTEST_META_MAX_LENGTH){
            logger.warn('AttestationConsensus: oversized ' + phase + ' status from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return false;
        }
        return true;
    },

    // The outbound PREPARE or COMMIT of a round whose winner is settled. One
    // shape for every sender, because what a vote carries is the ROUND's own
    // winner, status and stamp, never the caller's copy of them.
    broadcastWinnerVote(type, rid, pending, sig){
        this.peerManager.broadcast(type, {
            requestId:  rid,
            providerId: pending.providerId,
            body_b64:   pending.winner.body.toString('base64'),
            meta:       String(pending.winner.meta || ''),
            status:     pending.status,
            sig_pubkey: pending.myPubkey,
            sig:        sig,
            ...this.effectiveTimeWireFields(pending)
        });
    }

};
