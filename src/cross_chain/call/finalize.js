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
 * XChain Hub - Call Row Persistence
 *
 * Writing, mirroring and retracting a finalized relay row, and the retraction fence that
 * catches a reorg landing while a write is parked in its awaits: the one record of a
 * retraction that owns no row yet.
 *
 ********************************************************************/

const { normalizeRetractionBounds } = require('../../lib/retraction_bounds.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // The in-flight round set and the retraction fence a finalize write re-checks.
    initRoundTracking(){
        // Round ids currently in PBFT but not yet written (mirrors DexEngine._inflight).
        this._inflight = new Set();

        // Retractions this hub applies, recorded even when they match no persisted row.
        // retractCallsForReorg fences rows that are already in the table; a finalize write
        // still parked in its awaits owns no row yet, so the retraction passes it by and the
        // resumed write inserts and mirrors an executable dispatch the reorg already removed.
        // Each entry carries a monotonic sequence, each pending write remembers the sequence
        // it started at, and the write re-checks this list immediately before its insert.
        // Entries older than every pending write serve no one and are pruned, so the list
        // needs no expiry knob. It is per process: a crash takes the pending write with it.
        this._retractionFence = [];
        this._retractionSeq   = 0;
        this._pendingWrites   = new Set();
    },

    async writeFinalizedRow(ev){
        let row = ev.row;
        // Sequence this write against the retraction fence before the first await. Every
        // retraction recorded from here on is one this write has to answer for, and the
        // registration keeps those entries alive while the awaits below run.
        // The token is an object, not the number: concurrent writes share a start sequence
        // and a Set of numbers would let one write's completion unregister the other.
        this.ensureRetractionFence();
        let token = { seq: this._retractionSeq };
        this._pendingWrites.add(token);
        try {
            await this.writeFinalizedRowFenced(ev, row, token.seq);
        } finally {
            this._pendingWrites.delete(token);
            this.pruneRetractionFence();
        }
    },

    async writeFinalizedRowFenced(ev, row, startSeq){
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view = ev.view != null ? ev.view : 0;   // PBFT view at finalization; signed into the EQUIV canonical
        if(!(await this.persistRowSnapshot(row))) return;
        // Resolved into the value list rather than onto `row`: the row object feeds the
        // canonical and the retraction paths, and btc_chain_id is transport, never consensus.
        // The XCALL canonical enumerates its fields explicitly, so this value has no path
        // into a signed preimage.
        let btcChainId = await this.resolveBtcChainId(row.network);
        // Last gate before the insert, after every await on this path. A retraction that
        // landed while this write was parked owns no row to flip, so the fence is the only
        // record of it. Take the same fail-closed exit the persist failures take: no insert,
        // no mirror, round released, so a later poll re-proposes only if the source chain
        // still carries the call.
        if(this.retractedSince(startSeq, row)){
            logger.warn('CrossChainCall: retraction landed while finalizing ' + row.phase + ' ' +
                         String(row.call_id).substring(0, 16) + '... (' + row.source_chain + ':' +
                         row.source_action_index + '); skipping the row write and the mirror');
            this.deferFinalize(row);
            return;
        }
        // The row write is an upsert (db/cross_chain.js setCrossChainCallFinalized), so a
        // reorg-retracted twin for the same (call_id, phase) is overwritten, not skipped.
        // The row write sits OUTSIDE the recovery the snapshot persist above gets, and it
        // is the same precondition: a throw here means this hub finalized nothing, yet the
        // listener's bare .catch left _inflight set and the round retired in consensus.
        // The round id is derived from phase + call_id alone, so every later dispatch poll
        // returned at `if(this._inflight.has(roundId)) return` and no poll could ever
        // recover the dispatch or the result, even after the DB came back. Defer instead:
        // the upsert wrote nothing, so rowExists still reports the call open and the next
        // poll re-proposes cleanly.
        try {
            await this.db.setCrossChainCallFinalized(row, btcChainId);
        } catch(e){
            logger.error('CrossChainCall: finalized ' + row.phase + ' row write FAILED (fail-closed; deferring ' +
                          String(row.call_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.deferFinalize(row);
            return;
        }
        // Release the in-flight slot BEFORE the mirror: the row is durable, so a delivery
        // failure must not wedge the round. mirrorCallRow cannot throw.
        this._inflight.delete(row.round_id);
        await this.mirrorCallRow(row);
        logger.info('CrossChainCall: finalized ' + row.phase + ' ' + String(row.call_id).substring(0, 16) + '... ' +
                    row.source_chain + ':' + row.source_action_index + ' -> ' + row.target_chain + ':' + row.target_contract_index +
                    (row.phase === 'result' ? (' [' + row.result_status + ']') : '') +
                    ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('call:' + row.phase, { callId: row.call_id });
    },

    async persistRowSnapshot(row){
        // EVERY hub persists the capability snapshot for the row's snapshot_block,
        // not just the round leader: the indexers verify the row's signatures
        // against capability_snapshots in whichever hub DB they mirror, and a
        // follower's DB may be the only one they read. Deterministic from BTC
        // stakes + idempotent (INSERT IGNORE), so all hubs write identical rows.
        //
        // FAIL CLOSED, on the rationale CrossChainDexEngine.writeFinalizedMatch spells
        // out in full (item 2385): the persist is a PRECONDITION of the row below, not a
        // best-effort side-write. A swallowed DB throw, or a silent zero-row persist (the
        // sentinel snapshot degrades to [] on an indexer RPC error / 401-403, so the
        // INSERT loop never runs, never throws, never warns), would commit and broadcast
        // a finalized XCALL/XEXEC row whose validator_signatures no capability_snapshot
        // in this hub's DB can verify. On either failure skip the insert/broadcast, drop
        // the in-flight reservation, and forget the finalized round so a later poll
        // re-proposes cleanly, exactly as retractCallsForReorg does. The two engines are
        // kept in lockstep by design; this is the error path that had drifted.
        let persistedRows = 0;
        try {
            persistedRows = await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            logger.error('CrossChainCall: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                          row.phase + ' ' + String(row.call_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.deferFinalize(row);
            return false;
        }
        if(!persistedRows){
            logger.error('CrossChainCall: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          row.snapshot_block + ' (degraded/empty validator set; fail-closed, deferring ' +
                          row.phase + ' ' + String(row.call_id).substring(0, 16) + '... to a later round)');
            this.deferFinalize(row);
            return false;
        }
        return true;
    },

    // Release a round that finalized in PBFT but whose fail-closed precondition refused
    // the write, so the next poll can re-propose it. Both releases are needed: _inflight
    // gates the poll (`if(this._inflight.has(roundId)) return;`) and the consensus
    // finalized-ring refuses to re-run a round id it has already retired. No 'call:'
    // event is emitted, because nothing was finalized in this hub's DB.
    // Record a retraction this hub applies, before it looks for rows to flip, so a write
    // that is mid-await is fenced whether or not the retraction finds anything to update.
    // Bounds arrive already normalized by normalizeRetractionBounds, so the predicate here
    // and the SQL predicate in retractCallsForReorg read the same fields the same way.
    // Bring the fence fields up on an instance that reaches these paths without the
    // constructor, which several suites build with Object.create(Engine.prototype).
    ensureRetractionFence(){
        if(!this._retractionFence) this._retractionFence = [];
        if(!this._pendingWrites)   this._pendingWrites   = new Set();
        if(typeof this._retractionSeq !== 'number') this._retractionSeq = 0;
    },

    recordRetraction(chain, bounds){
        this.ensureRetractionFence();
        this._retractionFence.push({
            seq: ++this._retractionSeq,
            chain: String(chain),
            from: bounds.from, to: bounds.to, gen: bounds.gen,
            bounded: bounds.bounded, fenced: bounds.fenced
        });
        this.pruneRetractionFence();
    },

    // Drop fence entries no pending write can still consult: a write only reads entries
    // recorded after it started, so anything at or below the oldest pending write's start
    // sequence is unreachable. With no write pending the whole list is unreachable.
    pruneRetractionFence(){
        this.ensureRetractionFence();
        let floor = this._retractionSeq;
        for(let t of this._pendingWrites) if(t.seq < floor) floor = t.seq;
        this._retractionFence = this._retractionFence.filter(e => e.seq > floor);
    },

    // True when a retraction recorded after `sinceSeq` covers this row. The predicate
    // mirrors retractCallsForReorg's SQL tail: same source chain, index at or above the
    // lower bound, within the closed upper bound when the retraction is bounded, and at or
    // below the fenced generation when it is generation-fenced.
    retractedSince(sinceSeq, row){
        this.ensureRetractionFence();
        let idx = Number(row.source_action_index);
        let gen = Number(row.push_generation || 0);
        return this._retractionFence.some(e =>
            e.seq > sinceSeq &&
            e.chain === String(row.source_chain) &&
            idx >= e.from &&
            (!e.bounded || idx <= e.to) &&
            (!e.fenced  || gen <= e.gen));
    },

    deferFinalize(row){
        this._inflight.delete(row.round_id);
        if(this.consensus && typeof this.consensus.forgetFinalized === 'function')
            this.consensus.forgetFinalized(row.round_id);
    },

    // Stream a cross_chain_calls row this hub has ALREADY committed to hub-DB mirror
    // subscribers. Never throws: the row is durable and the in-flight slot released, so a
    // delivery failure must not wedge the round or skip the caller's tail. A throw from
    // the re-read and a zero-row result are the same undeliverable-row event, and
    // dropAllForResync is the sanctioned repair (StateCheckpointEngine
    // .broadcastRowOrResync and the OracleConsensus price-round path are the in-repo
    // precedents), because the watermark heartbeat would otherwise certify completeness
    // past a committed, quorum-signed call row until the socket happened to reconnect.
    async mirrorCallRow(row){
        let b = this.broadcaster;
        if(!b) return;
        if(b.subscribers && b.subscribers.size === 0) return;   // nothing to gap
        let failure = null;
        try {
            let read = await this.db.getCrossChainCallByCallIdAndPhase(row.call_id, row.phase);
            if(read && read.length){
                b.broadcastRow({ table: 'cross_chain_calls', row: read[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }
        logger.error('CrossChainCall: could not stream a committed cross_chain_calls row to mirror ' +
                      'subscribers (' + failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync('cross_chain_calls mirror gap'); }
        catch(_e){ /* the repair itself must never fail a committed call row */ }
    },

    // Should be unreachable past the confirmation gate; kept as the same
    // defense-in-depth the DEX has. Marks BOTH phases retracted (a dispatch
    // whose request vanished must not produce a callback) and broadcasts a
    // mirror deletion so indexers that have not yet injected skip the rows.
    // The hub row is kept (status='retracted', match model) so the ANCHOR
    // archive re-archives the status drift and recovery never resurrects a
    // retracted call as injectable.
    // toActionIndex (optional) bounds the retraction to a CLOSED range [from, to] for a DEFERRED
    // retraction, so a relay row re-published inside the original open-ended range is not retracted.
    // Absent => open-ended, the live behavior. The bound rides the broadcastDeletion so
    // replicas mirror the same delete.
    // retractionGeneration (optional): when present, only rows stamped push_generation <=
    // it are retracted, so a relay row re-finalized at a recycled source action_index (higher
    // generation, post-rollback) survives even inside [from, to]. Omitted (older indexer) => no fence.
    async retractCallsForReorg(chain, fromActionIndex, toActionIndex, retractionGeneration){
        // Fail-closed on a SUPPLIED-but-invalid bound: without it a malformed to/generation would
        // collapse into the absent branch and drop the range/fence clause, and a raw lower bound
        // bound into SQL is coerced by MariaDB from nonnumeric to 0 (retracting the whole chain).
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if(bounds.error) throw new Error(bounds.error);
        let { from, to, gen, bounded, fenced } = bounds;
        // Fence the in-process writes FIRST, before the select decides whether any persisted
        // row matches. A round whose row is not inserted yet is invisible to the SQL below,
        // and the early return on an empty select leaves no other trace of this retraction.
        this.recordRetraction(chain, bounds);
        let rows = await this.db.findFinalizedCrossChainCallsInRetractionRange(chain, bounds);
        if(!rows.length) return;
        await this.db.updateCrossChainCallsRetractedInRange(chain, bounds);
        for(let r of rows){
            let rid = this._roundId(r.phase, String(r.call_id));
            this._inflight.delete(rid);
            // Clear the consensus finalized-ring entry too (M-13): without this the
            // round can never re-run, so a call re-confirmed after this reorg stays
            // stranded in 'retracted'. Also drops any result-relay backoff so the
            // re-confirmed call re-enters the hot poll window immediately.
            this.consensus.forgetFinalized(rid);
            this._resultBackoff.delete(String(r.call_id).toLowerCase());
        }
        if(this.broadcaster){
            let evt = { table: 'cross_chain_calls', source_chain: chain, from_action_index: from };
            if(bounded) evt.to_action_index = to;
            if(fenced) evt.retraction_generation = gen;
            // Quorum-class deletions ride the retraction-signing round when
            // active (2f+1 co-signatures before mirrors will delete); legacy unsigned
            // broadcast otherwise. submitLocal always records the local intent so this
            // hub can co-sign peers' rounds for the same reorg.
            if(this.hub && this.hub.retractionConsensus)
                this.hub.retractionConsensus.submitLocal(evt).catch(e => logger.error('CrossChainCall: retraction submit error: ' + (e && e.message)));
            else
                this.broadcaster.broadcastDeletion(evt);
        }
        logger.warn('CrossChainCall: retracted ' + rows.length + ' relay row(s) for ' + chain +
                     ' reorg below action ' + from + (bounded ? ' (bounded <= ' + to + ')' : '') +
                     (fenced ? ' (gen <= ' + gen + ')' : '') + ' (should not happen past confirmation depth)');
    },

    async rowExists(callId, phase){
        let rows = await this.db.hasCrossChainCalls(callId, phase);
        return rows.length > 0;
    },

    // The chain instance this hub's rows belong to: the hash of BTC block 1 on the chain its
    // Bitcoin indexer follows, reported through pushchaintip. Stamped on call rows so a mirror
    // that survived a re-genesis can refuse a call minted on the dead chain. Unknown reads as
    // NULL, which every mirror accepts, and a lookup failure must never fail a finalized row,
    // so it degrades to NULL. Twin of CrossChainDexEngine.resolveBtcChainId; keep in lockstep.
    async resolveBtcChainId(network){
        try {
            if(!this.db || typeof this.db.getChainTip !== 'function') return null;
            let tip = await this.db.getChainTip('bitcoin', network || this.network || '');
            return (tip && tip.chainId) ? tip.chainId : null;
        } catch(e){
            return null;
        }
    },
};
