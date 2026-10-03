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
 * AttestationBatchPublisher: co-signing a row whose signer set differs from ours
 *
 * A response round finalizes on the first `redundancy` valid signatures to arrive,
 * and the responsible set is larger than that whenever the widening ladder seats a
 * headroom member (every request above the zero-conf flag day). Two honest hubs can
 * therefore hold the same logical row, byte-identical in every signed content field,
 * under different signer subsets. Installed on AttestationBatchPublisher.prototype
 * by src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const ah                = require('../../lib/admission_height.js');
const ValidatorIdentity = require('../../validators/identity.js');
const mirrorVerify      = require('../response_mirror/verify.js');

module.exports = {

    // The follower's whole verdict on a proposed window: the row match, then a check of
    // every row whose content matched but whose signer set did not. `set` is the
    // attestation set at the proposed anchor, already resolved by handleSignReq.
    coSignVerdict(proposed, mine, set){
        let verdict = this.matchesLocalWindow(proposed, mine);
        if(!verdict.ok || !verdict.signerChecks) return verdict;
        return this.signerDivergenceVerdict(verdict.signerChecks, set);
    },

    // Accept a different signer set only when it is one this hub could have finalized
    // itself: every listed signature verifies over the canonical rebuilt from OUR row's
    // content (which matched the proposal field for field) and comes from a validator
    // holding attestation at the anchor. What this deliberately does not check is the
    // count against the request's redundancy: no request read survives fulfilment (the
    // pending-request RPC drops it), and every indexer re-verifies the row against its
    // responsible set and redundancy before applying it, so a short list is inert on
    // chain, never forged content.
    signerDivergenceVerdict(checks, set){
        let members = new Set((set || []).map(v => String(v && v.pubkey).toLowerCase()));
        for(let check of checks){
            let why = this.signerRowRefusal(check.proposed, check.local, members);
            if(why) return { ok: false, why: why };
        }
        return { ok: true, why: null };
    },

    // The reason one proposed row's signer set is refused, or null when it holds up.
    signerRowRefusal(proposed, local, members){
        let short = 'request ' + String(proposed.request_id).substring(0, 16) + '...';
        let sigs  = mirrorVerify.parseSigList(proposed.signatures);
        if(sigs === null) return short + ' carries a signature list that is not a non-empty array of {pubkey,sig}';
        if(!this.signerListMatches(proposed.signer_pubkeys, sigs))
            return short + ' lists signer_pubkeys that do not pair with its signatures';
        let canonical = this.localRowCanonical(local);
        if(canonical === null) return short + ' has no canonical this hub can rebuild from its own row';
        let seen = new Set();
        for(let s of sigs){
            if(seen.has(s.pubkey)) return short + ' carries signer ' + s.pubkey.substring(0, 16) + '... twice';
            seen.add(s.pubkey);
            if(!members.has(s.pubkey))
                return short + ' carries signer ' + s.pubkey.substring(0, 16) + '..., which holds no attestation at the anchor';
            if(!ValidatorIdentity.verify(canonical, s.sig, s.pubkey))
                return short + ' carries a signature by ' + s.pubkey.substring(0, 16) + '... that does not verify over the row';
        }
        return null;
    },

    // build.js writes signer_pubkeys as the pubkeys of the signature list, index for
    // index; a list that disagrees with its own signatures is not a row any hub wrote.
    signerListMatches(raw, sigs){
        let listed;
        try { listed = JSON.parse(String(raw == null ? '' : raw)); }
        catch(_){ return false; }
        if(!Array.isArray(listed) || listed.length !== sigs.length) return false;
        return listed.every((k, i) => String(k).toLowerCase() === sigs[i].pubkey);
    },

    // The response canonical the row's signers signed, rebuilt the way the mirror's
    // gossip verifier rebuilds it (response_mirror/verify.js), from this hub's own copy.
    // Null when this hub has no consensus object or the row cannot be rebuilt.
    localRowCanonical(local){
        let consensus = this.hub && this.hub.attestationConsensus;
        if(!consensus || typeof consensus.buildCanonical !== 'function') return null;
        try {
            let body = Buffer.from(String(local.response_payload == null ? '' : local.response_payload), 'utf8');
            return consensus.buildCanonical(
                String(local.request_id).toLowerCase(), String(local.provider_id), body, String(local.status),
                String(local.meta == null ? '' : local.meta), Number(local.request_block_index),
                Number(local.effective_time), ah.rowAdmitBlocks(local)).toString('utf8');
        } catch(_){
            return null;
        }
    }

};
