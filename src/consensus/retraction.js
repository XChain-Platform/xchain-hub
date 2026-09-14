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
 * XChain Hub - Retraction Consensus
 *
 * Collects 2f+1 `cross_chain` validator co-signatures over quorum-class
 * reorg-retraction broadcasts (row:deleted events for cross_chain_calls /
 * cross_chain_matches) before they reach the hub-DB mirror stream, so a
 * single compromised HUB_API_KEY / HUB_REORG_API_KEY can no longer have
 * every mirror durably delete valid quorum-signed relay rows for a chain
 * its own indexers never reorged.
 *
 * Trust model - the same tier as INSERTIONS of these tables: a follower
 * co-signs a retraction canonical only when its OWN indexer for the source
 * chain independently pushed a matching retraction (push*reorg) to this
 * hub. Honest indexers of the same chain derive the same
 * (table, source_chain, from_action_index[, to]) from the same reorg, so
 * the intents match; a fabricated retraction no honest indexer observed
 * never collects a quorum.
 *
 * Round shape mirrors StateCheckpointEngine's SIGN_REQ/SIGN pattern (no
 * PBFT phases needed: the canonical is self-describing and each signature
 * is an independent attestation):
 *
 *   XRETRACT_SIGN_REQ  initiator broadcast: retraction fields + own sig.
 *                      Re-broadcast every retrySignReqMs until quorum or
 *                      timeout, because peer indexers observe the same
 *                      reorg SECONDS apart and a follower only signs once
 *                      its own intent exists.
 *   XRETRACT_SIGN      follower reply: sig over the initiator's canonical.
 *   XRETRACT_FINALIZED initiator broadcast of the 2f+1 set. Every hub
 *                      re-verifies and streams the signed deletion to ITS
 *                      OWN mirror subscribers (each hub serves its own
 *                      indexer fleet).
 *
 * The signed canonical (MUST byte-match the consumer rebuild in
 * hub_db_sync.js verifyRetractionSignatures - indexer + explorer copies):
 *
 *   XRETRACTV1|<table>|<source_chain>|<from_action_index>|<to_action_index or ''>|<retraction_generation or ''>|<snapshot_block>
 *
 * The generation fence is INSIDE the canonical: it is the initiator's
 * instance-local value (followers do not compare it, generations are
 * per-indexer counters), but binding it stops a captured signature set
 * from being replayed with an inflated fence to wipe re-published rows.
 * snapshot_block selects the validator set mirrors verify against and is
 * bounded by followers against their own BTC tip before signing.
 *
 * Below the RETRACTION_SIGNING_ACTIVATION era, with no validator identity
 * (standalone hub), or when a round times out below quorum, the event is
 * broadcast unsigned exactly as before (mirrors past the gate refuse it,
 * mirrors below it apply it under the activation fences), so a rolling deploy
 * and a degraded federation both stay live.
 *
 ********************************************************************/

