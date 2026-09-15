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
 * XChain Hub - Retraction Consensus: follower co-signing
 *
 * The follower side: normalize an inbound retraction, co-sign only what our own
 * indexer observed, collect signatures, and adopt a finalized set after
 * re-verifying its quorum independently.
 *
 * src/consensus/retraction.js installs every method below on
 * RetractionConsensus.prototype, non-enumerable like the class's own methods,
 * so callers and tests keep reaching them as retraction.<method>().
 *
 ********************************************************************/

'use strict';

const ValidatorIdentity = require('../../validators/identity');
const swq               = require('../../stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { isRetractionSigningActive } = require('../../retraction_signing_activation.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

const { retractionClass } = require('./canonical.js');
const { XRETRACT_SIGN, XRETRACT_FINALIZED, QUORUM_CLASS_TABLES } = require('./wire.js');

// Leader-supplied snapshot_block drift bound, in BTC blocks, against the
// follower's own resolved tip (same bound CrossChainCallEngine applies to
// relay-row proposals; ~1 day).
const SNAPSHOT_DRIFT_BLOCKS = 144;

module.exports = {

    normalizeRetraction(d){
        if(!d || typeof d !== 'object') return null;
        if(!QUORUM_CLASS_TABLES.has(String(d.table))) return null;
        let evt = {
            table:             String(d.table),
            source_chain:      String(d.source_chain || ''),
            from_action_index: Number(d.from_action_index),
            snapshot_block:    Number(d.snapshot_block)
        };
        if(!evt.source_chain || !Number.isFinite(evt.from_action_index) || evt.from_action_index < 0) return null;
        if(!Number.isFinite(evt.snapshot_block) || evt.snapshot_block < 0) return null;
        if(d.to_action_index !== undefined && d.to_action_index !== null){
            evt.to_action_index = Number(d.to_action_index);
            if(!Number.isFinite(evt.to_action_index) || evt.to_action_index < evt.from_action_index) return null;
        }
        if(d.retraction_generation !== undefined && d.retraction_generation !== null){
            evt.retraction_generation = Number(d.retraction_generation);
            if(!Number.isFinite(evt.retraction_generation) || evt.retraction_generation < 0) return null;
        }
        return evt;
    },

    // Follower: co-sign ONLY a retraction our own source-chain indexer
    // independently pushed to this hub (never adopt the initiator's claim).
    async handleSignReq(envelope){
        let d   = envelope.data;
        let evt = this.normalizeRetraction(d.retraction);
        if(!evt || !this.identity) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;                            // our own broadcast

        if(!isRetractionSigningActive(evt.snapshot_block, this.network)) return;

        // Freshness (fail-closed): bound the initiator-chosen snapshot_block
        // against our own tip view before it can select the validator set.
        let myBlock = await this.resolveSnapshotBlock();
        if(myBlock == null || !Number.isFinite(Number(myBlock))) return;
        if(Math.abs(Number(evt.snapshot_block) - Number(myBlock)) > SNAPSHOT_DRIFT_BLOCKS) return;

        let validators = await this.resolveCapabilityValidators('cross_chain', evt.snapshot_block, this.network);
        let pubkeys    = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        if(!pubkeys.has(myPubkey) || !pubkeys.has(sender)) return;

        let canonical = retractionClass().canonicalRetraction(evt);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // The load-bearing check: OUR indexer must have pushed a matching
        // retraction (same table/chain/from/to; the generation is the
        // initiator's instance-local counter and is signed, not compared).
        this.pruneIntents();
        let intentTs = this.localIntents.get(retractionClass().intentKey(evt));
        if(intentTs === undefined) return;                         // nothing we observed -> never sign

        this.peerManager.broadcast(XRETRACT_SIGN, {
            id: this.roundId(canonical), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    },

    // Initiator: collect follower signatures.
    handleSign(envelope){
        let d  = envelope.data;
        let id = String(d.id || '');
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(pending.canonical, String(d.sig || ''), pubkey)) return;
        pending.signatures.set(pubkey, String(d.sig));
        this.checkQuorum(id);
    },

    checkQuorum(id){
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let met = pending.weighted
            ? swq.meetsStakeThreshold(pending.validators, pending.signatures.keys())
            : (pending.signatures.size >= pending.quorum);
        if(!met) return;
        pending.done = true;
        if(pending.timeoutTimer){ clearTimeout(pending.timeoutTimer); pending.timeoutTimer = null; }
        if(pending.retryTimer){ clearInterval(pending.retryTimer); pending.retryTimer = null; }
        this.pending.delete(id);
        let sigs = [];
        for(let [pk, sg] of pending.signatures) sigs.push({ pubkey: pk, sig: sg });
        this.peerManager.broadcast(XRETRACT_FINALIZED, { retraction: pending.evt, signatures: sigs });
        this.finalize(pending.evt, pending.canonical, id, sigs, true)
            .catch(e => logger.error('RetractionConsensus: finalize error: ' + (e && e.message)));
    },

    // Every hub streams the finalized signed deletion to ITS OWN mirror
    // subscribers (each hub serves its own indexer fleet), after re-verifying
    // the quorum independently - a Byzantine initiator cannot shortcut this.
    async handleFinalized(envelope){
        let d   = envelope.data;
        let evt = this.normalizeRetraction(d.retraction);
        if(!evt || !Array.isArray(d.signatures)) return;
        if(!isRetractionSigningActive(evt.snapshot_block, this.network)) return;

        let canonical = retractionClass().canonicalRetraction(evt);
        let id        = this.roundId(canonical);
        if(this.finalized.has(id)) return;                         // already streamed (we initiated it)

        let validators = await this.resolveCapabilityValidators('cross_chain', evt.snapshot_block, this.network);
        let pubkeys    = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        let snapCount  = pubkeys.size;
        let weighted   = swq.isStakeWeightedQuorumActive(evt.snapshot_block, this.network);
        let quorum     = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        let seen = new Set(), sigs = [];
        for(let s of d.signatures){
            let pk = String(s && s.pubkey || '').toLowerCase();
            if(!pk || seen.has(pk) || !pubkeys.has(pk)) continue;
            if(!ValidatorIdentity.verify(canonical, String(s.sig || ''), pk)) continue;
            seen.add(pk);
            sigs.push({ pubkey: pk, sig: String(s.sig) });
        }
        let vset = validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')) }));
        if(validators.truncated === true) vset.truncated = true;
        let met = weighted
            ? swq.meetsStakeThreshold(vset, sigs.map(s => s.pubkey))
            : (sigs.length >= quorum);
        if(!met) return;                                           // sub-quorum, ignore
        await this.finalize(evt, canonical, id, sigs, false);
    }
};
