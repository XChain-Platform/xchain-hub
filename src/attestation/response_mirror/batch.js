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
 * AttestationResponseMirror: the batch landing
 *
 * Absorbs an ATTEST v5 batch pushed back from the DOGE rail: the batch quorum
 * re-verified against this hub's own view, rows this hub lacks written, and the
 * set-once batch link streamed. Installed on AttestationResponseMirror.prototype by
 * src/attestation/response_mirror.js.
 *
 ********************************************************************/

'use strict';

const abw = require('../../lib/attest_batch_wire.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const ValidatorIdentity = require('../../validators/identity.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ---- the batch landing (§6.3, D72 and D78) -----------------------------

    // Absorb one ATTEST v5 batch that landed on the DOGE rail and was pushed back by
    // the indexer that parsed it. THIS IS THE CHAIN-ONLY REBUILD ROAD: a node with no
    // mirror connection reaches the same rows by replaying the chain into a hub, which
    // re-serves them through the ordinary §4 path.
    //
    // WHAT IS VERIFIED HERE AND WHAT IS NOT. The BATCH quorum is re-verified once,
    // against this hub's OWN capability view at the batch's signed BTC anchor, exactly
    // as the price rail re-verifies a pushed batch: the pusher's local validation is
    // never trusted. The per-row responsible-set signatures are deliberately NOT
    // re-checked here, and that is the design rather than an omission (D72): they are
    // checked where attestation stake actually resolves, on every BTC indexer, through
    // the shared verifier, after this hub re-serves the row. A row this batch carries
    // that the BTC side later rejects is inert there, exactly as a bad gossiped row is.
    //
    // THREE EFFECTS, ALL IDEMPOTENT, so a replay and a push_generation retry are
    // no-ops: INSERT IGNORE for a row this hub does not hold (the chain-only case), a
    // set-once UPDATE of `batch_action_index`, and a re-broadcast that fires only when
    // one of those actually changed something. No reorg fence is needed on the way in:
    // nothing here deletes, and a DOGE reorg leaves a stale display link until the batch
    // re-lands, which is cosmetic by construction (the column is in no state hash and
    // the applier never reads it).
    //
    // Returns { accepted, stored, duplicates, linked, rejected, reason }.
    // A pushed batch refused, in the one shape every caller of this file answers with.
    refuseBatch(sourceChain, rowCount, reason){
        this.stats.rejected++;
        logger.warn('AttestationResponseMirror: refusing pushed batch from ' +
                     (sourceChain || 'unknown') + ': ' + reason);
        return { accepted: false, stored: 0, duplicates: 0, linked: 0, rejected: rowCount, reason: reason };
    },

    // Everything about a pushed batch that can be judged without a snapshot or a DB
    // read: the row bound, the network, the window, the anchor and the signature shape.
    // Returns { refused } or the values the quorum check and the absorb loop read.
    parseBatchPush(sourceChain, batchData, rowCount){
        let refuse = (reason) => ({ refused: this.refuseBatch(sourceChain, rowCount, reason) });

        if(!batchData || !Array.isArray(batchData.rows)) return refuse('rows must be an array');
        // DoS bound first, mirroring the wire parser's own: the count arrives from an
        // external pusher and every row below costs a keyed read and an INSERT.
        if(batchData.rows.length > abw.ATTEST_BATCH_MAX_ROWS) return refuse('too many rows');

        let network = String(batchData.network == null ? '' : batchData.network);
        if(!network || network !== String(this.hub && this.hub.network))
            return refuse('batch declares network "' + network + '", this hub serves "' +
                          String(this.hub && this.hub.network) + '"');

        // Strict, because Number(null) and Number('') are both 0 and every field below
        // is a chain-derived integer where a coerced 0 is a real value: a zero window
        // start is the epoch, and a zero action_index is a batch link pointing at the
        // first action ever indexed. Same coercion trap the row parser documents.
        let intOrNaN = (v) => ((v === null || v === undefined || v === '') ? NaN : Number(v));

        let windowStart = intOrNaN(batchData.window_start);
        let windowEnd   = intOrNaN(batchData.window_end);
        if(!Number.isInteger(windowStart) || windowStart < 0 ||
           !Number.isInteger(windowEnd) || windowEnd <= windowStart)
            return refuse('invalid window bounds');
        if(intOrNaN(batchData.row_count) !== batchData.rows.length)
            return refuse('row_count does not match the rows carried');

        let anchor = intOrNaN(batchData.btc_block_height);
        if(!Number.isInteger(anchor) || anchor <= 0) return refuse('invalid btc_block_height');

        let actionIndex = intOrNaN(batchData.action_index);
        if(!Number.isInteger(actionIndex) || actionIndex < 0) return refuse('invalid action_index');

        // Structural signature shape before any snapshot work.
        if(!Array.isArray(batchData.sigs) || batchData.sigs.length < 1) return refuse('invalid sigs');
        let sigs = [];
        for(let s of batchData.sigs){
            let pubkey = String((s && s.pubkey) || '').toLowerCase();
            let sig    = String((s && s.sig) || '').toLowerCase();
            if(!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(sig)) return refuse('invalid sigs');
            sigs.push({ pubkey: pubkey, sig: sig });
        }

        return { windowStart: windowStart, windowEnd: windowEnd, anchor: anchor,
                 actionIndex: actionIndex, sigs: sigs };
    },

    async receiveValidatedBatch(sourceChain, batchData){
        let rowCount = (batchData && Array.isArray(batchData.rows)) ? batchData.rows.length : 0;

        let parsed = this.parseBatchPush(sourceChain, batchData, rowCount);
        if(parsed.refused) return parsed.refused;

        let quorum = await this.verifyBatchQuorum(batchData, parsed.anchor, parsed.sigs);
        if(!quorum.ok) return this.refuseBatch(sourceChain, rowCount, quorum.error);

        let tally = await this.absorbBatchRows(batchData, parsed.actionIndex);
        await this.recordBatchLanding(batchData, parsed, tally);

        logger.info('AttestationResponseMirror: absorbed batch for window ' + parsed.windowStart + '-' +
                    parsed.windowEnd + ' from ' + (sourceChain || 'unknown') + ' action ' + parsed.actionIndex +
                    ' (' + tally.stored + ' new, ' + tally.duplicates + ' held, ' + tally.linked +
                    ' linked, ' + tally.skipped + ' unusable)');
        // 'db error' is the wording the sibling price-batch handler already answers the
        // same condition with, and it is deliberately outside the pusher's
        // TERMINAL_HUB_REJECTIONS set (hub_client.js), so the queued row is RETAINED and
        // re-delivered rather than dropped as a verdict on its payload.
        if(tally.writeFailures > 0)
            return { accepted: false, stored: tally.stored, duplicates: tally.duplicates,
                     linked: tally.linked, rejected: tally.skipped, reason: 'db error' };
        return { accepted: true, stored: tally.stored, duplicates: tally.duplicates,
                 linked: tally.linked, rejected: tally.skipped, reason: null };
    },

    // Write every row of a verified batch this hub does not already hold, and stamp the
    // set-once batch link on each. Returns the tally the caller answers the pusher with.
    //
    // `skipped` and `writeFailures` are deliberately NOT the same count. A row the
        // parser refused is structurally unusable and a replay carries the same bytes
        // into the same verdict, so failing the batch on one would wedge the pusher
        // forever (durable push types carry no attempt cap). A row whose WRITE threw is
        // the opposite: nothing about the payload is wrong and the next attempt may well
        // store it, so the batch must be answered as a retryable failure or the pusher
        // deletes the only copy that exists.
    async absorbBatchRows(batchData, actionIndex){
        let stored = 0, duplicates = 0, linked = 0, skipped = 0, writeFailures = 0;
        for(let raw of batchData.rows){
            // The batch's row fields ARE the gossip payload's fields, so the structural
            // parse is shared rather than written twice: a row the gossip path would not
            // store is not a row the chain path may store either.
            let row = this.parseGossipRow(raw);
            if(!row){ skipped++; continue; }

            let inserted = false;
            try {
                inserted = await this.insertAndBroadcast(row);
            } catch(err){
                this.stats.errors++;
                logger.error('AttestationResponseMirror: batch row ' + row.request_id.substring(0, 16) +
                              '... could not be written: ' + (err && err.message ? err.message : err));
                skipped++;
                writeFailures++;
                // Keep going rather than returning early: the good rows in this batch
                // still land, and every effect here is idempotent (INSERT IGNORE on the
                // natural key, set-once link), so the retry replays the whole body and
                // only the missing rows change anything.
                continue;
            }
            if(inserted) stored++;
            else         duplicates++;

            // SET ONCE. `batch_action_index IS NULL` in the predicate is what makes a
            // replay, a re-landed batch and a second batch carrying the same row all
            // no-ops: the first batch to carry a response owns its link, and a later one
            // cannot re-point it at itself.
            let didLink = await this.linkBatchAction(row, actionIndex);
            if(didLink){
                linked++;
                // Re-broadcast so the mirror consumer upserts the ONE column on the
                // natural key. insertAndBroadcast streams a row only on a fresh insert,
                // and the row this link lands on has usually been in the stream for
                // hours, so without this the link would reach no indexer.
                await this.rebroadcastRow(row);
            }
        }
        return { stored, duplicates, linked, skipped, writeFailures };
    },

    // Tell the publisher the window is covered, so no hub pays to publish a window
    // some hub has already landed. Best-effort and never fatal: the rows are what
    // matter here, and a missing marker costs at most one duplicate batch.
    //
    // WITHHELD ON A WRITE FAULT. This marker is authoritative for the whole
    // federation, so writing it after a partial absorb tells every hub the window is
    // covered when rows of it are missing, and nothing re-publishes it afterwards.
    async recordBatchLanding(batchData, parsed, tally){
        let publisher = this.hub && this.hub.attestationBatchPublisher;
        if(tally.writeFailures > 0){
            logger.warn('AttestationResponseMirror: withholding the landed marker for window ' +
                         parsed.windowStart + ': ' + tally.writeFailures + ' row(s) of this batch could not be written');
        } else if(publisher && typeof publisher.recordLandedWindow === 'function'){
            try {
                await publisher.recordLandedWindow(parsed.windowStart, parsed.windowEnd,
                    batchData.txid == null ? null : String(batchData.txid), batchData.rows.length);
            } catch(err){
                logger.warn('AttestationResponseMirror: could not record the landed batch window ' +
                             parsed.windowStart + ': ' + (err && err.message ? err.message : err));
            }
        }
    },

    // The batch quorum, against THIS hub's own capability view at the batch's signed
    // anchor. Same signer-set rule the DOGE indexer applies to the wire and the PRICE
    // batch applies to its own: stake-weighted at and above the flag day, count-keyed
    // below, and a pubkey counts only after its signature verifies.
    async verifyBatchQuorum(batchData, anchor, sigs){
        let network  = this.hub && this.hub.network;
        let weighted = swq.isStakeWeightedQuorumActive(anchor, network);
        let cs = this.hub && this.hub.capabilitySnapshot;
        let snapshot = cs
            ? (weighted ? await cs.getWeightSnapshot('attestation', anchor)
                        : await cs.getSnapshot('attestation', anchor))
            : null;
        // Fail closed: without the snapshot the signatures cannot be checked against the
        // qualified set, so the batch is refused rather than stored on trust.
        if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0)
            return { ok: false, error: 'no attestation capability snapshot at block ' + anchor };
        // A truncated weight snapshot under-counts total stake, so the 2/3 bar could
        // admit a batch the full set would refuse.
        if(weighted && snapshot.truncated === true)
            return { ok: false, error: 'attestation capability snapshot truncated at block ' + anchor };

        // Rebuilt from the pushed body, never taken from the pusher: the canonical is the
        // one thing the signatures actually cover.
        let canonical = abw.buildAttestBatchCanonical({
            network:          String(batchData.network),
            window_start:     Number(batchData.window_start),
            window_end:       Number(batchData.window_end),
            row_count:        Number(batchData.row_count),
            btc_block_height: anchor,
            rows:             batchData.rows
        });

        let qualified = new Set(snapshot.validators.map(v => String(v.pubkey).toLowerCase()));
        let seen = new Set(), verified = [];
        for(let s of sigs){
            if(seen.has(s.pubkey)) continue;
            if(!qualified.has(s.pubkey)) continue;
            // Marked seen only AFTER the signature verifies, so a garbage signature
            // carrying a qualified validator's pubkey cannot be ordered ahead of the real
            // one to consume its slot.
            if(!ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) continue;
            seen.add(s.pubkey);
            verified.push(s.pubkey);
        }

        if(weighted){
            if(!swq.meetsStakeThreshold(snapshot.validators, verified))
                return { ok: false, error: 'insufficient signer stake (' + verified.length + ' verified signers)' };
        } else {
            let setSize = Number.isFinite(parseInt(snapshot.count)) ? parseInt(snapshot.count)
                                                                   : snapshot.validators.length;
            let need = bftQuorumOrSingle(setSize, 1);
            if(verified.length < need)
                return { ok: false, error: 'insufficient batch quorum (' + verified.length + '/' + need + ')' };
        }
        return { ok: true, error: null };
    },

    // Set the batch link on one row, once. Returns true iff this call set it.
    async linkBatchAction(row, actionIndex){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return false;
        let res = await db.updateAttestationResponseByNetworkAndRequestId(actionIndex, row.network, row.request_id, row.effective_time);
        return !!(res && Number(res.affectedRows) > 0);
    },

    // Stream a row that already existed. Selected back rather than broadcast from the
    // object in hand for the reason insertAndBroadcast records: the consumer's cursor is
    // the AUTO_INCREMENT id, and only the table carries it.
    async rebroadcastRow(row){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        let rows = await db.getAttestationResponseMirrorRow(row.network, row.request_id, row.effective_time);
        let stored = (rows && rows.length) ? rows[0] : null;
        if(!stored) return;
        let b = this.broadcaster();
        if(b && typeof b.broadcastRow === 'function')
            b.broadcastRow({ table: 'attestation_responses', row: stored });
    }

};
