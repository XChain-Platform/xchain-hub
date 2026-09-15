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
 * AttestationResponseMirror: the batch retraction
 *
 * Clears the batch link a reorged DOGE batch stamped, after re-deriving the batch
 * identity, and never deletes a row. Installed on
 * AttestationResponseMirror.prototype by src/attestation/response_mirror.js.
 *
 ********************************************************************/

'use strict';

const abw = require('../../lib/attest_batch_wire.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The retraction twin of receiveValidatedBatch (spec §6.3, frontier row 55). A reorg
    // on the DOGE rail un-landed a batch, so the link that batch stamped is no longer
    // backed by chain, and the indexer that rolled it back says so here.
    //
    // THIS CLEARS THE LINK AND NEVER DELETES A ROW. A mirror row is legitimate because
    // of the responsible set's signatures it carries, not because of which batch
    // happened to carry it here, so un-landing the batch says nothing about the row:
    // gossip usually delivered the same row hours earlier, and on a chain-only node the
    // batch-inserted row is the ONLY copy that exists. Deleting would turn a cosmetic
    // reorg on one rail into a permanent hole in the response history, which §4.4 calls
    // a fork rather than a lag. Setting `batch_action_index` back to NULL is also the
    // only thing that lets the batch re-land: linkBatchAction sets the column WHERE it
    // IS NULL, so a stale link would otherwise outlive the chain that justified it.
    //
    // THE IDENTITY IS CHECKED BEFORE ANYTHING IS CLEARED. The caller names the batch by
    // its key AND by the window bounds that key is derived from, and the key is
    // recomputed here rather than trusted, so a caller naming a window it did not land
    // clears nothing. The cleared rows are scoped to that window's own half-open
    // effective_time span, the same membership rule the publisher selects the window on.
    //
    // No reorg generation fence, unlike the price retraction: this table carries no
    // push_generation column, and the link is cosmetic by construction (D78: it is in no
    // state-hash preimage and the applier never reads it), so the worst a late deferred
    // retraction can do is drop a display link that the window's next landing restores.
    //
    // Returns { accepted, cleared, reason }.
    async retractBatchLink(sourceChain, retraction){
        let parsed = this.parseBatchRetraction(sourceChain, retraction);
        if(parsed.refused) return parsed.refused;
        let network     = parsed.network;
        let windowStart = parsed.windowStart;
        let windowEnd   = parsed.windowEnd;
        let actionIndex = parsed.actionIndex;

        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function')
            return this.refuseRetraction(sourceChain, 'mirror database not ready');

        // Read the affected rows BEFORE the clear: the re-broadcast below needs their
        // natural key, and after the UPDATE the link that selected them is gone.
        let linked = await db.findAttestationResponsesByNetwork(network, actionIndex, windowStart, windowEnd);

        // Nothing linked is an ACCEPTED no-op, not a rejection: a replayed retraction, a
        // batch that never reached this hub and an already-cleared link are all "nothing
        // to do", and answering with a rejection would keep the indexer's durable
        // retraction row (an uncapped push type) retrying that verdict forever.
        if(!linked || linked.length === 0)
            return { accepted: true, cleared: 0, reason: null };

        await db.updateAttestationResponseByNetwork(network, actionIndex, windowStart, windowEnd);

        // The cleared link has to travel the road the set link travelled, for the reason
        // the link's own re-broadcast states: insertAndBroadcast streams a row only on a
        // fresh insert, and these rows have been in the stream for hours.
        for(let row of linked) await this.rebroadcastRow(row);

        logger.info('AttestationResponseMirror: retracted the batch link for window ' +
                    windowStart + '-' + windowEnd + ' from ' + (sourceChain || 'unknown') +
                    ' action ' + actionIndex + ' (' + linked.length + ' row(s) unlinked)');
        return { accepted: true, cleared: linked.length, reason: null };
    },

    refuseRetraction(sourceChain, reason){
        logger.warn('AttestationResponseMirror: refusing batch retraction from ' +
                     (sourceChain || 'unknown') + ': ' + reason);
        return { accepted: false, cleared: 0, reason: reason };
    },

    // The retraction's own identity, re-derived rather than trusted: the batch key is
    // recomputed from the network and the signed window bounds, so a caller naming a
    // window it did not land clears nothing. Returns { refused } or the window it names.
    parseBatchRetraction(sourceChain, retraction){
        let refuse = (reason) => ({ refused: this.refuseRetraction(sourceChain, reason) });

        if(!retraction || typeof retraction !== 'object') return refuse('invalid retraction');

        let network = String(retraction.network == null ? '' : retraction.network);
        if(!network || network !== String(this.hub && this.hub.network))
            return refuse('retraction declares network "' + network + '", this hub serves "' +
                          String(this.hub && this.hub.network) + '"');

        // Strict for the reason the receive half states: Number(null) and Number('') are
        // both 0, and 0 is a real window start (the epoch) and a real action index.
        let intOrNaN = (v) => ((v === null || v === undefined || v === '') ? NaN : Number(v));

        let windowStart = intOrNaN(retraction.window_start);
        let windowEnd   = intOrNaN(retraction.window_end);
        if(!Number.isInteger(windowStart) || windowStart < 0 ||
           !Number.isInteger(windowEnd) || windowEnd <= windowStart)
            return refuse('invalid window bounds');

        let actionIndex = intOrNaN(retraction.action_index);
        if(!Number.isInteger(actionIndex) || actionIndex < 0) return refuse('invalid action_index');

        let batchKey = String(retraction.batch_key || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(batchKey)) return refuse('invalid batch_key');
        // Derived, never trusted. The key is sha256 over the network and the signed window
        // bounds, so recomputing it is what binds those three fields into one identity and
        // is what a caller cannot satisfy for a window it did not land.
        let expectedKey = abw.computeBatchKey({
            network: network, window_start: windowStart, window_end: windowEnd });
        if(batchKey !== expectedKey)
            return refuse('invalid batch_key for window ' + windowStart + '-' + windowEnd);

        return { network: network, windowStart: windowStart, windowEnd: windowEnd, actionIndex: actionIndex };
    }

};
