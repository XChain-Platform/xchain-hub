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
 * XChain Hub - Bridge Record Persistence
 *
 * Writing, mirroring and retracting what a round finalized: the fail-closed snapshot
 * precondition both families share, the deferral that releases a round whose write refused,
 * and the source-reorg retraction of transfer records.
 *
 ********************************************************************/

const { normalizeRetractionBounds } = require('../../lib/retraction_bounds.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // ---------------------------------------------------------------------------
    // Persistence and mirroring
    // ---------------------------------------------------------------------------

    async writeFinalizedTransfer(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view      = ev.view != null ? ev.view : 0;
        if(!await this.persistSnapshotOrDefer(row, row.transfer_id, this.transferConsensus)) return;
        let inserted;
        // The chain-id resolution is inside the deferring try on purpose: it is the only await
        // between the source-leg guard being set and its release, and this handler runs from
        // an event .catch that only logs. A throw outside the try would leave
        // the leg guarded forever, which now also makes this hub refuse to CO-SIGN any later
        // transfer for it (_validateTransfer's in-flight half), so the leak would outlive the
        // round it belongs to. Deferring instead matches the fail-closed rule below.
        try {
            row.btc_chain_id = await this.resolveBtcChainId(row.network);
            inserted = await this.db.insertBridgeTransfer(row);
        }
        catch(e){
            logger.error('CrossChainBridge: finalized transfer write FAILED (fail-closed; deferring ' +
                          String(row.transfer_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.defer(row.transfer_id, this.transferConsensus);
            return;
        }
        this.releaseSourceLegGuard(row.transfer_id);
        if(!inserted) return;
        await this.mirrorRow('bridge_transfers', 'transfer_id', row.transfer_id);
        logger.info('CrossChainBridge: finalized transfer ' + String(row.transfer_id).substring(0, 16) + '... ' +
                    row.src_chain + ':' + row.src_action_index + ' -> ' + row.dest_chain + ' ' +
                    row.amount + ' ' + row.tick + ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('transfer:finalized', { transferId: row.transfer_id });
    },

    async writeFinalizedPolicy(ev){
        let row = ev.row;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view      = ev.view != null ? ev.view : 0;
        if(!await this.persistSnapshotOrDefer(row, row.snapshot_id, this.policyConsensus)) return;
        row.btc_chain_id = await this.resolveBtcChainId(row.network);
        let inserted;
        try { inserted = await this.db.insertPolicySnapshot(row); }
        catch(e){
            logger.error('CrossChainBridge: finalized policy snapshot write FAILED (fail-closed; deferring ' +
                          String(row.snapshot_id).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.defer(row.snapshot_id, this.policyConsensus);
            return;
        }
        this._inflight.delete(row.snapshot_id);
        if(!inserted) return;
        await this.mirrorRow('policy_snapshots', 'snapshot_id', row.snapshot_id);
        logger.info('CrossChainBridge: finalized policy snapshot ' + String(row.snapshot_id).substring(0, 16) +
                    '... ' + row.origin_chain + ':' + row.tick + ' seq ' + row.policy_seq +
                    ' (' + (ev.signatures ? ev.signatures.length : 0) + ' sigs)');
        this.emit('policy:finalized', { snapshotId: row.snapshot_id });
    },

    // EVERY hub persists the capability snapshot for the row's snapshot_block, not just the
    // round leader: indexers verify a row's signatures against capability_snapshots in
    // whichever hub DB they mirror, and a follower's DB may be the only one they read.
    //
    // FAIL CLOSED, the rule CrossChainDexEngine.writeFinalizedMatch spells out in full: the
    // persist is a PRECONDITION of the row, not a best-effort side write. A swallowed throw,
    // or a silent zero-row persist (the sentinel snapshot degrades to [] on an indexer RPC
    // error or a 401, so the insert loop never runs and never warns), would leave a
    // finalized, mirrored record whose signatures no mirror can verify. Returns false when
    // the caller must skip the write; the round is deferred so a later poll re-proposes it.
    async persistSnapshotOrDefer(row, roundId, consensus){
        let persisted = 0;
        try {
            persisted = await this._persistCapabilitySnapshot('cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            logger.error('CrossChainBridge: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                          String(roundId).substring(0, 16) + '... to a later round): ' + (e && e.message));
            this.defer(roundId, consensus);
            return false;
        }
        if(!persisted){
            logger.error('CrossChainBridge: snapshot persist wrote ZERO capability rows for snapshot_block ' +
                          row.snapshot_block + ' (degraded or empty validator set; fail-closed, deferring ' +
                          String(roundId).substring(0, 16) + '... to a later round)');
            this.defer(roundId, consensus);
            return false;
        }
        return true;
    },

    // Release a round that finalized in PBFT but whose write refused or failed, so the next
    // poll re-proposes it. BOTH releases are needed: _inflight gates the poll and the
    // consensus finalized-ring refuses to re-run a round id it has retired.
    defer(roundId, consensus){
        this.releaseSourceLegGuard(roundId);
        if(consensus && typeof consensus.forgetFinalized === 'function') consensus.forgetFinalized(roundId);
    },

    // Stream a row this hub has ALREADY committed to hub-DB mirror subscribers. Never
    // throws: the write is durable, so a delivery failure must not skip the caller's tail. A
    // throw from the re-read and a zero-row result are the same undeliverable-row event, and
    // dropAllForResync is the sanctioned repair, because the watermark heartbeat advances on
    // its own wall clock and would otherwise certify completeness past a committed row.
    async mirrorRow(table, keyColumn, keyValue){
        let b = this.broadcaster;
        if(!b) return;
        if(b.subscribers && b.subscribers.size === 0) return;
        let failure = null;
        try {
            // The table and key are a switch between the two committed-row reads this engine
            // streams, never text spliced into a statement. An unknown pair is the same
            // undeliverable-row event as an empty read, so it takes the resync path below.
            let read;
            if(table === 'bridge_transfers' && keyColumn === 'transfer_id')
                read = await this.db.getBridgeTransferByTransferId(keyValue);
            else if(table === 'policy_snapshots' && keyColumn === 'snapshot_id')
                read = await this.db.getPolicySnapshotBySnapshotId(keyValue);
            else
                throw new Error('no mirror read for ' + table + '.' + keyColumn);
            if(read && read.length){
                b.broadcastRow({ table: table, row: read[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }
        logger.error('CrossChainBridge: could not stream a committed ' + table + ' row to mirror subscribers (' +
                      failure + '); forcing subscriber resync');
        try { if(typeof b.dropAllForResync === 'function') b.dropAllForResync(table + ' mirror gap'); }
        catch(_e){ /* the repair itself must never fail a committed row */ }
    },

    // ---------------------------------------------------------------------------
    // Retraction
    // ---------------------------------------------------------------------------

    // Mark transfer records whose SOURCE leg was rolled back as retracted and broadcast the
    // deletion so indexers drop the mirrored row. A record that has NOT been applied is then
    // never applied; one already applied stays applied (D16, milestone 1 ships no
    // destination-side unwind), the invariant read reports the deficit and the watch CRITs.
    //
    // toActionIndex bounds a DEFERRED retraction to a CLOSED range so a leg re-published
    // inside the original open-ended range is not retracted; retractionGeneration fences it
    // to rows stamped at or below that generation, so a leg re-finalized at a recycled
    // source action_index survives. Both absent means the open-ended live behaviour.
    //
    // policy_snapshots has NO retraction path on purpose: the table is append-only, a later
    // policy_seq supersedes, and it carries no source-chain action index for a range delete.
    async retractTransfersForReorg(chain, fromActionIndex, toActionIndex, retractionGeneration){
        let bounds = normalizeRetractionBounds(fromActionIndex, toActionIndex, retractionGeneration);
        if(bounds.error) throw new Error(bounds.error);
        let { from, to, gen, bounded, fenced } = bounds;
        let rows = await this.db.findFinalizedBridgeTransferIdsForReorg(chain, from, to, gen, bounded, fenced);
        for(let r of rows){
            await this.db.updateBridgeTransfer(r.transfer_id);
            this.releaseSourceLegGuard(r.transfer_id);
            // Clear the consensus finalized-ring entry: the transfer_id is the round id, and
            // without this a transfer re-formed after this reorg could never re-finalize.
            this.transferConsensus.forgetFinalized(r.transfer_id);
            if(this.broadcaster){
                let evt = { table: 'bridge_transfers', source_chain: chain, from_action_index: from };
                if(bounded) evt.to_action_index = to;
                if(fenced)  evt.retraction_generation = gen;
                // Ride the retraction-signing round when active (a quorum-class retraction is
                // co-signed and the round dedupes the per-row repeats by canonical); legacy
                // unsigned broadcast otherwise.
                if(this.hub && this.hub.retractionConsensus)
                    this.hub.retractionConsensus.submitLocal(evt).catch(e =>
                        logger.error('CrossChainBridge: retraction submit error: ' + (e && e.message)));
                else
                    this.broadcaster.broadcastDeletion(evt);
            }
        }
        return rows.length;
    },
};
