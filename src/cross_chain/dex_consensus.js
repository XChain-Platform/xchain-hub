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
 * XChain Hub - Cross-Chain DEX Consensus (PBFT match finalization)
 *
 * Drives Byzantine-fault-tolerant agreement over a cross-chain match BEFORE it
 * is written to cross_chain_matches and mirrored to indexers. The indexer's
 * settlement pass (cross_settle) releases escrow only after verifying 2f+1
 * `cross_chain` signatures over the canonical match; this engine produces those
 * signatures through a 3-phase PBFT round (PROPOSE -> PREPARE -> COMMIT) with
 * leader-failover (VIEW_CHANGE -> NEW_VIEW).
 *
 * Unlike attestation consensus (divergent provider bodies -> provider.agree()
 * picks a winner), a cross-chain match is DETERMINISTIC: given the same confirmed
 * order books at snapshot_block, every honest validator derives the identical
 * canonical (engine._canonicalMatch). There is no winner to agree on: the
 * round is independent re-derivation + signature collection:
 *   - the match-designated leader broadcasts XDEX_MATCH_PROPOSE(row);
 *   - each peer re-derives + validates the match against its OWN order book
 *     (engine.validateProposedMatch) and only then signs the canonical;
 *   - signatures gather to 2f+1 over a single canonical and finalize the match.
 * A Byzantine leader cannot forge a settlement (honest peers sign only what they
 * independently confirm) and equivocation fails (each peer signs its own derived
 * canonical, so only the one true canonical reaches quorum).
 *
 * Structure mirrors AttestationConsensus.js (per-item rounds keyed by a
 * deterministic id, signature collection, early-message buffer, finalize-emit)
 * merged with Consensus.js's leader-failover (view-change keyed here by match_id).
 *
 * Single-node fallback: quorum 0 (N<=1, e.g. a single-operator regtest) collapses
 * to immediate self-sign + finalize, identical to the pre-PBFT behavior.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const { positiveIntConfig } = require('../lib/config_int.js');
const ah                = require('../lib/admission_height.js');
const { getLogger } = require('../observability');
const logger = getLogger();
const { installParts } = require('./prototype_parts.js');
const earlyBufferPart = require('./pbft/early_buffer.js');
const proposePart     = require('./pbft/propose.js');
const votesPart       = require('./pbft/votes.js');
const viewChangePart  = require('./pbft/view_change.js');

const XDEX_MATCH_PROPOSE     = 'XDEX_MATCH_PROPOSE';
const XDEX_MATCH_PREPARE     = 'XDEX_MATCH_PREPARE';
const XDEX_MATCH_COMMIT      = 'XDEX_MATCH_COMMIT';
const XDEX_MATCH_VIEW_CHANGE = 'XDEX_MATCH_VIEW_CHANGE';
const XDEX_MATCH_NEW_VIEW    = 'XDEX_MATCH_NEW_VIEW';
const XDEX_MATCH_FINAL_SYNC  = 'XDEX_MATCH_FINAL_SYNC';

const DEFAULT_ROUND_TIMEOUT_MS = 120000;  // 2 minutes per match round before view-change

class CrossChainDexConsensus extends EventEmitter {

    // engine: the CrossChainDexEngine. Used for _canonicalMatch (the signable
    // payload, byte-identical to the indexer verifier), validateProposedMatch
    // (independent re-derivation), and _persistCapabilitySnapshot (leader path).
    //
    // opts (optional) lets a second engine reuse this consensus over its own item
    // type without sharing gossip traffic with DEX match rounds. The engine
    // contract is unchanged (duck-typed _canonicalMatch / validateProposedMatch /
    // _persistCapabilitySnapshot; rows carry snapshot_block + the id field):
    //   opts.messageTypes: {PROPOSE, PREPARE, COMMIT, VIEW_CHANGE, NEW_VIEW}
    //   opts.controlTags:  {vc, nv} signed-control payload tags
    //   opts.idField:      row field that must equal the round id (default 'match_id')
    constructor(engine, opts){
        super();
        opts = opts || {};
        this.engine       = engine;
        this.hub          = engine.hub;
        this.peerManager  = engine.peerManager;
        this.identity     = engine.identity;
        this.capSnapshot  = engine.capSnapshot;
        this.config       = (engine.hub && engine.hub.p2pConfig) || {};
        this.types        = opts.messageTypes || {
            PROPOSE: XDEX_MATCH_PROPOSE, PREPARE: XDEX_MATCH_PREPARE, COMMIT: XDEX_MATCH_COMMIT,
            VIEW_CHANGE: XDEX_MATCH_VIEW_CHANGE, NEW_VIEW: XDEX_MATCH_NEW_VIEW,
            FINAL_SYNC: XDEX_MATCH_FINAL_SYNC
        };
        // Engines configured before FINAL_SYNC existed get a derived type so
        // straggler catch-up works without every caller updating its map.
        if(!this.types.FINAL_SYNC) this.types.FINAL_SYNC = String(this.types.PROPOSE).replace(/PROPOSE$/, 'FINAL_SYNC');
        this.controlTags  = opts.controlTags || { vc: 'XDEXVC', nv: 'XDEXNV' };
        this.idField      = opts.idField || 'match_id';

        this.pending = new Map();

        // Finalized match ids (ring-buffer bounded, FIFO eviction; mirrors
        // AttestationConsensus.finalized). Suppresses duplicate finalize/late COMMITs.
        this.finalized       = new Set();
        this._finalizedOrder = [];
        this.finalizedMax    = positiveIntConfig(this.config.XDEX_FINALIZED_MAX, 10000, 'XDEX_FINALIZED_MAX');

        // Finalized round payloads (row + quorum signatures), same eviction as
        // `finalized`. Serves FINAL_SYNC catch-up: a straggler that missed a
        // round (e.g. its local validation raced confirmation depth) keeps
        // emitting VIEW_CHANGEs; peers that finalized ignore the round, so
        // without state transfer the straggler's mirror NEVER gets the row.
        this.finalizedRows   = new Map();

        this.initEarlyBuffer();

        this._messageHandler = null;
        this.roundTimeoutMs  = parseInt(this.config.XDEX_ROUND_TIMEOUT_MS) || DEFAULT_ROUND_TIMEOUT_MS;
        // A round that keeps view-changing without ever finalizing (sustained
        // message loss, e.g. P2P rate-limit drops during a burst of concurrent
        // rounds) must not leak in `pending` forever: past this lifetime it is
        // abandoned so the engine can re-propose a fresh round once the storm
        // clears. Default = several view-change cycles.
        this.roundMaxLifetimeMs = parseInt(this.config.XDEX_ROUND_MAX_LIFETIME_MS) || (this.roundTimeoutMs * 4);
    }

