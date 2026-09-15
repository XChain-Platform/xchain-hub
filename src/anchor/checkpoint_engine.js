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
 * XChain Hub - State Checkpoint Engine
 *
 * Periodically produces quorum-signed checkpoints of each chain's indexer
 * state (the per-block ledger/actions/contract hash triple the indexer
 * already computes into its `blocks` table) so light clients can verify any
 * indexer/explorer response against a quorum of `oracle_publish` signatures
 * (max(2f+1, ceil((N+1)/2)); for small N this can require unanimity)
 * instead of trusting a single operator. Checkpoints are OFF-CHAIN: written
 * to `state_checkpoints` and streamed over the hub-DB mirror (zero chain
 * writes); the StateAnchorPublisher separately commits the latest checkpoint
 * on-chain via the DOGE-only ANCHOR action.
 *
 * Round shape (leaner than CrossChainDexConsensus; a missed checkpoint is
 * benign, the next cadence retries under a rotated leader, so no view-change
 * machinery):
 *   1. The cadence leader (rank btcBlock % N over the sorted oracle_publish
 *      set, same election as OraclePublisher) reads each chain's hash triple
 *      from ITS OWN indexer, signs the XCHECKPOINT canonical, and broadcasts
 *      XCHK_SIGN_REQ.
 *   2. Every peer independently re-fetches the SAME block's triple from its
 *      own indexer/replica, signs only on byte-identical canonical, and
 *      replies XCHK_SIGN. A Byzantine leader cannot collect a quorum for
 *      state honest validators don't hold.
 *   3. At 2f+1 the leader broadcasts XCHK_FINALIZED with the full signature
 *      set; EVERY hub verifies the set and writes its own state_checkpoints
 *      row (mirroring writeFinalizedMatch's everyone-writes pattern), then
 *      streams it to its indexer subscribers and emits checkpoint:finalized.
 *
 * Canonical signing string (must stay byte-identical to the indexer's ANCHOR
 * verifier and the SDK CheckpointVerifier; see spec protocol/actions/ANCHOR.md):
 *   XCHECKPOINT|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH|CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK
 *
 * Single-node fallback: oracle_publish set <= 1 (e.g. single-operator regtest)
 * collapses to immediate self-sign + write, like the other consensus engines.
 *
 ********************************************************************/

const EventEmitter      = require('events');
const snapWrite         = require('../lib/capability_snapshot_write.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

const { installParts } = require('./install_parts.js');
const { XCHK_SIGN_REQ, XCHK_SIGN, XCHK_FINALIZED } = require('./checkpoint_engine/constants.js');
// The statics live in canonical_forms.js so the parts can call them without requiring
// this file back; each method group below is one behaviour, installed on the prototype
// at the bottom of this file. Every part is required here at the top, before the class
// exists, and none requires this file.
const canonicalForms  = require('./checkpoint_engine/canonical_forms.js');
const optionMethods   = require('./checkpoint_engine/options.js');
const cadenceMethods  = require('./checkpoint_engine/cadence.js');
const statsMethods    = require('./checkpoint_engine/stats.js');
const roundMethods    = require('./checkpoint_engine/round.js');
const signMethods     = require('./checkpoint_engine/sign.js');
const finalizeMethods = require('./checkpoint_engine/finalize.js');
const sourceMethods   = require('./checkpoint_engine/sources.js');

class StateCheckpointEngine extends EventEmitter {

    constructor(hub){
        super();
        this.hub         = hub;
        this.db          = hub.db;
        this.peerManager = hub.getPeerManager ? hub.getPeerManager() : null;
        this.identity    = hub.getIdentity ? hub.getIdentity() : null;
        this.broadcaster = hub.hubDbBroadcaster || null;
        this.capSnapshot = hub.capabilitySnapshot || null;
        // Deployment network for the STAKE_WEIGHTED_QUORUM gate (cp.network == this
        // for every checkpoint this hub signs). Available before the per-chain network
        // is known, so the cadence-leader set + snapshot persist use the right rule.
        this.network     = (hub && hub.network) ? hub.network : '';

        let cfg = hub.p2pConfig || {};
        // Every other field is set below, one method per group of related knobs and
        // meters, in the order the fields have always been set (checkpoint_engine/options.js).
        this.initCadenceKnobs(cfg);
        this.initCosignTolerance(cfg);
        this.initChainScope(cfg);
        this.initRoundState();
        this.initFinalizeMeters();
        this.initCadenceMeters(cfg);
    }

    async start(){
        if(!this.enabled){ logger.info('StateCheckpointEngine: disabled (CHECKPOINT_ENABLED=false)'); return; }
        // Fill any indexer URL left empty at construction (a configs-table-
        // provisioned hub carries no *_INDEXER_URL env var, and the p2pConfig
        // fallback never holds one) via the hub's configs-aware resolver, so this
        // engine reaches the indexer instead of silently producing zero checkpoints.
        if(this.hub && typeof this.hub._resolveIndexerUrl === 'function'){
            for(const coin of Object.keys(this.indexers || {})){
                if(this.indexers[coin] && this.indexers[coin].url) continue;
                try {
                    const u = await this.hub._resolveIndexerUrl(coin);
                    if(u){ this.indexers[coin] = this.indexers[coin] || {}; this.indexers[coin].url = u; }
                } catch(_){}
            }
        }
        for(const coin of (this.chains || [])){
            if(!this.indexers[coin] || !this.indexers[coin].url)
                logger.warn('StateCheckpointEngine: no indexer URL for chain ' + coin + ' (set ' + coin + '_INDEXER_API_URL / ' + coin + '_INDEXER_URL, or push it via xchain-node updateconfig); this chain is skipped every tick until configured');
        }
        // Restore the cadence latch from the last checkpoint we already produced.
        // Without this the latch starts null, so the FIRST tick after a restart
        // checkpoints immediately regardless of intervalBlocks, and every such
        // off-schedule checkpoint anchors 3 chains on-chain (real DOGE). A
        // restart must not reset the cadence; only btcBlock advancing past
        // intervalBlocks should.
        await this.loadLastCheckpointLatch();
        if(this.peerManager){
            this._messageHandler = (env) => this._handleMessage(env);
            this.peerManager.on('message', this._messageHandler);
        }
        this._pollTimer = setInterval(() => {
            this._tick().catch(err => logger.error(nodeUtil.format('StateCheckpointEngine: tick error:', err && err.message)));
        }, this.pollMs);
        if(this._pollTimer.unref) this._pollTimer.unref();
        logger.info('StateCheckpointEngine started (every ' + this.intervalBlocks + ' BTC blocks, chains ' + this.chains.join('/') + ')');
    }

    async stop(){
        if(this._pollTimer){ clearInterval(this._pollTimer); this._pollTimer = null; }
        if(this._messageHandler && this.peerManager){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [, p] of this.pending){ if(p.timer) clearTimeout(p.timer); }
        this.pending.clear();
    }

    _handleMessage(envelope){
        if(!envelope || !envelope.data) return;
        switch(envelope.type){
            case XCHK_SIGN_REQ:  this.handleSignReq(envelope).catch(e => logger.error('StateCheckpointEngine: SIGN_REQ error: ' + (e && e.message))); break;
            case XCHK_SIGN:      this.handleSign(envelope);      break;
            case XCHK_FINALIZED: this.handleFinalized(envelope).catch(e => logger.error('StateCheckpointEngine: FINALIZED error: ' + (e && e.message))); break;
        }
    }

    // Mirror CrossChainDexEngine._persistCapabilitySnapshot: the ANCHOR verifier
    // on the DOGE indexer resolves oracle_publish from the mirrored snapshots.
    async _persistCapabilitySnapshot(capability, block){
        let validators = await this.resolveCapabilityValidators(capability, block);
        // SWQ-TRUNC-MIRROR: never mirror a TRUNCATED set. The `.truncated`
        // marker resolveCapabilityValidators carries is what makes this hub's own
        // meetsStakeThreshold fail closed on an over-cap snapshot, but it is a JS array
        // property and capability_snapshots has no column for it, so persisting the capped
        // rows hands the off-BTC (DOGE/LTC) indexer verifiers a partial set they read back
        // as COMPLETE (xchain-indexer getCapabilitySnapshotWeights sets no `truncated`).
        // They would then clear the strict 2/3 bar against an under-counted stake
        // denominator S and finalize what this hub rejects: an accept/reject divergence on
        // a consensus path, reachable organically once the federation outgrows the source
        // cap and deliberately via key-spam stake eviction. Writing nothing leaves the
        // mirror empty, so the off-BTC read yields S=0 and fails closed through the same
        // predicate as everything else. The window ends when operators raise the cap
        // (coordinated), which is the design's already-stated posture.
        if(validators && validators.truncated === true){
            logger.warn('StateCheckpointEngine: refusing to persist a TRUNCATED ' + capability +
                         ' capability snapshot at block ' + block +
                         ' (over the source cap; raise VALIDATOR_QUERY_LIMIT fleet-wide). No rows mirrored.');
            return;
        }
        // Write the whole set in ONE statement. A per-row loop left the mirror PARTIAL
        // whenever any single INSERT threw, and a partial set carries no completeness
        // marker, so it reads back as COMPLETE and under-counts S exactly the way the
        // truncated set above would. Rationale and the "do not chunk" rule live in
        // lib/capability_snapshot_write.js; broadcast stays here, per writer.
        let rows = await snapWrite.writeCapabilitySnapshotRows(this.db, capability, block, validators);
        for(let row of rows){
            // Select the row back by (block, capability, pubkey, SOURCE),
            // matching the widened uq_cap_snap. A pubkey-only select-back returned
            // just ONE of a multi-source key's rows (LIMIT 1), so the mirror stream
            // carried a single source and the downstream indexer never saw the
            // second. Inert below SWQ, where source='' and there is one row per key.
            await this.broadcastRowOrResync(
                'capability_snapshots',
                () => this.db.getCapabilitySnapshot(block, capability, row.signing_pubkey, row.source),
                'capability-snapshot broadcast gap');
        }
    }

    // Stream a row this hub has ALREADY committed to hub-DB mirror subscribers, and
    // repair the stream when it cannot be delivered.
    //
    // HubDbBroadcaster.broadcastWatermark advances on its own wall clock and tells every
    // subscriber "you have every row produced through ts"; a consumer's only gap repair is
    // the max_ids catch-up in its bootstrap, which runs at connect time. state_checkpoints
    // is a HUB_STATE_TABLES member with no FULL_REPAGE re-page, so a dropped row leaves the
    // mirror certifying completeness past a committed, quorum-signed checkpoint until the
    // socket happens to reconnect. A throw from the re-read and a zero-row result are the
    // same undeliverable row event, and dropAllForResync is the sanctioned repair (the
    // OracleConsensus.finalize price-round path is the in-repo precedent).
    //
    // Never throws to the caller: the row is committed, so the cadence-latch advance, the
    // log line and the checkpoint:finalized emit must still run. Only DELIVERY becomes
    // non-fatal here; the INSERTs above and the rootless-checkpoint refusal stay fail-closed.
    // The empty-subscriber short-circuit also keeps the per-validator loop in
    // _persistCapabilitySnapshot from re-firing the repair once the first drop emptied the set.
    //
    // `readRows` is the caller's committed-row re-read (a named db method bound to the row's
    // key), called only when there is a subscriber to deliver to, so no statement runs for
    // an empty set.
    async broadcastRowOrResync(table, readRows, reason){
        let b = this.broadcaster;
        if(!b) return;
        if(b.subscribers && b.subscribers.size === 0) return;   // nothing to gap
        let failure = null;
        try {
            let rows = await readRows();
            if(rows && rows.length){
                for(let row of rows) b.broadcastRow({ table: table, row: row });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }
        logger.error('StateCheckpointEngine: could not stream a committed ' + table +
                      ' row to mirror subscribers (' + failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync(reason); }
        catch(_e){ /* the repair itself must never fail a committed checkpoint */ }
    }
}

// The statics keep the descriptors `static` would give them (installParts: non-enumerable,
// writable, configurable), and the method groups go onto the prototype in list order.
installParts(StateCheckpointEngine, [canonicalForms]);

const PART_METHODS = [
    optionMethods,
    cadenceMethods,
    statsMethods,
    roundMethods,
    signMethods,
    finalizeMethods,
    sourceMethods
];
installParts(StateCheckpointEngine.prototype, PART_METHODS);

module.exports = Object.assign(StateCheckpointEngine, {
    XCHK_SIGN_REQ,
    XCHK_SIGN,
    XCHK_FINALIZED
});
