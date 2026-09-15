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
 * XChain Hub - Attestation cross-chain relay: canonical and wire bytes
 *
 * The v3 and v4 canonicals the quorum signs, the positional wires the legs broadcast,
 * the wire-fault screen that refuses an unrelayable row before a round starts, and the
 * round-id hashing. Installed on AttestationRelay.prototype by
 * src/attestation/relay.js.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const eq     = require('../../equivocation_header.js');
const { ATTEST_WIRE_MAX_BYTES } = require('./constants.js');

module.exports = {

    // Fields reach the chain through a positional `split('|')` with no escaping
    // (xchain-indexer/src/actions/index.js), so a literal pipe anywhere in a variable field
    // silently shifts every field after it. Such a request cannot be relayed at all;
    // it expires on its origin deadline, which is the honest outcome versus spending
    // a BTC fee on an action every indexer will misparse.
    wireFault(row, sigCount){
        let response = (row.phase === 'response');
        // v4 carries the body as base64, whose alphabet excludes '|', so only the
        // free-form META can shift the positional fields on that leg.
        let variable = response
            ? [['META', row.meta == null ? '' : row.meta]]
            : [['PROVIDER_ID', row.provider_id], ['REQUEST_PAYLOAD', row.request_payload]];
        for(let [name, value] of variable){
            if(String(value).indexOf('|') !== -1)
                return name + ' contains a "|", which the positional wire cannot carry';
        }
        let stub  = new Array(sigCount).fill({ pubkey: '0'.repeat(64), sig: '0'.repeat(128) });
        let wire  = response ? this.buildResponseWire(row, stub) : this.buildRequestWire(row, stub);
        let bytes = Buffer.byteLength(wire, 'utf8');
        if(bytes > ATTEST_WIRE_MAX_BYTES)
            return 'ATTEST v' + (response ? '4' : '3') + ' wire is ' + bytes + ' bytes with ' + sigCount +
                   ' signature(s), over the encoder limit of ' + ATTEST_WIRE_MAX_BYTES;
        return null;
    },

    // ----- canonical (the cross-service contract) -----

    // MUST byte-match the indexer's Attest.relayRequestCanonical /
    // relayResponseCanonical. A one-byte disagreement is not a visible failure: the
    // signatures simply never verify and every peer's v3 is dropped as unquorate.
    // Pinned by xchain-indexer/test/unit/actions/attest_relay.test.js and cross-checked
    // against the indexer's own implementation in AttestationRelay.canonical.test.js.
    //
    // `view` is deliberately IGNORED. The EQUIV header's VIEW is pinned at 0 because
    // the on-chain action carries no view field, so a verifier replaying the action
    // has no way to learn one. The signature therefore stays valid across a PBFT view
    // change, which is correct here: the round's VALUE never changes with the view.
    _canonicalMatch(row, view){   // eslint-disable-line no-unused-vars
        if(row.phase === 'response') return this.relayResponseCanonical(row);
        return this.relayRequestCanonical(row);
    },

    relayRequestCanonical(r){
        let raw = [
            'ATTEST', 'RELAY_REQUEST', String(r.request_id), String(r.snapshot_block), String(r.network),
            String(r.origin_chain), String(r.origin_action_index), String(r.provider_id),
            this._sha256(r.request_payload == null ? '' : r.request_payload),
            String(r.redundancy), String(r.deadline_blocks)
        ].join('|');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this._sha256('ATTESTRELAY|request|' + String(r.request_id)), 0, raw);
        return raw;
    },

    // The response leg's canonical. Note the asymmetry with the request leg: the
    // response body enters ALREADY HASHED, and the indexer hashes the raw
    // base64-DECODED bytes, not the base64 text, which is why responseFieldsFromHome
    // hashes the bytes it is about to encode rather than the string it read.
    relayResponseCanonical(r){
        let raw = [
            'ATTEST', 'RELAY_RESPONSE', String(r.request_id), String(r.snapshot_block), String(r.network),
            String(r.origin_chain), String(r.home_response_action_index), String(r.provider_id),
            String(r.response_hash), String(r.status), String(r.meta == null ? '' : r.meta)
        ].join('|');
        if(eq.isEquivHeaderActive(r.snapshot_block, r.network))
            return eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST,
                this._sha256('ATTESTRELAY|response|' + String(r.request_id)), 0, raw);
        return raw;
    },

    buildRequestWire(row, sigs){
        let parts = [
            'ATTEST',
            '3',
            String(row.request_id).toLowerCase(),
            String(row.origin_chain),
            String(row.origin_action_index),
            String(row.provider_id),
            String(row.request_payload == null ? '' : row.request_payload),
            String(row.redundancy),
            String(row.deadline_blocks),
            String(row.snapshot_block),
            String(sigs.length)
        ];
        for(let s of sigs){
            parts.push(String(s.pubkey).toLowerCase());
            parts.push(String(s.sig).toLowerCase());
        }
        return parts.join('|');
    },

    buildResponseWire(row, sigs){
        let parts = [
            'ATTEST',
            '4',
            String(row.request_id).toLowerCase(),
            String(row.home_response_action_index),
            String(row.response_payload_b64 == null ? '' : row.response_payload_b64),
            String(row.status),
            String(row.meta == null ? '' : row.meta),
            String(row.snapshot_block),
            String(sigs.length)
        ];
        for(let s of sigs){
            parts.push(String(s.pubkey).toLowerCase());
            parts.push(String(s.sig).toLowerCase());
        }
        return parts.join('|');
    },

    _roundId(phase, requestId){
        return this._sha256('ATTESTRELAYROUND|' + phase + '|' + String(requestId).toLowerCase());
    },

    _sha256(s){
        return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
    }

};
