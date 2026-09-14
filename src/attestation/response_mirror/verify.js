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
 * AttestationResponseMirror: verifying a gossiped row
 *
 * Re-verifies the responsible set's signatures over the mirror-era canonical against
 * this hub's own snapshot, and parses the signature list both the gate and the
 * verifier read. Installed on AttestationResponseMirror.prototype by
 * src/attestation/response_mirror.js.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const swq    = require('../../stake_weighted_quorum.js');
const wid    = require('../../attest_responsible_widening_activation.js');
const ah     = require('../../lib/admission_height.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { ATTEST_RESPONSE_BODY_MAX_BYTES } = require('../attest_response_body_cap.js');

module.exports = {

    // Verify the responsible set's signatures over the mirror-era canonical, using
    // this hub's own snapshot of the world (§4.3). Returns {ok, error}.
    //
    // Every helper here is the hub's OWN copy of a consensus rule, called rather than
    // re-implemented: _computeResponsibleSet is the ranking that picks the signers in
    // AttestationRound, and _buildCanonical is the byte string they sign. A second
    // spelling of either would be a fork surface that no suite compares, which is why
    // this reaches for two "private" methods instead of copying twenty lines.
    async verifyGossipedRow(row, request, latestBlock){
        let rid = row.request_id;
        let declaredBlock = Number(request.block_index);
        if(!Number.isFinite(declaredBlock)) return { ok: false, error: 'local request carries no block_index' };
        let redundancy = Math.max(1, Number(request.redundancy) || 1);

        let sigs = this.parseSigList(row.signatures);
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

        return this.responsibleSignatureVerdict(row, rid, sigs, bodyBytes, snapshot,
                                                weighted, providerFloor, widen, redundancy, declaredBlock);
    },

    // The second half of the verification: the responsible set this hub derives at the
    // request's own height, the canonical those signers signed, and how many distinct
    // responsible validators actually verify against it.
    responsibleSignatureVerdict(row, rid, sigs, bodyBytes, snapshot, weighted, providerFloor, widen, redundancy, declaredBlock){
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
            // The ROW's own admission map, passed explicitly: this hub has no open round
            // for a peer's finalized row, so the round-pinned default would read null and
            // rebuild legacy bytes for an admission-era row. Passing the row's map is also
            // what makes the era gate a real check here, since it refuses when the row's
            // map and the request's era disagree.
            canonical = consensus._buildCanonical(
                rid, String(row.provider_id), bodyBytes, String(row.status),
                String(row.meta == null ? '' : row.meta), declaredBlock, Number(row.effective_time),
                ah.rowAdmitBlocks(row));
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
    },

    // Parse the `signatures` column into format-checked, lower-cased entries, or null
    // when it is not the shape every consumer requires. Shared by the structural gate
    // and the verifier so the two can never disagree about what a signature list is.
    parseSigList(raw){
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

};