const crypto            = require('crypto');
const swq               = require('../stake_weighted_quorum.js');
const snapWrite         = require('../lib/capability_snapshot_write.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const logger = getLogger();

const { canonicalRetraction, intentKey, bindRetractionClass } = require('./retraction/canonical.js');
const { XRETRACT_SIGN_REQ, XRETRACT_SIGN, XRETRACT_FINALIZED } = require('./retraction/wire.js');

// One part per side of a signing round, each an object of methods installed on
// RetractionConsensus.prototype below. The class file keeps the round state,
// the dispatch, the finalize and the capability-snapshot persist.
const submitPart = require('./retraction/submit.js');
const cosignPart = require('./retraction/cosign.js');

class RetractionConsensus {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.identity    = hub.identity || null;
        this.peerManager = hub.peerManager || null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.network     = hub.network || '';

        this.roundTimeoutMs = parseInt(hubConfig.RETRACT_ROUND_TIMEOUT_MS || (hub.p2pConfig && hub.p2pConfig.RETRACT_ROUND_TIMEOUT_MS) || 180000);
        this.retrySignReqMs = parseInt(hubConfig.RETRACT_SIGN_RETRY_MS    || (hub.p2pConfig && hub.p2pConfig.RETRACT_SIGN_RETRY_MS)    || 15000);
        this.intentTtlMs    = parseInt(hubConfig.RETRACT_INTENT_TTL_MS    || (hub.p2pConfig && hub.p2pConfig.RETRACT_INTENT_TTL_MS)    || 3600000);

        this.pending      = new Map();   // round id -> { canonical, evt, validators, quorum, weighted, signatures, timers }
        this.localIntents = new Map();   // intent key -> arrival ts (what OUR indexers pushed to us)
        this.finalized    = new Set();   // round ids already streamed (dedup leader/finalized double-delivery)

        if(this.peerManager){
            this._messageHandler = (envelope) => this._handleMessage(envelope);
            this.peerManager.on('message', this._messageHandler);
        }
    }

    stop(){
        for(let p of this.pending.values()){
            if(p.timeoutTimer) clearTimeout(p.timeoutTimer);
            if(p.retryTimer)   clearInterval(p.retryTimer);
        }
        this.pending.clear();
        if(this.peerManager && this._messageHandler)
            this.peerManager.removeListener('message', this._messageHandler);
    }


    // The signed canonical and the follower intent key, spelled in
    // retraction/canonical.js and kept as statics here because that is how every
    // caller and the consumer-parity suite name them.
    static canonicalRetraction(evt){
        return canonicalRetraction(evt);
    }

    static intentKey(evt){
        return intentKey(evt);
    }

    _roundId(canonical){
        return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    }

    pruneIntents(){
        let cutoff = Date.now() - this.intentTtlMs;
        for(let [k, ts] of this.localIntents)
            if(ts < cutoff) this.localIntents.delete(k);
    }

    rememberFinalized(id){
        this.finalized.add(id);
        if(this.finalized.size > 512){
            let first = this.finalized.values().next().value;
            this.finalized.delete(first);
        }
    }

    broadcastUnsigned(evt){
        if(this.broadcaster) this.broadcaster.broadcastDeletion(evt);
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XRETRACT_SIGN_REQ:  this.handleSignReq(envelope).catch(e => logger.error('RetractionConsensus: SIGN_REQ error: ' + (e && e.message))); break;
            case XRETRACT_SIGN:      this.handleSign(envelope); break;
            case XRETRACT_FINALIZED: this.handleFinalized(envelope).catch(e => logger.error('RetractionConsensus: FINALIZED error: ' + (e && e.message))); break;
        }
    }

    // Mirrors verify against the capability_snapshots rows at snapshot_block,
    // streamed on the SAME ordered socket BEFORE the deletion event, so a
    // live subscriber always holds the set it needs (same contract as the
    // engines' _persistCapabilitySnapshot before a signed row insert).
    //
    // FAIL CLOSED, in lockstep with CrossChainCallEngine.writeFinalizedRow and
    // CrossChainDexEngine.writeFinalizedMatch: that persist is a PRECONDITION of the
    // signed deletion, not a best-effort side-write. A swallowed DB throw, or a silent
    // ZERO-row persist (the validator set degrades to [] on an indexer RPC error /
    // 401-403, so the INSERT loop never runs, never throws, never warns, and the
    // truncated guard returns without writing), streams a co-signed deletion that no
    // mirror can verify: past the retraction gate the mirror refuses it, so the retracted
    // rows stay live in every indexer while this hub logs a finalized retraction and
    // retires the round id forever. Deferring is strictly better - the round id is
    // released, so the next delivery of the same retraction (a peer's XRETRACT_FINALIZED,
    // or our own indexer re-pushing the reorg through submitLocal) re-runs it cleanly.
    //
    // rememberFinalized still runs FIRST: it is the reentrancy guard that keeps a
    // duplicate FINALIZED arriving mid-await from streaming the same deletion twice.
    // forgetFinalized on the error paths is what makes that ordering safe.
    // Returns true when the signed deletion was actually streamed.
    async finalize(evt, canonical, id, sigs, isInitiator){
        this.rememberFinalized(id);
        let label = evt.table + ' ' + evt.source_chain + '>=' + evt.from_action_index +
                    ' (snapshot ' + evt.snapshot_block + ')';
        let persistedRows = 0;
        try {
            persistedRows = await this._persistCapabilitySnapshot('cross_chain', evt.snapshot_block);
        } catch(e){
            logger.error('RetractionConsensus: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                          'signed retraction ' + label + ', nothing streamed): ' + (e && e.message));
            this.forgetFinalized(id);
            return false;
        }
        if(!persistedRows){
            logger.error('RetractionConsensus: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          evt.snapshot_block + ' (degraded/empty/truncated validator set; fail-closed, deferring ' +
                          'signed retraction ' + label + ', nothing streamed)');
            this.forgetFinalized(id);
            return false;
        }
        if(this.broadcaster)
            this.broadcaster.broadcastDeletion(Object.assign({}, evt, { retraction_signatures: sigs }));
        logger.info('RetractionConsensus: ' + (isInitiator ? 'finalized' : 'adopted') + ' signed retraction ' +
                    evt.table + ' ' + evt.source_chain + '>=' + evt.from_action_index +
                    ' (' + sigs.length + ' sigs, snapshot ' + evt.snapshot_block + ')');
        return true;
    }

    // Release a round whose fail-closed precondition refused the stream, so a later
    // delivery of the same retraction can re-run it instead of being deduped away by
    // the finalized ring. Symmetric with Consensus.forgetFinalized, which the engines
    // already call from their reorg-retract paths.
    forgetFinalized(id){
        this.finalized.delete(id);
    }

    // Persist + mirror the qualifying validator set (same contract as
    // CrossChainCallEngine._persistCapabilitySnapshot).
    // Returns the number of capability rows resolved (and persisted) for this
    // (capability, block). A return of 0 means there was no DB mirror to write to,
    // the set degraded to empty (an indexer RPC error / auth mismatch surfaces as a
    // null snapshot, which resolveCapabilityValidators normalizes to []), or the set
    // was refused as truncated - so finalize can fail closed rather than streaming a
    // signed deletion whose signatures no mirror can verify.
    async _persistCapabilitySnapshot(capability, block){
        if(!this.db) return 0;
        let validators = await this.resolveCapabilityValidators(capability, block, this.network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored, for the reason
        // spelled out in CrossChainDexEngine._persistCapabilitySnapshot. The retraction
        // rail is a fourth writer into the SAME shared capability_snapshots mirror, so an
        // unguarded write here re-opens the accept/reject divergence the three engines
        // close: off-BTC verifiers read the capped rows back as COMPLETE
        // (getCapabilitySnapshotWeights sets no `truncated`) and clear 2/3 over an
        // under-counted denominator this class itself rejects at the `vset.truncated`
        // check in handleFinalized. Keep every writer's guard in lockstep.
        if(validators && validators.truncated === true){
            logger.warn('RetractionConsensus: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return 0;
        }
        // One statement for the whole set: a per-row loop left the mirror PARTIAL on any
        // single INSERT throw, and a partial set has no completeness marker so a verifier
        // reads it as COMPLETE. Rationale in lib/capability_snapshot_write.js. Parity with
        // StateCheckpointEngine and the other four writers.
        let rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        for(let row of rows){
            if(this.broadcaster){
                // Select back on the full widened uq_cap_snap
                // (snapshot_block, capability, signing_pubkey, source). A pubkey-only
                // select-back re-read the SAME row for every source of a delegated key
                // (LIMIT 1), so the mirror stream carried one source and the verifier of
                // this signed deletion tallied an under-counted denominator. Inert below
                // SWQ, where source='' and there is one row per key.
                let r = await this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // Source-keyed at/above STAKE_WEIGHTED_QUORUM activation, legacy count set
    // below it (mirrors CrossChainCallEngine.resolveCapabilityValidators).
    async resolveCapabilityValidators(capability, block, network){
        let validators = [];
        let weighted = swq.isStakeWeightedQuorumActive(block, network);
        if(this.capSnapshot){
            if(weighted){
                let snap = await this.capSnapshot.getWeightSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : '0'), amount: String(v.weight != null ? v.weight : '0') }));
                    if(snap.truncated === true) validators.truncated = true;
                }
            } else {
                let snap = await this.capSnapshot.getSnapshot(capability, block);
                if(snap && Array.isArray(snap.validators)){
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: '', weight: String(v.amount != null ? v.amount : '0'), amount: String(v.amount != null ? v.amount : '0') }));
                    // getSnapshot marks an over-cap COUNT set truncated too, and the persist
                    // guard reads the marker off this array, so carry it in both modes or the
                    // mirror takes a partial set below the stake-weighted flag day.
                    if(snap.truncated === true) validators.truncated = true;
                }
            }
        }
        return validators;
    }

    async resolveSnapshotBlock(){
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    }
}

// The parts go on with enumerable false, NOT Object.assign, for the reason
// src/db/index.js gives at its own install: class methods are non-enumerable, so
// assigned members would be the only ones for...in and Object.keys(prototype) can
// see, which changes what the prototype enumerates. writable and configurable stay
// true so a test can still stub and restore a moved method.
function installParts(target, parts) {
    for(const part of parts) {
        const descriptors = {};
        for(const name of Object.keys(part)) {
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate retraction method: ' + name + ' is already defined on ' +
                    'RetractionConsensus.prototype. Two parts, or a part and the class, claim the same name.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

bindRetractionClass(RetractionConsensus);
installParts(RetractionConsensus.prototype, [submitPart, cosignPart]);

module.exports = RetractionConsensus;