    async start(){
        if(!this.peerManager){
            logger.info('CrossChainDexConsensus: no peer manager; single-node finalize only');
            return;
        }
        this._messageHandler = (env) => this._handleMessage(env);
        this.peerManager.on('message', this._messageHandler);
        logger.info('CrossChainDexConsensus: started');
    }

    async stop(){
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [, p] of this.pending){ if(p.timer) clearTimeout(p.timer); }
        this.pending.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
    }

    // Sort the snapshot validators by pubkey so every node agrees on ordering,
    // then index by (matchIdInt + view) % N. Mirrors Consensus._getLeader.
    _leaderFor(matchId, validators, view){
        if(!validators || validators.length === 0) return null;
        let sorted = validators.map(v => String(v.pubkey).toLowerCase()).sort();
        let mInt   = parseInt(String(matchId).slice(0, 8), 16) || 0;
        return sorted[(mInt + (view || 0)) % sorted.length];
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case this.types.PROPOSE:     this._handlePropose(envelope).catch(e => logger.error('CrossChainDexConsensus: PROPOSE error: ' + (e && e.message))); break;
            case this.types.PREPARE:     this.handlePrepare(envelope);    break;
            case this.types.COMMIT:      this._handleCommit(envelope);     break;
            case this.types.VIEW_CHANGE: this.handleViewChange(envelope); break;
            case this.types.NEW_VIEW:    this.handleNewView(envelope);    break;
            case this.types.FINAL_SYNC:  this.handleFinalSync(envelope).catch(e => logger.error('CrossChainDexConsensus: FINAL_SYNC error: ' + (e && e.message))); break;
        }
    }

    // Does the proposed row's admission map hold against THIS hub's own chain tips?
    //
    // True for an engine that declares no admission scope, and for a row below the
    // activation (admissionScope answers null), because those rows bind by the legacy
    // effective_time rule and carry no map to bound.
    //
    // Every other answer is fail-closed, including the ones caused by our own side: a
    // scope that throws, a map we cannot read, a tip we cannot resolve. A follower that
    // adopted an unchecked height would be signing the proposer's own claim back to it.
    async admissionBoundHolds(row, rid){
        if(typeof this.engine.admissionScope !== 'function') return true;
        let scope;
        try { scope = this.engine.admissionScope(row); }
        catch(e){
            logger.warn('CrossChainDexConsensus: PROPOSE ' + rid.substring(0,16) +
                '... has no usable admission scope (' + (e && e.message) + '); not signing');
            return false;
        }
        if(scope === null || scope === undefined) return true;

        let map;
        try { map = ah.rowAdmitBlocks(row); }
        catch(e){
            logger.warn('CrossChainDexConsensus: PROPOSE ' + rid.substring(0,16) +
                '... carries an unusable admission map (' + (e && e.message) + '); not signing');
            return false;
        }
        let v;
        try { v = await ah.checkAdmitBlocksAgainstHub(this.hub, scope.readSet, map); }
        catch(e){ v = { ok: false, chain: null, reason: 'admission bound check threw: ' + (e && e.message) }; }
        if(!v.ok){
            logger.warn('CrossChainDexConsensus: PROPOSE ' + rid.substring(0,16) +
                '... failed the ' + String(scope.table) + ' admission bound; not signing: ' + v.reason);
            return false;
        }
        return true;
    }

}

installParts(CrossChainDexConsensus.prototype, [
    earlyBufferPart, proposePart, votesPart, viewChangePart
]);

module.exports = Object.assign(CrossChainDexConsensus, {
    XDEX_MATCH_PROPOSE,
    XDEX_MATCH_PREPARE,
    XDEX_MATCH_COMMIT,
    XDEX_MATCH_VIEW_CHANGE,
    XDEX_MATCH_NEW_VIEW,
    XDEX_MATCH_FINAL_SYNC
});
