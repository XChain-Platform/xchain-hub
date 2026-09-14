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
 * XChain Hub - DEX Match Finalization
 *
 * From a matched pair to a durable row: the match id and the row a round proposes, the
 * fail-closed write of a finalized match, its mirror to indexers, and the retraction a
 * source-chain reorg applies.
 *
 ********************************************************************/

const crypto = require('crypto');
const { relayMarginFloorS } = require('../../lib/relay_margin.js');
const { normalizeRetractionBounds } = require('../../lib/retraction_bounds.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    async finalizeMatch(desc){
        let snapshotBlock = await this.resolveSnapshotBlock();
        if(snapshotBlock == null) throw new Error('cannot resolve snapshot block');

        let lo = desc.lo, hi = desc.hi;
        let matchId       = this._deriveMatchId(lo, hi, snapshotBlock, desc.loFilledBefore, desc.hiFilledBefore);
        if(this._inflight.has(matchId)) return;        // already in a round this poll
        // Forward propagation margin (#4202). A match settles on BOTH legs at the
        // first block whose block_time reaches effective_time, so stamping the bare
        // clock second made the match eligible the instant it finalized: an indexer
        // that already held the mirrored row settled a block earlier than one still
        // receiving it, and the two then carried different settlement action indexes
        // for the same match. Size the margin to the SLOWER of the two legs, since
        // both chains must hold the row before either reaches its eligible block.
        let effectiveTime = this._nowSeconds() +
            Math.max(relayMarginFloorS(lo.home_coin), relayMarginFloorS(hi.home_coin));

        let row = this.buildMatchRow(desc, matchId, snapshotBlock, effectiveTime);
        if(!(await this.stampMatchAdmission(row, matchId))) return;

        // Resolve the cross_chain validator set at snapshot_block (deterministic,
        // BTC-anchored) so every node computes the same quorum. The leader of the
        // round persists + mirrors these rows to indexers (in consensus PROPOSE).
        let validators = await this.resolveCapabilityValidators('cross_chain', Number(snapshotBlock), row.network);

        // Reserve this fill in-flight so a later poll doesn't re-propose it before the
        // committed ledger is updated by writeFinalizedMatch.
        this._inflight.add(matchId);
        try {
            // Run the PBFT round. quorum 0 (single operator) self-signs + finalizes inline;
            // a federation gathers 2f+1 independent signatures, then 'match:finalized' fires
            // and writeFinalizedMatch writes + mirrors the row.
            await this.consensus.propose(matchId, { row: row, snapshot: { validators: validators, count: validators.length } });
        } catch(e){
            this._inflight.delete(matchId);            // round failed to start; allow a retry
            throw e;
        }
    },

    buildMatchRow(desc, matchId, snapshotBlock, effectiveTime){
        let lo = desc.lo, hi = desc.hi;
        // lo = canonical-lower. On lo's chain, lo's escrow releases to hi's payout
        // (hi.get_address, hi's receive addr on lo's chain). On hi's chain, hi's escrow
        // releases to lo's payout. a_amount/b_amount = the FILL settled by THIS match.
        let row = {
            match_id:        matchId,
            snapshot_block:  Number(snapshotBlock),
            network:         desc.network,             // lo.home_network == hi.home_network (enforced in tryMatch)
            a_chain:         lo.home_coin,
            a_action_index:  Number(lo.action_index),
            a_kind:          desc.loKind,
            a_tick:          lo.give_tick || null,
            a_amount:        String(desc.loFill),
            a_filled_before: String(desc.loFilledBefore),
            a_ownership:     Number(lo.give_ownership || 0),
            a_payout_addr:   lo.get_address,           // A receives on hi's chain
            // Controller-guard royalty split of each order's proceeds (JSON [{to,bps}] in the
            // order's OWN chain encoding, or null). Copied verbatim from the source indexer's
            // open-order feed; the proceeds chain re-encodes + applies it at cross_settle. At/
            // above the CROSS_CHAIN_ROYALTY flag-day the legs are part of the signed canonical.
            a_payout_legs:   lo.payout_legs || null,
            b_chain:         hi.home_coin,
            b_action_index:  Number(hi.action_index),
            b_kind:          desc.hiKind,
            b_tick:          hi.give_tick || null,
            b_amount:        String(desc.hiFill),
            b_filled_before: String(desc.hiFilledBefore),
            b_ownership:     Number(hi.give_ownership || 0),
            b_payout_addr:   hi.get_address,           // B receives on lo's chain
            b_payout_legs:   hi.payout_legs || null,
            effective_time:  effectiveTime,
            // Per-leg source-chain reorg fence (item 5308): each leg lives on its own
            // chain with its own generation, stamped from that side's open-order RPC. A
            // source reorg retraction for chain C fences only the leg on C by its
            // generation, so a re-published order at a recycled action_index survives.
            // Metadata only; NOT part of the signed canonical.
            a_push_generation: Number(lo.push_generation) || 0,
            b_push_generation: Number(hi.push_generation) || 0
        };
        return row;
    },

    // Persist a consensus-finalized match (2f+1 signatures attached) and mirror it. Update
    // the committed ledger only when the row is actually inserted (INSERT IGNORE), so a
    // duplicate finalize (another hub / restart race) never double-counts a fill.
    async writeFinalizedMatch(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view = ev.view != null ? ev.view : 0;   // PBFT view at finalization; signed into the EQUIV canonical (WI-2 bump 2)
        // EVERY hub persists the capability snapshot for the row's snapshot_block,
        // not just the round leader: the indexers verify the row's signatures
        // against capability_snapshots in whichever hub DB they mirror, and a
        // follower's DB may be the only one they read. Deterministic from BTC
        // stakes + idempotent (INSERT IGNORE), so all hubs write identical rows.
        //
        // FAIL CLOSED (item 2385): the match row + committed-ledger fill below depend
        // on this snapshot existing, so the persist is a precondition, not a best-effort
        // side-write. A swallowed DB throw, OR a silent zero-row persist (the sentinel
        // CapabilitySnapshot degrades to [] on an indexer RPC error / 401-403, so the
        // INSERT loop never runs, never throws, never warns), would leave a finalized,
        // mirrored, ledger-applied match whose validator_signatures no mirror can verify
        // against capability_snapshots: exactly the condition the ordering above exists
        // to prevent. On either failure we skip the insert/commit, drop the in-flight
        // reservation, and forget the finalized round id so the next poll re-proposes the
        // match cleanly (same defer-and-retry posture retractMatchesForReorg uses).
        let persistedRows = 0;
        try {
            persistedRows = await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            logger.error('CrossChainDex: snapshot persist on finalize FAILED (fail-closed; deferring match ' +
                          String(row.match_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.deferFinalize(row);
            return;
        }
        if(!persistedRows){
            logger.error('CrossChainDex: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          row.snapshot_block + ' (degraded/empty validator set; fail-closed, deferring match ' +
                          String(row.match_id).substring(0, 16) + '... to a later round)');
            this.deferFinalize(row);
            return;
        }
        // The durable INSERT is the fill, so account it in the reservation ledger BEFORE
        // any fallible delivery step. A write that throws means nothing was committed
        // here: defer it exactly as the two preconditions above do, so the next poll
        // re-proposes rather than the round staying in-flight and retired forever.
        let inserted;
        try {
            inserted = await this._insertMatchRow(row);
        } catch(e){
            logger.error('CrossChainDex: finalized match row write FAILED (fail-closed; deferring match ' +
                          String(row.match_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.deferFinalize(row);
            return;
        }
        if(inserted) this.applyCommit(row, +1);
        this._inflight.delete(row.match_id);
        await this.mirrorMatchRow(row);
        logger.info('CrossChainDex: finalized ' + String(row.match_id).substring(0, 16) + '... ' +
                    row.a_chain + ':' + row.a_action_index + ' ⇄ ' + row.b_chain + ':' + row.b_action_index +
                    ' [' + row.a_kind + '/' + row.b_kind + '] fill ' + row.a_amount + '⇄' + row.b_amount +
                    ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('match:finalized', { matchId: row.match_id });
    },

    // Release a match that finalized in PBFT but whose write refused or failed, so the
    // next poll can re-propose it. Both releases are needed: _inflight gates the poll
    // and the consensus finalized-ring refuses to re-run a match id it has retired. No
    // 'match:finalized' event is emitted, because nothing was written in this hub's DB.
    // Named and shaped to match CrossChainCallEngine.deferFinalize; the two engines are
    // kept in lockstep by design.
    deferFinalize(row){
        this._inflight.delete(row.match_id);
        if(this.consensus && typeof this.consensus.forgetFinalized === 'function')
            this.consensus.forgetFinalized(row.match_id);
    },

    // Returns true iff the row was actually inserted (false on INSERT IGNORE dedupe), so the
    // caller only updates the committed ledger once per fill.
    async _insertMatchRow(row){
        // Resolved into the value list rather than onto `row`: the row object is what the
        // canonical, the ledger and the retraction paths read, and btc_chain_id is transport,
        // never consensus. _canonicalMatch enumerates its fields explicitly, so this value has
        // no path into a signed preimage. The column list and the statement live in
        // db.createCrossChainMatch.
        let btcChainId = await this.resolveBtcChainId(row.network);
        // INSERT IGNORE: match_id is unique, so a re-finalize (e.g. another hub or a
        // restart racing the poll) is a harmless no-op.
        let res = await this.db.createCrossChainMatch(row, btcChainId);
        let inserted = !!(res && Number(res.affectedRows) > 0);
        // A retracted row keeps its (unique) match_id. When a reorg retracts a crossing and the
        // SAME crossing re-forms at the same BTC snapshot_block, _deriveMatchId yields the
        // identical id, so the INSERT IGNORE above no-ops against the stale 'retracted' row and
        // the re-formed match would be stranded (never settled, committed capacity never
        // re-applied) until the BTC tip advances and yields a new snapshot_block/id. Revive the
        // retracted row to 'finalized' with THIS round's signatures and treat the revive as a
        // fresh insert so the committed-fill ledger is re-applied. A row already 'finalized' is
        // left untouched (status='retracted' guard), preserving the double-finalize dedupe so a
        // genuine duplicate finalize never double-counts a fill.
        if(!inserted){
            let revive = await this.db.updateCrossChainMatchByMatchId(row.validator_signatures, row.finalizing_view, row.effective_time, row.match_id);
            if(revive && Number(revive.affectedRows) > 0) inserted = true;
        }
        // The indexer mirror deliberately does NOT happen here. A throw between the durable
        // write and this return skips the caller's `if(inserted) this.applyCommit(row, +1)`
        // and leaves a finalized fill in the DB with no reservation in the in-memory ledger;
        // the next poll then re-offers the same escrow, and since the ledger only rebuilds at
        // start(), that divergence survives until a restart. writeFinalizedMatch credits the
        // ledger first and mirrors afterwards through mirrorMatchRow, which cannot throw.
        return inserted;
    },

    // Stream a match row this hub has ALREADY committed to hub-DB mirror subscribers.
    // Never throws: the fill is durable and the ledger has been credited, so a delivery
    // failure must not skip the caller's tail. A throw from the re-read and a zero-row
    // result are the same undeliverable-row event, and dropAllForResync is the sanctioned
    // repair (StateCheckpointEngine.broadcastRowOrResync and the OracleConsensus
    // price-round path are the in-repo precedents): the watermark heartbeat advances on
    // its own wall clock and would otherwise certify completeness past a committed,
    // quorum-signed match until the socket happened to reconnect.
    async mirrorMatchRow(row){
        let b = this.broadcaster;
        if(!b) return;
        if(b.subscribers && b.subscribers.size === 0) return;   // nothing to gap
        let failure = null;
        try {
            let read = await this.db.getCrossChainMatchByMatchId(row.match_id);
            if(read && read.length){
                b.broadcastRow({ table: 'cross_chain_matches', row: read[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }
        logger.error('CrossChainDex: could not stream a committed cross_chain_matches row to mirror ' +
                      'subscribers (' + failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync('cross_chain_matches mirror gap'); }
        catch(_e){ /* the repair itself must never fail a committed match */ }
    },

    // Mark matches referencing a rolled-back source order as retracted and broadcast a
    // deletion so indexers skip / roll back. Called by reorg handling.
    // toActionIndex (optional) bounds the retraction to a CLOSED range [from, to] on the matching
    // leg for a DEFERRED retraction, so a match re-published inside the original open-ended range is
    // not retracted (item 5296). Absent => open-ended, the live behavior. Two-sided: the bound
    // applies to whichever leg (a/b) is on the reorged chain. The bound rides each broadcastDeletion.
    // retractionGeneration (optional, item 5308): each leg carries its OWN generation
    // (a_push_generation / b_push_generation). When present, the per-leg clause additionally
    // requires that leg's generation <= it, so a leg re-finalized at a recycled source action_index
    // (higher generation, post-rollback) survives. Omitted (older indexer) => no fence.
    async retractMatchesForReorg(chain, fromActionIndex, toActionIndex, retractionGeneration){
        // Fail-closed on a SUPPLIED-but-invalid bound: without it a malformed to/generation would
        // collapse into the absent branch and widen this into an open-ended retraction, which also
        // restores capacity via _applyCommit below, and a raw lower bound would reach SQL uncoerced.
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if(bounds.error) throw new Error(bounds.error);
        let { from, to, gen, bounded, fenced } = bounds;
        // Per-leg clause for whichever side is on the reorged chain, fenced by THAT leg's
        // generation; the statement is db.findFinalizedCrossChainMatchesForReorg.
        let rows = await this.db.findFinalizedCrossChainMatchesForReorg(chain, from, to, gen, bounded, fenced);
        for(let r of rows){
            await this.db.updateCrossChainMatchRetracted(r.match_id);
            this.applyCommit(r, -1);                   // restore both legs' remaining capacity
            this._inflight.delete(r.match_id);
            // Clear the consensus finalized-ring entry (M-13): the match_id is the
            // round id, and without this a match re-formed after this reorg can never
            // re-finalize (propose() no-ops on a finalized id), stranding it in 'retracted'.
            this.consensus.forgetFinalized(r.match_id);
            if(this.broadcaster){
                let evt = { table: 'cross_chain_matches', source_chain: chain, from_action_index: from };
                if(bounded) evt.to_action_index = to;
                if(fenced) evt.retraction_generation = gen;
                // Ride the retraction-signing round when active (the round
                // dedups the per-row repeats by canonical); legacy unsigned otherwise.
                if(this.hub && this.hub.retractionConsensus)
                    this.hub.retractionConsensus.submitLocal(evt).catch(e => logger.error('CrossChainDex: retraction submit error: ' + (e && e.message)));
                else
                    this.broadcaster.broadcastDeletion(evt);
            }
        }
    },

    // Deterministic match identifier (sha256 hex; satisfies the indexer's
    // /^[0-9a-zA-Z_-]{1,80}$/ MATCH_ID rule). lo/hi are already canonical-ordered (lo =
    // home_coin-lower). Binds network + both offer refs + snapshot block + each leg's
    // cumulative-filled-before offset, so two sequential partial fills of the SAME order
    // pair at the SAME snapshot_block produce DISTINCT ids (offsets normalized so
    // "0" == "0.00000000").
    _deriveMatchId(lo, hi, snapshotBlock, loFilledBefore, hiFilledBefore){
        let s = (lo.home_network || '') +
                '|' + lo.home_coin + ':' + lo.action_index + ':' + this.normalizeAmount(loFilledBefore) +
                '|' + hi.home_coin + ':' + hi.action_index + ':' + this.normalizeAmount(hiFilledBefore) +
                '|' + snapshotBlock;
        return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
    },

    // The chain instance this hub's matches belong to: the hash of BTC block 1 on the chain
    // its Bitcoin indexer follows, reported through pushchaintip. Stamped on the row so a
    // mirror that survived a re-genesis can refuse a match minted on the dead chain instead
    // of re-evaluating it at every block forever. Unknown reads as NULL, which every mirror
    // accepts, and a lookup failure must never fail a finalized match, so it degrades to NULL.
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
