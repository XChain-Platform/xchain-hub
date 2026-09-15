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
 * XChain Hub - Attestation Canonical Bytes
 *
 * The bytes an attestation round signs, and the signing itself. The field
 * concatenation is the indexer's byte twin and lives in
 * attest_response_canonical.js; what is decided here is the era assertion, the
 * admission field appended after the twin, and the EQUIV wrapper around both.
 *
 ********************************************************************/

'use strict';
const crypto            = require('crypto');
const eq                = require('../../equivocation_header.js');
// The response canonical in both eras. Byte-twinned with the indexer's copy;
// never reimplement it here.
const { buildResponseCanonicalRaw } = require('../attest_response_canonical.js');
const ah                = require('../../lib/admission_height.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Build the indexer-canonical signing message (returned as UTF-8 Buffer).
    //
    // LEGACY ERA:  request_id || provider_id || sha256(response_payload) || status || meta
    // MIRROR ERA:  the same five fields, then '|' then the signed effective_time
    //              (the ATTEST response mirror design, §3.1).
    //
    // The field concatenation itself lives in attest_response_canonical.js, which is
    // byte-twinned with the indexer's copy and carries the argument for why the
    // separator and the canonical integer spelling are both load-bearing. Nothing
    // about the string shape is decided here.
    //
    // ERA SELECTION IS AN ASSERTION, NOT A BRANCH. The two eras never share a
    // signature, so a canonical built in the wrong era does not degrade, it makes
    // every signature over it fail to verify. That symptom is indistinguishable
    // from a dead federation, a bad identity, a corrupted body or a peer running
    // the wrong build, so the one thing this must never do is pick an era quietly:
    // a mirror-era request handed no effective time, or a legacy-era request handed
    // one, throws here where the caller that got it wrong is still on the stack.
    //
    // `effectiveTime` undefined means the CALLER IS NOT ERA-AWARE, which is the
    // pre-mirror six-argument form kept for the canonical-shape tests and for
    // hand-built round states. It yields the legacy bytes and skips the assertion.
    // Every in-round call site passes the seventh argument explicitly (null for the
    // legacy era, an integer for the mirror era), which is pinned by
    // test/unit/attestation/consensus/attest_response_canonical_era.test.js so a new call site cannot
    // reintroduce a per-code-path era.
    //
    // The EQUIV header wrapper (WI-2 bump 2) is applied after, exactly where it was:
    // TAG=XATTEST, ROUND_ID=request_id, VIEW=0 (attestation has no view change). Its
    // gate keys on the REQUEST's block plus the hub's network, so the hub and the
    // on-chain verifier flip identically. `requestBlock` undefined (no request in
    // scope) -> both gates OFF -> bare legacy bytes (safe).
    //
    // `admitBlocks` is the row's admission map (section 5.5). Omitting it resolves the
    // OPEN ROUND's pinned map for this rid, which is what every in-round signing site
    // wants and why none of them had to grow an eighth argument; a verifier rebuilding
    // the canonical from a stored row has no round and passes the row's own map
    // explicitly. Its era gate is inside admissionCanonicalField and refuses in both
    // directions exactly as the effective_time gate above does.
    _buildCanonical(requestId, providerId, body, status, meta, requestBlock, effectiveTime, admitBlocks){
        let responseHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
        let et = (effectiveTime === undefined) ? null : effectiveTime;
        if(effectiveTime !== undefined){
            let mirrorEra = this._isMirrorEra(requestBlock);
            if(mirrorEra && et === null)
                throw new Error('AttestationConsensus: mirror-era request ' + String(requestId).substring(0,16) +
                    '... (block ' + String(requestBlock) + ') has no effective_time; refusing to build a legacy canonical');
            if(!mirrorEra && et !== null)
                throw new Error('AttestationConsensus: legacy-era request ' + String(requestId).substring(0,16) +
                    '... (block ' + String(requestBlock) + ') was handed effective_time ' + JSON.stringify(et) +
                    '; refusing to build a mirror-era canonical');
        }
        let raw = buildResponseCanonicalRaw({
            requestId:     requestId,
            providerId:    providerId,
            responseHash:  responseHash,
            status:        status,
            meta:          meta,
            effectiveTime: et
        });
        // Appended after the shared twin's bytes and before the EQUIV wrapper, so the
        // twin stays a pure function of the response fields and this file owns the one
        // field the indexer rebuilds from the mirrored row's own columns.
        raw += ah.admissionCanonicalField('AttestationConsensus', this.hub && this.hub.network, requestBlock,
            (admitBlocks === undefined) ? this._roundAdmitBlocks(requestId) : admitBlocks);
        if(eq.isEquivHeaderActive(requestBlock, this.hub && this.hub.network))
            raw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, requestId, 0, raw);
        return Buffer.from(raw, 'utf8');
    },

    // Sign the canonical bytes with this validator's identity. Returns
    // 128-hex-char sig or null when no identity is available. Forwards the
    // era-aware / era-unaware distinction of _buildCanonical by arity, so a
    // six-argument caller keeps signing exactly the bytes it signed before.
    signCanonical(requestId, providerId, body, status, meta, requestBlock, effectiveTime, admitBlocks){
        if(!this.identity) return null;
        try {
            let canonical = (arguments.length >= 8)
                ? this._buildCanonical(requestId, providerId, body, status, meta, requestBlock, effectiveTime, admitBlocks)
                : (arguments.length >= 7)
                    ? this._buildCanonical(requestId, providerId, body, status, meta, requestBlock, effectiveTime)
                    : this._buildCanonical(requestId, providerId, body, status, meta, requestBlock);
            return this.identity.sign(canonical.toString('utf8'));
        } catch (e) {
            logger.warn(nodeUtil.format('AttestationConsensus: sign failed:', e));
            return null;
        }
    },

    // The admission map pinned on this rid's OPEN round, or null when no round is open
    // for it. Null is the LEGACY value, which is correct at every height below the
    // activation and fails closed above it: admissionCanonicalField refuses to build
    // admission-era bytes without a map rather than inventing one.
    _roundAdmitBlocks(requestId){
        let p = this.pending && this.pending.get(String(requestId).toLowerCase());
        return (p && p.admitBlocks !== undefined) ? p.admitBlocks : null;
    },

    // This hub's admission map for an attest-response round: BTC alone, because the
    // indexer's call-site guard reads attestation_responses on BTC only. Null when the
    // hub cannot produce a fresh BTC admission tip, which the caller turns into a refusal
    // to open the round.
    async resolveRoundAdmitBlocks(){
        let hub = this.hub;
        if(!hub || typeof hub.resolveAdmitBlocks !== 'function') return null;
        try { return await hub.resolveAdmitBlocks('attestation_responses', ['BTC']); }
        catch (e){
            logger.error(nodeUtil.format('AttestationConsensus: admission tip read failed:', e && e.message ? e.message : e));
            return null;
        }
    }

};
