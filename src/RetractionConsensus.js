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
const ValidatorIdentity = require('./ValidatorIdentity');
const swq               = require('./stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { isRetractionSigningActive } = require('./retraction_signing_activation.js');
const snapWrite         = require('./lib/capability_snapshot_write.js');

const XRETRACT_SIGN_REQ  = 'XRETRACT_SIGN_REQ';
const XRETRACT_SIGN      = 'XRETRACT_SIGN';
const XRETRACT_FINALIZED = 'XRETRACT_FINALIZED';

// Tables whose retractions require the co-signature set (their insertions are
// the quorum-signed relay rows this consensus protects). Price-table retractions stay
// on the fence-guarded legacy path: their insertions are not quorum-signed
// either, so signing their deletions would claim a trust tier the data lacks.
const QUORUM_CLASS_TABLES = new Set(['cross_chain_calls', 'cross_chain_matches']);

// Leader-supplied snapshot_block drift bound, in BTC blocks, against the
// follower's own resolved tip (same bound CrossChainCallEngine applies to
// relay-row proposals; ~1 day).
const SNAPSHOT_DRIFT_BLOCKS = 144;

class RetractionConsensus {

    constructor(hub){
        this.hub         = hub;
        this.db          = hub.db;
        this.identity    = hub.identity || null;
        this.peerManager = hub.peerManager || null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.network     = hub.network || '';

        this.roundTimeoutMs = parseInt(process.env.RETRACT_ROUND_TIMEOUT_MS || (hub.p2pConfig && hub.p2pConfig.RETRACT_ROUND_TIMEOUT_MS) || 180000);
        this.retrySignReqMs = parseInt(process.env.RETRACT_SIGN_RETRY_MS    || (hub.p2pConfig && hub.p2pConfig.RETRACT_SIGN_RETRY_MS)    || 15000);
        this.intentTtlMs    = parseInt(process.env.RETRACT_INTENT_TTL_MS    || (hub.p2pConfig && hub.p2pConfig.RETRACT_INTENT_TTL_MS)    || 3600000);

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

    // The signed canonical. MUST byte-match the consumer rebuild in
    // hub_db_sync.js (xchain-indexer + xchain-explorer vendored copy).
    static canonicalRetraction(evt){
        let to  = (evt.to_action_index       !== undefined && evt.to_action_index       !== null) ? String(evt.to_action_index)       : '';
        let gen = (evt.retraction_generation !== undefined && evt.retraction_generation !== null) ? String(evt.retraction_generation) : '';
        return 'XRETRACTV1|' + String(evt.table) + '|' + String(evt.source_chain) + '|' +
               String(evt.from_action_index) + '|' + to + '|' + gen + '|' + String(evt.snapshot_block);
    }

    // Intent identity for follower matching: what an independent honest indexer
    // of the same chain derives from the same reorg. Deliberately EXCLUDES the
    // generation (instance-local counter) and snapshot_block (leader-resolved).
    static intentKey(evt){
        let to = (evt.to_action_index !== undefined && evt.to_action_index !== null) ? String(evt.to_action_index) : '';
        return String(evt.table) + '|' + String(evt.source_chain) + '|' + String(evt.from_action_index) + '|' + to;
    }

    _roundId(canonical){
        return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    }

    _pruneIntents(){
        let cutoff = Date.now() - this.intentTtlMs;
        for(let [k, ts] of this.localIntents)
            if(ts < cutoff) this.localIntents.delete(k);
    }

    _rememberFinalized(id){
        this.finalized.add(id);
        if(this.finalized.size > 512){
            let first = this.finalized.values().next().value;
            this.finalized.delete(first);
        }
    }

    // Entry point from the engines' retract paths, in place of a direct
    // broadcaster.broadcastDeletion(evt). Records the local intent (our own
    // indexer pushed this), then either runs the signing round (gate active)
    // or falls through to the legacy unsigned broadcast.
    async submitLocal(evt){
        this._pruneIntents();
        this.localIntents.set(RetractionConsensus.intentKey(evt), Date.now());

        if(!QUORUM_CLASS_TABLES.has(String(evt.table))) return this._broadcastUnsigned(evt);
        if(!this.identity || !this.peerManager || !this.capSnapshot) return this._broadcastUnsigned(evt);

        let snapshotBlock = await this._resolveSnapshotBlock();
        if(snapshotBlock == null || !isRetractionSigningActive(snapshotBlock, this.network))
            return this._broadcastUnsigned(evt);

        let validators = await this._resolveCapabilityValidators('cross_chain', snapshotBlock, this.network);
        if(!validators.length) return this._broadcastUnsigned(evt);

        let signedEvt = Object.assign({}, evt, { snapshot_block: Number(snapshotBlock) });
        let canonical = RetractionConsensus.canonicalRetraction(signedEvt);
        let id        = this._roundId(canonical);
        if(this.pending.has(id) || this.finalized.has(id)) return;   // duplicate submit (e.g. per-row DEX loop)

        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let mySig    = this.identity.sign(canonical);
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, this.network);
        let snapCount = validators.length;
        let quorum   = bftQuorumOrSingle(snapCount, 1);   // majority-floored BFT quorum

        if(snapCount <= 1){
            await this._finalize(signedEvt, canonical, id, [{ pubkey: myPubkey, sig: mySig }], true);
            return;
        }

        let pendingValidators = validators.map(v => ({ pubkey: String(v.pubkey).toLowerCase(), source: String(v.source != null ? v.source : ''), weight: String(v.weight != null ? v.weight : (v.amount != null ? v.amount : '0')) }));
        if(validators.truncated === true) pendingValidators.truncated = true;
        let pending = {
            id, evt: signedEvt, canonical, quorum, weighted,
            validators: pendingValidators,
            signatures: new Map([[myPubkey, mySig]]),
            done: false, timeoutTimer: null, retryTimer: null
        };
        this.pending.set(id, pending);

        let signReq = { retraction: signedEvt, sig_pubkey: myPubkey, sig: mySig };
        // Followers can only sign once their own indexer observes the reorg,
        // which lags ours by an unknowable few seconds/blocks: keep re-asking
        // until quorum or timeout instead of relying on one broadcast.
        pending.retryTimer = setInterval(() => this.peerManager.broadcast(XRETRACT_SIGN_REQ, signReq), this.retrySignReqMs);
        if(pending.retryTimer.unref) pending.retryTimer.unref();
        pending.timeoutTimer = setTimeout(() => {
            this.pending.delete(id);
            if(pending.retryTimer) clearInterval(pending.retryTimer);
            if(!pending.done){
                // Liveness over the signature tier: mirrors past the gate refuse the
                // unsigned event anyway (fail closed there), mirrors below it still
                // converge under the activation fences. Never silently drop a retraction.
                console.warn('RetractionConsensus: round ' + id.substring(0, 16) + '... timed out at ' +
                    pending.signatures.size + '/' + pending.quorum + ' sigs, broadcasting UNSIGNED (legacy tier)');
                this._broadcastUnsigned(evt);
            }
        }, this.roundTimeoutMs);
        if(pending.timeoutTimer.unref) pending.timeoutTimer.unref();

        this.peerManager.broadcast(XRETRACT_SIGN_REQ, signReq);
        this._checkQuorum(id);
    }

    _broadcastUnsigned(evt){
        if(this.broadcaster) this.broadcaster.broadcastDeletion(evt);
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XRETRACT_SIGN_REQ:  this._handleSignReq(envelope).catch(e => console.error('RetractionConsensus: SIGN_REQ error: ' + (e && e.message))); break;
            case XRETRACT_SIGN:      this._handleSign(envelope); break;
            case XRETRACT_FINALIZED: this._handleFinalized(envelope).catch(e => console.error('RetractionConsensus: FINALIZED error: ' + (e && e.message))); break;
        }
    }

    _normalizeRetraction(d){
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
    }

    // Follower: co-sign ONLY a retraction our own source-chain indexer
    // independently pushed to this hub (never adopt the initiator's claim).
    async _handleSignReq(envelope){
        let d   = envelope.data;
        let evt = this._normalizeRetraction(d.retraction);
        if(!evt || !this.identity) return;
        let myPubkey = this.identity.getPubkeyHex().toLowerCase();
        let sender   = String(d.sig_pubkey || '').toLowerCase();
        if(sender === myPubkey) return;                            // our own broadcast

        if(!isRetractionSigningActive(evt.snapshot_block, this.network)) return;

        // Freshness (fail-closed): bound the initiator-chosen snapshot_block
        // against our own tip view before it can select the validator set.
        let myBlock = await this._resolveSnapshotBlock();
        if(myBlock == null || !Number.isFinite(Number(myBlock))) return;
        if(Math.abs(Number(evt.snapshot_block) - Number(myBlock)) > SNAPSHOT_DRIFT_BLOCKS) return;

        let validators = await this._resolveCapabilityValidators('cross_chain', evt.snapshot_block, this.network);
        let pubkeys    = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
        if(!pubkeys.has(myPubkey) || !pubkeys.has(sender)) return;

        let canonical = RetractionConsensus.canonicalRetraction(evt);
        if(!ValidatorIdentity.verify(canonical, String(d.sig || ''), sender)) return;

        // The load-bearing check: OUR indexer must have pushed a matching
        // retraction (same table/chain/from/to; the generation is the
        // initiator's instance-local counter and is signed, not compared).
        this._pruneIntents();
        let intentTs = this.localIntents.get(RetractionConsensus.intentKey(evt));
        if(intentTs === undefined) return;                         // nothing we observed -> never sign

        this.peerManager.broadcast(XRETRACT_SIGN, {
            id: this._roundId(canonical), sig_pubkey: myPubkey, sig: this.identity.sign(canonical)
        });
    }

    // Initiator: collect follower signatures.
    _handleSign(envelope){
        let d  = envelope.data;
        let id = String(d.id || '');
        let pending = this.pending.get(id);
        if(!pending || pending.done) return;
        let pubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.validators.some(v => v.pubkey === pubkey)) return;
        if(!ValidatorIdentity.verify(pending.canonical, String(d.sig || ''), pubkey)) return;
        pending.signatures.set(pubkey, String(d.sig));
        this._checkQuorum(id);
    }

    _checkQuorum(id){
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
        this._finalize(pending.evt, pending.canonical, id, sigs, true)
            .catch(e => console.error('RetractionConsensus: finalize error: ' + (e && e.message)));
    }

    // Every hub streams the finalized signed deletion to ITS OWN mirror
    // subscribers (each hub serves its own indexer fleet), after re-verifying
    // the quorum independently - a Byzantine initiator cannot shortcut this.
    async _handleFinalized(envelope){
        let d   = envelope.data;
        let evt = this._normalizeRetraction(d.retraction);
        if(!evt || !Array.isArray(d.signatures)) return;
        if(!isRetractionSigningActive(evt.snapshot_block, this.network)) return;

        let canonical = RetractionConsensus.canonicalRetraction(evt);
        let id        = this._roundId(canonical);
        if(this.finalized.has(id)) return;                         // already streamed (we initiated it)

        let validators = await this._resolveCapabilityValidators('cross_chain', evt.snapshot_block, this.network);
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
        await this._finalize(evt, canonical, id, sigs, false);
    }

    // Mirrors verify against the capability_snapshots rows at snapshot_block,
    // streamed on the SAME ordered socket BEFORE the deletion event, so a
    // live subscriber always holds the set it needs (same contract as the
    // engines' _persistCapabilitySnapshot before a signed row insert).
    //
    // FAIL CLOSED, in lockstep with CrossChainCallEngine._writeFinalizedRow and
    // CrossChainDexEngine._writeFinalizedMatch: that persist is a PRECONDITION of the
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
    // _rememberFinalized still runs FIRST: it is the reentrancy guard that keeps a
    // duplicate FINALIZED arriving mid-await from streaming the same deletion twice.
    // forgetFinalized on the error paths is what makes that ordering safe.
    // Returns true when the signed deletion was actually streamed.
    async _finalize(evt, canonical, id, sigs, isInitiator){
        this._rememberFinalized(id);
        let label = evt.table + ' ' + evt.source_chain + '>=' + evt.from_action_index +
                    ' (snapshot ' + evt.snapshot_block + ')';
        let persistedRows = 0;
        try {
            persistedRows = await this._persistCapabilitySnapshot('cross_chain', evt.snapshot_block);
        } catch(e){
            console.error('RetractionConsensus: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                          'signed retraction ' + label + ', nothing streamed): ' + (e && e.message));
            this.forgetFinalized(id);
            return false;
        }
        if(!persistedRows){
            console.error('RetractionConsensus: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          evt.snapshot_block + ' (degraded/empty/truncated validator set; fail-closed, deferring ' +
                          'signed retraction ' + label + ', nothing streamed)');
            this.forgetFinalized(id);
            return false;
        }
        if(this.broadcaster)
            this.broadcaster.broadcastDeletion(Object.assign({}, evt, { retraction_signatures: sigs }));
        console.log('RetractionConsensus: ' + (isInitiator ? 'finalized' : 'adopted') + ' signed retraction ' +
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
    // null snapshot, which _resolveCapabilityValidators normalizes to []), or the set
    // was refused as truncated - so _finalize can fail closed rather than streaming a
    // signed deletion whose signatures no mirror can verify.
    async _persistCapabilitySnapshot(capability, block){
        if(!this.db) return 0;
        let validators = await this._resolveCapabilityValidators(capability, block, this.network);
        // SWQ-TRUNC-MIRROR: a TRUNCATED set is never mirrored, for the reason
        // spelled out in CrossChainDexEngine._persistCapabilitySnapshot. The retraction
        // rail is a fourth writer into the SAME shared capability_snapshots mirror, so an
        // unguarded write here re-opens the accept/reject divergence the three engines
        // close: off-BTC verifiers read the capped rows back as COMPLETE
        // (getCapabilitySnapshotWeights sets no `truncated`) and clear 2/3 over an
        // under-counted denominator this class itself rejects at the `vset.truncated`
        // check in _handleFinalized. Keep every writer's guard in lockstep.
        if(validators && validators.truncated === true){
            console.warn('RetractionConsensus: refusing to persist a TRUNCATED ' + capability +
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
                let r = await this.db.doQuery(
                    'SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1',
                    [block, capability, row.signing_pubkey, row.source]);
                if(r.length) this.broadcaster.broadcastRow({ table: 'capability_snapshots', row: r[0] });
            }
        }
        return validators.length;
    }

    // Source-keyed at/above STAKE_WEIGHTED_QUORUM activation, legacy count set
    // below it (mirrors CrossChainCallEngine._resolveCapabilityValidators).
    async _resolveCapabilityValidators(capability, block, network){
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
                if(snap && Array.isArray(snap.validators))
                    validators = snap.validators.map(v => ({ pubkey: v.pubkey, source: '', weight: String(v.amount != null ? v.amount : '0'), amount: String(v.amount != null ? v.amount : '0') }));
            }
        }
        return validators;
    }

    async _resolveSnapshotBlock(){
        let b = this.hub._resolveBtcLatestBlock ? await this.hub._resolveBtcLatestBlock() : null;
        if(b != null) return b;
        return Number.isFinite(this._snapshotBlockOverride) ? this._snapshotBlockOverride : null;
    }
}

module.exports = RetractionConsensus;
